import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { OAUTH_DUMMY_KEY } from "../../auth"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

const AGY = process.platform === "win32" ? "agy.exe" : "agy"
const AGY_DOCS = "https://antigravity.google/docs/cli/install"
const AUTH_MARKER = "antigravity-cli"
const sessions = new Map<string, AgySession>()

function commandExists(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(AGY, ["--help"], { stdio: "ignore", windowsHide: true })
    child.once("error", () => resolve(false))
    child.once("exit", (code) => resolve(code === 0))
  })
}

function runAgyInteractive(cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(AGY, [], { cwd, stdio: "inherit", windowsHide: true })
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
}

function textFromPart(part: any): string {
  if (!part || typeof part !== "object") return ""
  if (typeof part.text === "string") return part.text
  if (typeof part.content === "string") return part.content
  return ""
}

function latestUserPrompt(body: any): string {
  const contents = Array.isArray(body?.contents) ? body.contents : []
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i]
    if (content?.role !== "user") continue
    const text = Array.isArray(content?.parts) ? content.parts.map(textFromPart).filter(Boolean).join("\n") : ""
    if (text) return text
  }
  return "Continue the task in the current workspace."
}

function systemPrompt(body: any): string {
  const system = body?.systemInstruction?.parts?.map(textFromPart).filter(Boolean).join("\n")
  return system || ""
}

function extractModel(url: URL): string | undefined {
  const match = url.pathname.match(/\/models\/([^:]+)/)
  return match?.[1]
}

function googleResponse(text: string) {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP",
      },
    ],
  }
}

function sseChunk(text: string): string {
  return `data: ${JSON.stringify(googleResponse(text))}\n\n`
}

type PendingTurn = {
  prompt: string
  model?: string
  onDelta?: (text: string) => void
  resolve: (text: string) => void
  reject: (error: Error) => void
}

class AgySession {
  private child?: ChildProcessWithoutNullStreams
  private buffer = ""
  private queue: PendingTurn[] = []
  private active?: PendingTurn
  private activeText = ""
  private authenticated = false
  private firstSystem = ""

  constructor(private readonly cwd: string) {}

  private start() {
    if (this.child) return

    const child = spawn(AGY, ["--input-format", "stream-json", "--output-format", "stream-json"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.child = child

    child.stdout.on("data", (chunk) => this.onStdout(String(chunk)))
    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim()
      if (message) this.lastStderr = message
    })
    child.once("error", (error) => this.fail(new Error(`Antigravity CLI failed to start: ${error.message}`)))
    child.once("exit", (code) => {
      this.child = undefined
      if (this.active) this.fail(new Error(this.lastStderr || `Antigravity CLI exited with code ${code ?? 1}`))
      else if (this.queue.length) this.fail(new Error(this.lastStderr || "Antigravity CLI exited unexpectedly"))
    })
  }

  private lastStderr = ""

  private onStdout(chunk: string) {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf("\n")
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue

      let event: any
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }

      if (event.event === "init") {
        this.authenticated = true
        continue
      }

      if (event.event === "step_update") {
        const update = event.step_update
        const delta = typeof update?.text_delta === "string" ? update.text_delta : ""
        if (delta) {
          this.activeText += delta
          this.active?.onDelta?.(delta)
        }
        continue
      }

      if (event.event === "result") {
        const result = event.result ?? {}
        const active = this.active
        this.active = undefined
        this.activeText = ""
        if (!active) continue

        if (result.status !== "SUCCESS") {
          active.reject(new Error(result.error || "Antigravity agent request failed"))
        } else {
          const response = typeof result.response === "string" ? result.response : ""
          active.resolve(response)
        }
        this.startNext()
      }
    }
  }

  private fail(error: Error) {
    const active = this.active
    this.active = undefined
    this.activeText = ""
    active?.reject(error)
    for (const item of this.queue.splice(0)) item.reject(error)
    this.child = undefined
  }

  private startNext() {
    if (this.active || this.queue.length === 0) return
    this.start()
    const next = this.queue.shift()!
    this.active = next
    this.activeText = ""
    const message = {
      event: "user",
      message: { content: next.prompt },
    }
    try {
      this.child!.stdin.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      this.active = undefined
      next.reject(error instanceof Error ? error : new Error(String(error)))
      this.startNext()
    }
  }

  async send(prompt: string, model?: string, onDelta?: (text: string) => void): Promise<string> {
    this.start()
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, model, onDelta, resolve, reject })
      this.startNext()
    })
  }

  async ensureReady() {
    this.start()
    // The official streaming protocol emits init once the process is ready.
    // Do not send a model request merely to probe authentication; the first real
    // request will return Google's authentication-required error if needed.
    for (let i = 0; i < 100 && !this.authenticated; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      if (!this.child) break
    }
  }

  close() {
    try {
      this.child?.stdin.end()
    } catch {}
    try {
      this.child?.kill()
    } catch {}
    this.child = undefined
    this.queue.splice(0).forEach((item) => item.reject(new Error("Antigravity session closed")))
    if (this.active) {
      this.active.reject(new Error("Antigravity session closed"))
      this.active = undefined
    }
  }
}

