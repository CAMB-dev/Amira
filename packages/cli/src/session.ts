import { type Ai, createAi, type ModelInfo, type ProviderConfig, type RetryOptions } from "@amira/ai"
import type { AnyEvent, Extension, Settings } from "@amira/api"
import {
  Agent,
  type CompactionOptions,
  defaultSections,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  instructionsSection,
  loadInstructions,
  type SessionStore,
  ToolRegistry,
  toolSearchExtension,
} from "@amira/core"
import { UsageError } from "./args.ts"
import { type CatalogCacheOptions, readCatalogCache, refreshCatalog } from "./catalog.ts"
import { withPresetHint } from "./provider-command.ts"

export interface SessionOptions {
  model: string
  cwd: string
  extensions: string[]
  noBuiltins: boolean
  /** Tools hidden from the model. */
  disabledTools?: string[]
  ai?: Ai
  /** Where the conversation is persisted; a stored one is resumed. Omit to keep nothing. */
  store?: SessionStore
  /** Compaction options; unset, they come from settings `compact`. */
  compaction?: CompactionOptions
  /** Where the model catalog is cached and fetched from; false leaves it out. Unused with `ai`. */
  catalog?: CatalogCacheOptions | false
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
  /** Settings warnings, reported as extension.error events from "settings" among the startup events. */
  warnings?: string[]
}

export interface Session {
  agent: Agent
  host: ExtensionHost
  /** Extension events emitted while loading, before any frontend subscribed. */
  startupEvents: AnyEvent[]
  /** Settles when a background catalog refresh is done (at once when none was due). */
  catalogRefresh: Promise<void>
}

/** Extensions bundled with Amira and loaded by default (D50). */
async function defaultBuiltins(): Promise<{ source: string; extension: Extension }[]> {
  const bundled: [string, () => Promise<{ default?: unknown }>][] = [
    ["builtin:tools", () => import("@amira/builtin-tools")],
    ["builtin:status", () => import("@amira/ext-status")],
    ["builtin:tool-search", async () => ({ default: toolSearchExtension })],
    ["builtin:skills", () => import("@amira/ext-skills")],
    ["builtin:mcp", () => import("@amira/ext-mcp")],
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
  const settings = opts.settings ?? {}
  const catalogOpts = opts.ai || opts.catalog === false ? undefined : (opts.catalog ?? {})
  const cached = catalogOpts ? await readCatalogCache(catalogOpts) : undefined
  const retry = retryFromSettings(settings.retry)
  const ai =
    opts.ai ??
    createAi({
      providers: opts.providers ?? [],
      apiKeys: opts.apiKeys ?? {},
      ...(cached?.catalog ? { catalog: cached.catalog } : {}),
      ...(retry ? { retry } : {}),
    })
  const model = resolveModel(ai, opts.model)
  const compaction = opts.compaction ?? compactionFromSettings(ai, settings.compact)
  const bus = new EventBus(opts.onSubscriberError)
  const interceptors = new InterceptorRegistry({
    onError: (point, source, error) =>
      bus.emit("extension.error", { source, error: `${point}: ${error}` }, { sessionId: "host" }),
  })
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors, tools, settings, cwd: opts.cwd })
  const startupEvents: AnyEvent[] = []
  const stopCapture = bus.subscribe((e) => void startupEvents.push(e), {
    types: ["extension.error", "extension.loaded"],
  })
  for (const error of opts.warnings ?? []) {
    bus.emit("extension.error", { source: "settings", error }, { sessionId: "host" })
  }

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
    sections: defaultSections({ cwd: opts.cwd, project: instructionsSection(loadInstructions(opts.cwd)) }),
    bus,
    interceptors,
    tools,
    ...(opts.store ? { session: opts.store } : {}),
    ...(compaction ? { compaction } : {}),
    ...(settings.maxParallelTools ? { maxParallelTools: settings.maxParallelTools } : {}),
  })
  // A stale or missing catalog is refreshed in the background; startup never waits for it.
  const catalogRefresh =
    catalogOpts && cached?.stale
      ? refreshCatalog(catalogOpts)
          .then((catalog) => {
            if (!catalog) return
            ai.setCatalog?.(catalog)
            // Only replace the model this session started with, not one chosen since.
            if (agent.model === model) agent.model = ai.model(opts.model)
          })
          .catch(() => {})
      : Promise.resolve()
  return { agent, host, startupEvents, catalogRefresh }
}

/** Settings `retry` as ai retry options (D52); `attempts` counts the retries after the first try. */
export function retryFromSettings(retry: Settings["retry"]): RetryOptions | undefined {
  if (!retry) return undefined
  const out: RetryOptions = {}
  if (retry.attempts !== undefined) out.retries = retry.attempts
  if (retry.baseDelayMs !== undefined) out.baseDelayMs = retry.baseDelayMs
  if (retry.maxDelayMs !== undefined) out.maxDelayMs = retry.maxDelayMs
  return Object.keys(out).length ? out : undefined
}

function resolveModel(ai: Ai, ref: string): ModelInfo {
  try {
    return ai.model(ref)
  } catch (err) {
    throw new UsageError(withPresetHint(ref, err instanceof Error ? err.message : String(err)))
  }
}

/** Settings `compact` as agent options; its model is resolved like --model. */
function compactionFromSettings(ai: Ai, compact: Settings["compact"]): CompactionOptions | undefined {
  if (!compact) return undefined
  const out: CompactionOptions = {}
  if (compact.threshold !== undefined) out.threshold = compact.threshold
  if (compact.model) out.model = resolveModel(ai, compact.model)
  return Object.keys(out).length ? out : undefined
}

/** The tools to hide for a shell mode and an explicit list (D68, D70). */
export function toolsToDisable(shell: "auto" | "bash" | "powershell", explicit: string[]): string[] {
  const out = new Set(explicit)
  if (shell === "bash") out.add("powershell")
  if (shell === "powershell") out.add("bash")
  return [...out]
}
