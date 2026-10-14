import { randomUUID } from "node:crypto"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Settings, ToolResult } from "../../packages/api/src/index.ts"

const directory = path.dirname(fileURLToPath(import.meta.url))
export const PROVIDER_ID = "ui-walk"
export const DEFAULT_SCENARIO = path.join(directory, "scenarios", "transcript.json")

export interface ScriptedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** Omit for real UI/orchestration tools; otherwise this replaces execution entirely. */
  result?: ToolResult
}

export interface ScriptedReply {
  text?: string
  thinking?: string
  toolCalls?: ScriptedToolCall[]
  /** Repeat text to exercise scrolling without a huge fixture file. */
  repeat?: number
  /** Milliseconds between SSE chunks, including the initial role chunk. */
  delayMs?: number
  chunkSize?: number
  error?: { status: number; message: string; retryAfter?: number }
  /** A stream-body error after any text/thinking, rather than an HTTP error. */
  streamError?: { message: string; code?: string }
}

/** Each model route has its own script; child sessions also get independent cursors. */
export interface Scenario {
  name: string
  description: string
  prompt: string
  routes: Record<string, ScriptedReply[]>
  /** Optional provider-management fixture: models returned by GET /v1/models. */
  models?: Array<{ id: string; contextWindow?: number; cost?: { input: number; output: number } }>
}

export interface ProviderRequest {
  route: string
  step: number
  body: Record<string, unknown>
}

export interface ScriptedProvider {
  readonly token: string
  baseUrl: string
  model: string
  scenario: Scenario
  requests: ProviderRequest[]
  stop(): Promise<void>
}

/** No client injection: the application uses its usual HTTP provider and SSE parser. */
export async function createProvider(
  scenarioPath = DEFAULT_SCENARIO,
  token: string = randomUUID(),
): Promise<ScriptedProvider> {
  const scenario = parseScenario(JSON.parse(await readFile(scenarioPath, "utf8")))
  const cursors = new Map<string, number>()
  const requests: ProviderRequest[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return Response.json(
          { error: { message: "Unauthorized scripted-provider request" } },
          { status: 401 },
        )
      }
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({
          data: (scenario.models ?? Object.keys(scenario.routes).map((id) => ({ id }))).map((model) => ({
            id: model.id,
          })),
        })
      }
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return Response.json(
          { error: { message: "UI walk only serves GET /v1/models and POST /v1/chat/completions" } },
          { status: 404 },
        )
      }
      let body: Record<string, unknown>
      try {
        const value: unknown = await request.json()
        if (!isRecord(value) || typeof value.model !== "string" || !Array.isArray(value.messages)) {
          throw new Error("expected a model and messages array")
        }
        body = value
      } catch {
        return Response.json({ error: { message: "Invalid scripted-provider request" } }, { status: 400 })
      }
      // The fixture extension marks children through the normal context.build API. Explicit
      // child models work without it too; the marker separates concurrent uses of one model.
      const system = (body.messages as { role?: string; content?: unknown }[])
        .filter((message) => message.role === "system" && typeof message.content === "string")
        .map((message) => message.content)
        .join("\n")
      const child = /\[ui-walk-child:([^\]\r\n]+)\]/.exec(system)?.[1]
      const model = body.model as string
      const route = child && model === "main" ? "child" : model
      const replies = scenario.routes[route]
      if (!replies && route !== "child") {
        return Response.json({ error: { message: `No scripted route for model ${model}` } }, { status: 404 })
      }
      const key = `${route}:${child ?? "main"}`
      const step = cursors.get(key) ?? 0
      const reply = replies?.[step] ?? {
        text:
          route === "child"
            ? "Scripted child completed its task; no live calls were made."
            : "The scripted UI walk is complete.",
      }
      // Fail closed when launched without the fixture extension: never ask ordinary tools
      // to execute a canned command or edit. The marker is added only after hooks register.
      if (reply.toolCalls?.length && !system.includes("[ui-walk-fixtures]")) {
        return Response.json(
          { error: { message: "Load the isolated UI walk fixture extension before using scripted tools" } },
          { status: 400 },
        )
      }
      cursors.set(key, step + 1)
      requests.push({ route, step, body })
      if (reply.error) {
        return Response.json(
          { error: { message: reply.error.message, type: "scripted_error" } },
          {
            status: reply.error.status,
            ...(reply.error.retryAfter !== undefined
              ? { headers: { "retry-after": String(reply.error.retryAfter) } }
              : {}),
          },
        )
      }
      return streamReply(reply, route, step, request.signal)
    },
  })
  return {
    token,
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    model: `${PROVIDER_ID}/main`,
    scenario,
    requests,
    stop: async () => {
      await server.stop(true)
    },
  }
}