function getSession(cwd: string): AgySession {
  let session = sessions.get(cwd)
  if (!session) {
    session = new AgySession(cwd)
    sessions.set(cwd, session)
  }
  return session
}

async function ensureAuthenticated(cwd: string) {
  if (!(await commandExists())) {
    throw new Error(`Antigravity CLI (agy) is not installed. Install it from ${AGY_DOCS}`)
  }

  // Let the official CLI own the Google browser OAuth/keyring exchange.
  // If a cached account exists, agy returns immediately; otherwise it opens
  // Google's browser sign-in flow in the user's normal terminal session.
  const code = await runAgyInteractive(cwd)
  if (code !== 0) throw new Error("Antigravity Google sign-in did not complete")
}

async function executeAgent(input: PluginInput, url: URL, init: RequestInit | undefined): Promise<Response> {
  const rawBody = typeof init?.body === "string" ? init.body : "{}"
  let body: any
  try {
    body = JSON.parse(rawBody)
  } catch {
    return new Response(JSON.stringify({ error: { message: "Antigravity bridge received invalid JSON" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })
  }

  const session = getSession(input.directory)
  const system = systemPrompt(body)
  const prompt = system && !session["firstSystem"] ? `SYSTEM:\n${system}\n\n${latestUserPrompt(body)}` : latestUserPrompt(body)
  if (system && !session["firstSystem"]) session["firstSystem"] = system

  const model = extractModel(url)
  const wantsStream = /streamGenerateContent/.test(url.pathname) || new URLSearchParams(url.search).get("alt") === "sse"

  if (!wantsStream) {
    const text = await session.send(prompt, model)
    return new Response(JSON.stringify(googleResponse(text)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  const encoder = new TextEncoder()
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
  let streamed = false
  let failure: Error | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      session
        .send(prompt, model, (delta) => {
          streamed = true
          controller.enqueue(encoder.encode(sseChunk(delta)))
        })
        .then((text) => {
          if (!streamed && text) controller.enqueue(encoder.encode(sseChunk(text)))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        })
        .catch((error) => {
          failure = error instanceof Error ? error : new Error(String(error))
          controllerRef?.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: failure.message } })}\n\n`))
          controllerRef?.close()
        })
    },
    cancel() {},
  })

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  })
}

export async function AntigravityAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "google",
      methods: [
        {
          type: "oauth",
          label: "Google / Antigravity (browser)",
          async authorize() {
            if (!(await commandExists())) {
              return {
                url: AGY_DOCS,
                instructions: `Install Antigravity CLI (agy) first: ${AGY_DOCS}`,
                method: "auto",
                callback: async () => ({ type: "failed" as const }),
              }
            }

            return {
              url: AGY_DOCS,
              instructions:
                "Open Antigravity CLI once in this terminal. It will use Google's official browser sign-in and secure OS keyring. After sign-in, return to OpenCode.",
              method: "auto",
              callback: async () => {
                try {
                  await ensureAuthenticated(input.directory)
                  await getSession(input.directory).ensureReady()
                  return { type: "success" as const, provider: "google", key: AUTH_MARKER }
                } catch {
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "api" || auth.key !== AUTH_MARKER) return {}

        return {
          apiKey: OAUTH_DUMMY_KEY,
          fetch: async (requestInput: RequestInfo | URL, init?: RequestInit) => {
            const url = requestInput instanceof URL
              ? requestInput
              : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)

            if (!url.hostname.includes("generativelanguage.googleapis.com")) {
              return fetch(requestInput, init)
            }

            try {
              return await executeAgent(input, url, init)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              return new Response(JSON.stringify({ error: { message } }), {
                status: 502,
                headers: { "content-type": "application/json" },
              })
            }
          },
        }
      },
    },
  }
}
