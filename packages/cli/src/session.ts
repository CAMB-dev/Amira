import { type Ai, createAi, type ModelInfo } from "@amira/ai"
import type { AnyEvent, Extension } from "@amira/api"
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
import { type CatalogCacheOptions, readCatalogCache, refreshCatalog } from "./catalog.ts"

export interface SessionOptions {
  model: string
  cwd: string
  extensions: string[]
  noBuiltins: boolean
  ai?: Ai
  /** Where the model catalog is cached and fetched from; false leaves it out. Unused with `ai`. */
  catalog?: CatalogCacheOptions | false
  /** Receives failures of event subscribers (extensions or frontends). The core itself never prints. */
  onSubscriberError?: (error: unknown, event: AnyEvent) => void
  /** Loads the bundled extensions; injectable for tests. */
  builtins?: () => Promise<{ source: string; extension: Extension }[]>
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
  const catalogOpts = opts.ai || opts.catalog === false ? undefined : (opts.catalog ?? {})
  const cached = catalogOpts ? await readCatalogCache(catalogOpts) : undefined
  const ai = opts.ai ?? createAi(cached?.catalog ? { catalog: cached.catalog } : {})
  let model: ModelInfo
  try {
    model = ai.model(opts.model)
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err))
  }
  const bus = new EventBus(opts.onSubscriberError)
  const interceptors = new InterceptorRegistry({
    onError: (point, source, error) =>
      bus.emit("extension.error", { source, error: `${point}: ${error}` }, { sessionId: "host" }),
  })
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors, tools })
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