function streamReply(reply: ScriptedReply, model: string, step: number, signal: AbortSignal): Response {
  const encoder = new TextEncoder()
  const chunks: string[] = []
  const delta = (value: Record<string, unknown>, finish: string | null = null) => {
    chunks.push(
      `data: ${JSON.stringify({
        id: `ui-walk-${model}-${step}`,
        object: "chat.completion.chunk",
        created: 0,
        model,
        choices: [{ index: 0, delta: value, finish_reason: finish }],
      })}\n\n`,
    )
  }
  const split = (text: string) => {
    const chars = Array.from(text)
    const size = reply.chunkSize ?? 24
    const parts: string[] = []
    for (let i = 0; i < chars.length; i += size) parts.push(chars.slice(i, i + size).join(""))
    return parts
  }
  delta({ role: "assistant" })
  for (const text of split(reply.thinking ?? "")) delta({ reasoning_content: text })
  const text = (reply.text ?? "").repeat(reply.repeat ?? 1)
  for (const part of split(text)) delta({ content: part })
  for (const [index, tool] of (reply.toolCalls ?? []).entries()) {
    delta({
      tool_calls: [{ index, id: tool.id, type: "function", function: { name: tool.name, arguments: "" } }],
    })
    for (const args of split(JSON.stringify(tool.args))) {
      delta({ tool_calls: [{ index, function: { arguments: args } }] })
    }
  }
  if (reply.streamError) {
    chunks.push(`data: ${JSON.stringify({ error: reply.streamError })}\n\n`)
  } else {
    delta({}, reply.toolCalls?.length ? "tool_calls" : "stop")
    chunks.push(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 512, completion_tokens: Math.max(1, Math.ceil(text.length / 4)) } })}\n\n`,
      "data: [DONE]\n\n",
    )
  }
  let index = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (reply.delayMs) await Bun.sleep(reply.delayMs)
      if (cancelled) return
      if (signal.aborted || index === chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[index++]!))
    },
    cancel() {
      cancelled = true
    },
  })
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

export interface FixtureSetup {
  /** Pass this environment to the child, never merge the real environment back over it. */
  env: Record<string, string>
  /** Append to the ordinary CLI invocation; built-ins stay enabled. */
  args: string[]
  settingsPath: string
  extensionPath: string
}

/**
 * home is AMIRA_HOME, not HOME. Both paths must be temporary; existing fixture files in cwd
 * are fine, but existing settings/auth are not. This only writes into the supplied home.
 * The caller owns cleanup, the PTY/CLI child, and stopping the provider after child exit.
 */
export async function setupFixtures(
  home: string,
  cwd: string,
  provider: ScriptedProvider,
  theme = "dark",
): Promise<FixtureSetup> {
  home = path.resolve(home)
  cwd = path.resolve(cwd)
  await requireTemporary(home)
  await requireTemporary(cwd)
  for (const file of [
    path.join(home, "settings.json"),
    path.join(home, "auth.json"),
    path.join(cwd, ".amira", "settings.json"),
    path.join(cwd, ".amira", "settings.local.json"),
  ]) {
    try {
      await readFile(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    throw new Error(`UI walk refuses an existing configuration: ${file}`)
  }
  const url = new URL(provider.baseUrl)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/v1") {
    throw new Error("UI walk requires its loopback HTTP provider")
  }
  const extensionPath = path.join(home, "extensions", "ui-walk.ts")
  await mkdir(path.dirname(extensionPath), { recursive: true })
  await mkdir(path.join(home, "cache"), { recursive: true })
  await mkdir(path.join(home, "user"), { recursive: true })
  await mkdir(path.join(home, "config"), { recursive: true })
  await mkdir(cwd, { recursive: true })
  // Outside the checkout, the host's virtual public API resolves the extension's import.
  const extension = await readFile(path.join(directory, "fixture-extension.ts"), "utf8")
  await writeFile(extensionPath, extension.replace("../../packages/api/src/index.ts", "@amira/api"))
  const results: Record<string, { name: string; args: Record<string, unknown>; result: ToolResult }> = {}
  for (const replies of Object.values(provider.scenario.routes)) {
    for (const reply of replies) {
      for (const call of reply.toolCalls ?? []) {
        if (call.result) results[call.id] = { name: call.name, args: call.args, result: call.result }
      }
    }
  }
  const settings: Settings = {
    model: provider.model,
    providers: {
      [PROVIDER_ID]: {
        dialect: "openai-chat",
        baseUrl: provider.baseUrl,
        headers: { Authorization: `Bearer ${provider.token}` },
        catalogId: false,
        compat: { webSearch: false },
        tools: { edit: "both" },
        models: Object.keys(provider.scenario.routes).map((id) => ({ id })),
        defaultModel: {
          contextWindow: 200_000,
          maxOutput: 32_768,
          caps: { tools: "native", thinking: true, images: false, webSearch: false },
        },
      },
    },
    sessions: { autoTitle: false },
    fileRewind: { enabled: false },
    shell: "bash",
    tools: { disabled: ["web_fetch", "web_search"] },
    permissions: { mode: "auto" },
    retry: { attempts: 2, baseDelayMs: 200, maxDelayMs: 2000 },
    subagents: { background: false, maxConcurrent: 4 },
    extensions: { "ui-walk": { results } },
    tui: { theme, bell: false, notify: "off", images: "off" },
  }
  const settingsPath = path.join(home, "settings.json")
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
  // catalogId:false alone does NOT stop the CLI's global catalog refresh. A fresh cache does.
  const catalog = provider.scenario.models
    ? {
        "ui-walk-demo": {
          id: "ui-walk-demo",
          name: "UI walk demo",
          npm: "@ai-sdk/openai-compatible",
          api: provider.baseUrl,
          env: [],
          models: Object.fromEntries(
            provider.scenario.models
              .filter((model) => model.cost)
              .map((model) => [model.id, { limit: { context: model.contextWindow }, cost: model.cost }]),
          ),
        },
      }
    : {}
  await writeFile(
    path.join(home, "cache", "models.json"),
    `${JSON.stringify({ fetchedAt: Date.now(), source: "ui-walk-offline", data: catalog })}\n`,
  )
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || /^AMIRA_|API_KEY|TOKEN|SECRET|PROXY/i.test(name)) continue
    env[name] = value
  }
  Object.assign(env, {
    AMIRA_HOME: home,
    HOME: path.join(home, "user"),
    USERPROFILE: path.join(home, "user"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    NO_PROXY: "127.0.0.1,localhost",
  })
  if (process.platform === "win32") {
    const drive = path.parse(env.HOME!).root.replace(/[\\/]$/, "")
    env.HOMEDRIVE = drive
    env.HOMEPATH = env.HOME!.slice(drive.length)
  }
  return {
    env,
    args: ["--no-packages", "--extension", extensionPath, "--cwd", cwd],
    settingsPath,
    extensionPath,
  }
}

/** Resolve symlinks in existing parents before deciding a new path is temporary. */
async function requireTemporary(target: string): Promise<void> {
  const temporary = await realpath(os.tmpdir())
  let existing = target
  const suffix: string[] = []
  let canonical: string
  for (;;) {
    try {
      canonical = path.join(await realpath(existing), ...suffix)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const parent = path.dirname(existing)
      if (parent === existing) throw error
      suffix.unshift(path.basename(existing))
      existing = parent
    }
  }
  const relative = path.relative(temporary, canonical)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`UI walk requires a directory inside the system temporary directory: ${target}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseScenario(value: unknown): Scenario {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    typeof value.prompt !== "string" ||
    !isRecord(value.routes) ||
    !Array.isArray(value.routes.main) ||
    value.routes.main.length === 0
  ) {
    throw new Error("Invalid UI walk scenario: expected name, description, prompt and routes.main")
  }
  if (value.models !== undefined) {
    if (
      !Array.isArray(value.models) ||
      value.models.some(
        (model) =>
          !isRecord(model) ||
          typeof model.id !== "string" ||
          !model.id.trim() ||
          (model.contextWindow !== undefined &&
            (!Number.isFinite(model.contextWindow) || Number(model.contextWindow) <= 0)) ||
          (model.cost !== undefined &&
            (!isRecord(model.cost) ||
              !Number.isFinite(model.cost.input) ||
              Number(model.cost.input) < 0 ||
              !Number.isFinite(model.cost.output) ||
              Number(model.cost.output) < 0)),
      )
    )
      throw new Error("Invalid UI walk models")
  }
  const ids = new Set<string>()
  for (const [route, replies] of Object.entries(value.routes)) {
    if (!/^[a-z][a-z0-9-]*$/.test(route) || !Array.isArray(replies)) {
      throw new Error(`Invalid UI walk scenario route: ${route}`)
    }
    for (const reply of replies) {
      if (!isRecord(reply)) throw new Error(`Invalid UI walk reply in ${route}`)
      for (const key of ["text", "thinking"] as const) {
        if (reply[key] !== undefined && typeof reply[key] !== "string") {
          throw new Error(`Invalid ${key} in ${route}`)
        }
      }
      for (const [key, minimum, maximum] of [
        ["chunkSize", 1, 4096],
        ["delayMs", 0, 5000],
        ["repeat", 1, 200],
      ] as const) {
        if (
          reply[key] !== undefined &&
          (!Number.isInteger(reply[key]) || Number(reply[key]) < minimum || Number(reply[key]) > maximum)
        ) {
          throw new Error(`Invalid ${key} in ${route}`)
        }
      }
      if (
        reply.error !== undefined &&
        (!isRecord(reply.error) ||
          !Number.isInteger(reply.error.status) ||
          Number(reply.error.status) < 400 ||
          Number(reply.error.status) > 599 ||
          typeof reply.error.message !== "string")
      ) {
        throw new Error(`Invalid HTTP error in ${route}`)
      }
      if (
        reply.streamError !== undefined &&
        (!isRecord(reply.streamError) || typeof reply.streamError.message !== "string")
      ) {
        throw new Error(`Invalid stream error in ${route}`)
      }
      if (reply.toolCalls !== undefined) {
        if (!Array.isArray(reply.toolCalls)) throw new Error(`Invalid tool calls in ${route}`)
        for (const call of reply.toolCalls) {
          if (
            !isRecord(call) ||
            typeof call.id !== "string" ||
            !call.id ||
            ids.has(call.id) ||
            typeof call.name !== "string" ||
            !isRecord(call.args)
          ) {
            throw new Error(`Invalid or duplicate tool call in ${route}`)
          }
          ids.add(call.id)
          if (call.result !== undefined && (!isRecord(call.result) || !Array.isArray(call.result.content))) {
            throw new Error(`Invalid fixture result for ${call.id}`)
          }
        }
      }
    }
  }
  return value as unknown as Scenario
}
