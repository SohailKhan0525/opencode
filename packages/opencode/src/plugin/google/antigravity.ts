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
  return body?.systemInstruction?.parts?.map(textFromPart).filter(Boolean).join("\n") || ""
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
  private lastStderr = ""
  private _firstSystem = ""

  constructor(private readonly cwd: string, private readonly model?: string) {}

  get firstSystem(): string {
    return this._firstSystem
  }

  set firstSystem(value: string) {
    this._firstSystem = value
  }

  private start() {
    if (this.child) return

    const args = ["--input-format", "stream-json", "--output-format", "stream-json"]
    if (this.model) args.push("--model", this.model)

    const child = spawn(AGY, args, {
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
      this.authenticated = false
      if (this.active) this.fail(new Error(this.lastStderr || `Antigravity CLI exited with code ${code ?? 1}`))
      else if (this.queue.length) this.fail(new Error(this.lastStderr || "Antigravity CLI exited unexpectedly"))
    })
  }

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
          active.resolve(typeof result.response === "string" ? result.response : "")
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
    try {
      this.child!.stdin.write(`${JSON.stringify({ event: "user", message: { content: next.prompt } })}\n`)
    } catch (error) {
      this.active = undefined
      next.reject(error instanceof Error ? error : new Error(String(error)))
      this.startNext()
    }
  }

  async send(prompt: string, onDelta?: (text: string) => void): Promise<string> {
    this.start()
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, onDelta, resolve, reject })
      this.startNext()
    })
  }

  async ensureStarted() {
    this.start()
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

function getSession(cwd: string, model?: string): AgySession {
  const key = `${cwd}\0${model ?? "default"}`
  let session = sessions.get(key)
  if (!session) {
    session = new AgySession(cwd, model)
    sessions.set(key, session)
  }
  return session
}

async function ensureAuthenticated(cwd: string) {
  if (!(await commandExists())) {
    throw new Error(`Antigravity CLI (agy) is not installed. Install it from ${AGY_DOCS}`)
  }

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

  const model = extractModel(url)
  const session = getSession(input.directory, model)
  const system = systemPrompt(body)
  const isFirstTurn = !session.firstSystem
  if (system && isFirstTurn) session.firstSystem = system
  const prompt = system && isFirstTurn ? `SYSTEM:\n${system}\n\n${latestUserPrompt(body)}` : latestUserPrompt(body)

  const wantsStream = /streamGenerateContent/.test(url.pathname) || new URLSearchParams(url.search).get("alt") === "sse"

  if (!wantsStream) {
    const text = await session.send(prompt)
    return new Response(JSON.stringify(googleResponse(text)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let streamed = false
      session
        .send(prompt, (delta) => {
          streamed = true
          controller.enqueue(encoder.encode(sseChunk(delta)))
        })
        .then((text) => {
          if (!streamed && text) controller.enqueue(encoder.encode(sseChunk(text)))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message } })}\n\n`))
          controller.close()
        })
    },
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
                "Antigravity uses Google's official browser sign-in and secure OS keyring. Run agy once in this terminal, finish Google Sign-In, then return to OpenCode.",
              method: "auto",
              callback: async () => {
                try {
                  await ensureAuthenticated(input.directory)
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
