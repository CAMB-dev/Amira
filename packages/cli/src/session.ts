import { type Ai, createAi, type ModelInfo, type ProviderConfig } from "@amira/ai"
import type { AnyEvent, Extension, Settings } from "@amira/api"
import {
  Agent,
  defaultSections,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  renderPrompt,
  ToolRegistry,
} from "@amira/core"
import { UsageError } from "./args.ts"
import { withPresetHint } from "./provider-command.ts"

export interface SessionOptions {
  model: string
  cwd: string
  extensions: string[]
  noBuiltins: boolean
  /** Tools hidden from the model. */
  disabledTools?: string[]
  ai?: Ai
  /** Receives failures of event subscribers (extensions or frontends). The core itself never prints. */
  onSubscriberError?: (error: unknown, event: AnyEvent) => void
  /** Loads the bundled extensions; injectable for tests. */
  builtins?: () => Promise<{ source: string; extension: Extension }[]>
  /** Merged settings (D35): handed to extensions; agent options come from them too. */
  settings?: Settings
  /** Providers from settings, merged over the built-ins. Unused when `ai` is given. */
  providers?: ProviderConfig[]
  /** Stored API keys by provider id (auth.json). Unused when `ai` is given. */
  apiKeys?: Record<string, string>
}

export interface Session {
  agent: Agent
  host: ExtensionHost
  /** Extension events emitted while loading, before any frontend subscribed. */
  startupEvents: AnyEvent[]
  /**
   * Retry hook: settings retry.attempts, for the retry support that is still to come. Pass it
   * to the Agent once it takes a retry option.
   */
  retryAttempts?: number
}

/** Extensions bundled with Amira and loaded by default (D50). */
async function defaultBuiltins(): Promise<{ source: string; extension: Extension }[]> {
  const bundled: [string, () => Promise<{ default?: unknown }>][] = [
    ["builtin:tools", () => import("@amira/builtin-tools")],
    ["builtin:status", () => import("@amira/ext-status")],
  ]
  const out: { source: string; extension: Extension }[] = []
  for (const [source, load] of bundled) {
    const mod = await load()
    if (typeof mod.default !== "function") throw new Error(`${source} has no default export`)
    out.push({ source, extension: mod.default as Extension })
  }
  return out
}

/**
 * Wires the ai layer, core registries, extensions and the agent together.
 * Extension failures are reported as extension.error events on the agent's bus.
 */
export async function createSession(opts: SessionOptions): Promise<Session> {
  const ai = opts.ai ?? createAi({ providers: opts.providers ?? [], apiKeys: opts.apiKeys ?? {} })
  const settings = opts.settings ?? {}
  let model: ModelInfo
  try {
    model = ai.model(opts.model)
  } catch (err) {
    throw new UsageError(withPresetHint(opts.model, err instanceof Error ? err.message : String(err)))
  }
  const bus = new EventBus(opts.onSubscriberError)
  const interceptors = new InterceptorRegistry({
    onError: (point, source, error) =>
      bus.emit("extension.error", { source, error: `${point}: ${error}` }, { sessionId: "host" }),
  })
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors, tools, settings })
  const startupEvents: AnyEvent[] = []
  const stopCapture = bus.subscribe((e) => void startupEvents.push(e), {
    types: ["extension.error", "extension.loaded"],
  })

  if (!opts.noBuiltins) {
    try {
      for (const b of await (opts.builtins ?? defaultBuiltins)()) await host.load(b.extension, b.source)
    } catch (err) {
      const error = `failed to load built-in extensions: ${err instanceof Error ? err.message : String(err)}`
      bus.emit("extension.error", { source: "builtin", error }, { sessionId: "host" })
    }
  }
  for (const file of opts.extensions) await host.loadFile(file)
  tools.setDisabled(opts.disabledTools ?? [])
  await bus.flush()
  stopCapture()

  const agent = new Agent({
    ai,
    model,
    cwd: opts.cwd,
    systemPrompt: renderPrompt(defaultSections({ cwd: opts.cwd })),
    bus,
    interceptors,
    tools,
    ...(settings.maxParallelTools ? { maxParallelTools: settings.maxParallelTools } : {}),
  })
  const retryAttempts = settings.retry?.attempts
  return { agent, host, startupEvents, ...(retryAttempts !== undefined ? { retryAttempts } : {}) }
}

/** The tools to hide for a shell mode and an explicit list (D68, D70). */
export function toolsToDisable(shell: "auto" | "bash" | "powershell", explicit: string[]): string[] {
  const out = new Set(explicit)
  if (shell === "bash") out.add("powershell")
  if (shell === "powershell") out.add("bash")
  return [...out]
}
