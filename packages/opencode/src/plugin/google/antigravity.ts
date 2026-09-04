import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { OAUTH_DUMMY_KEY } from "../../auth"
import { spawn } from "node:child_process"

const AGY = process.platform === "win32" ? "agy.exe" : "agy"
const AGY_DOCS = "https://antigravity.google/docs/cli/install"
const AUTH_MARKER = "antigravity-cli"

function commandExists(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(AGY, ["--help"], { stdio: "ignore", windowsHide: true })
    child.once("error", () => resolve(false))
    child.once("exit", (code) => resolve(code === 0))
  })
}

function runAgy(args: string[], cwd: string, inherit = false): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(AGY, args, {
      cwd,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })

    if (inherit) {
      child.once("error", reject)
      child.once("exit", (code) => resolve({ code: code ?? 1, stdout: "", stderr: "" }))
      return
    }

    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)))
    child.once("error", reject)
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function isAuthenticated(cwd: string) {
  if (!(await commandExists())) return false
  try {
    const result = await runAgy(["-p", "Reply with exactly: OK", "--output-format", "json", "--print-timeout", "30s"], cwd)
    if (result.code !== 0) return false
    try {
      const parsed = JSON.parse(result.stdout) as { status?: string }
      return parsed.status === "SUCCESS"
    } catch {
      return false
    }
  } catch {
    return false
  }
}

async function ensureAuthenticated(cwd: string) {
  if (!(await commandExists())) {
    throw new Error("Antigravity CLI (agy) is not installed. Install it from https://antigravity.google/docs/cli/install")
  }

  if (await isAuthenticated(cwd)) return

  // Google documents browser-based sign-in as part of the normal local `agy` flow.
  // Run the official CLI interactively so Google owns the OAuth/keyring exchange.
  const result = await runAgy([], cwd, true)
  if (result.code !== 0 || !(await isAuthenticated(cwd))) {
    throw new Error("Antigravity sign-in did not complete. Run `agy` once, finish Google Sign-In, then retry.")
  }
}

function textFromPart(part: any): string {
  if (!part || typeof part !== "object") return ""
  if (typeof part.text === "string") return part.text
  if (typeof part.content === "string") return part.content
  return ""
}

function contentsToPrompt(body: any): string {
  const sections: string[] = []

  const system = body?.systemInstruction?.parts?.map(textFromPart).filter(Boolean).join("\n")
  if (system) sections.push(`SYSTEM:\n${system}`)

  for (const content of Array.isArray(body?.contents) ? body.contents : []) {
    const role = content?.role === "model" ? "ASSISTANT" : "USER"
    const text = Array.isArray(content?.parts) ? content.parts.map(textFromPart).filter(Boolean).join("\n") : ""
    if (text) sections.push(`${role}:\n${text}`)
  }

  return sections.join("\n\n") || "USER:\nContinue the task in the current workspace."
}

function extractModel(url: URL): string | undefined {
  const match = url.pathname.match(/\/models\/([^:]+)/)
  return match?.[1]
}

function googleResponse(text: string) {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text }],
        },
        finishReason: "STOP",
      },
    ],
  }
}

function sseResponse(text: string) {
  const payload = JSON.stringify(googleResponse(text))
  const body = `data: ${payload}\n\n`
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  })
}

async function executeAgent(input: PluginInput, url: URL, init?: RequestInit): Promise<Response> {
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

  await ensureAuthenticated(input.directory)

  const prompt = contentsToPrompt(body)
  const model = extractModel(url)
  const args = ["-p", prompt, "--output-format", "json", "--print-timeout", "10m"]
  if (model) args.push("--model", model)

  const result = await runAgy(args, input.directory)
  let parsed: any
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    parsed = undefined
  }

  if (result.code !== 0 || parsed?.status !== "SUCCESS") {
    const message = parsed?.error || result.stderr.trim() || `agy exited with code ${result.code}`
    return new Response(JSON.stringify({ error: { message } }), {
      status: 502,
      headers: { "content-type": "application/json" },
    })
  }

  const text = typeof parsed.response === "string" ? parsed.response : ""
  const wantsStream = /streamGenerateContent/.test(url.pathname) || new URLSearchParams(url.search).get("alt") === "sse"
  return wantsStream ? sseResponse(text) : new Response(JSON.stringify(googleResponse(text)), {
    status: 200,
    headers: { "content-type": "application/json" },
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
                instructions: "Install Antigravity CLI (`agy`) first, then retry Google / Antigravity login.",
                method: "auto",
                callback: async () => ({ type: "failed" as const }),
              }
            }

            return {
              url: AGY_DOCS,
              instructions:
                "Antigravity CLI will use Google's official browser sign-in and secure OS keyring. Finish Google Sign-In, then return to OpenCode.",
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
