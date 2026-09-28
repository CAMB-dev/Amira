import { type Ai, createAi, type ModelInfo, type ProviderConfig, type RetryOptions } from "@amira/ai"
import type { AnyEvent, Extension, Settings } from "@amira/api"
import {
  type ActivePackages,
  Agent,
  AgentTree,
  type Approver,
  type CompactionOptions,
  commandAliasWarnings,
  defaultSections,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  instructionsSection,
  loadInstructions,
  type SessionStore,
  ToolRegistry,
  toolSearchExtension,
  type UiRequests,
} from "@amira/core"
import { UsageError } from "./args.ts"
import { type CatalogCacheOptions, readCatalogCache, refreshCatalog } from "./catalog.ts"
import { withPresetHint } from "./provider-command.ts"
import { testAiOptions } from "./test-hooks.ts"

export interface SessionOptions {
  model: string
  cwd: string
  extensions: string[]
  /** Installed packages (D24, D60): loaded after the built-ins and before `extensions`. */
  packages?: ActivePackages
  noBuiltins: boolean
  /** Tools hidden from the model. */
  disabledTools?: string[]
  /** Names the user asked to disable and where they came from; ones no tool has are reported. */
  requestedDisabled?: { names: string[]; from: string }
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
  /**
   * Settings warnings, reported as extension.error events from "settings" among the startup
   * events. When given, command aliases the loaded commands shadow are reported too.
   */
  warnings?: string[]
}

export interface Session {
  agent: Agent
  host: ExtensionHost
  /** Extension events emitted while loading, before any frontend subscribed. */
  startupEvents: AnyEvent[]
  /** Settles when a background catalog refresh is done (at once when none was due). */
  catalogRefresh: Promise<void>
  ai: Ai
  /** Sub-agents and the budget they share with the top-level agent. */
  tree: AgentTree
  /**
   * A new agent on this session's bus, registries and settings, for another stored session
   * (rpc session.resume). It starts with `model`, by default the current model.
   */
  resume(store: SessionStore, model?: ModelInfo): Agent
  /** Unloads every extension and loads the same ones again (/reload); failures arrive as extension.error. */
  reload(): Promise<void>
}

/** Extensions bundled with Amira and loaded by default (D50). */
async function defaultBuiltins(): Promise<{ source: string; extension: Extension }[]> {
  const bundled: [string, () => Promise<{ default?: unknown }>][] = [
    ["builtin:tools", () => import("@amira/builtin-tools")],
    ["builtin:status", () => import("@amira/ext-status")],
    ["builtin:commands", () => import("@amira/ext-commands")],
    ["builtin:tool-search", async () => ({ default: toolSearchExtension })],
    ["builtin:skills", () => import("@amira/ext-skills")],
    ["builtin:mcp", () => import("@amira/ext-mcp")],
    ["builtin:web", () => import("@amira/ext-web")],
    ["builtin:agent", () => import("@amira/ext-agent")],
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
  const settings = withPackageSkills(opts.settings ?? {}, opts.packages)
  // AMIRA_TEST_MOCK (end-to-end tests only) adds a scripted "mock" provider and keeps the
  // catalog download out of the test run.
  const mock = testAiOptions()
  const noCatalog = opts.ai || opts.catalog === false || mock.providers
  const catalogOpts = noCatalog ? undefined : (opts.catalog ?? {})
  const cached = catalogOpts ? await readCatalogCache(catalogOpts) : undefined
  const retry = retryFromSettings(settings.retry)
  const ai =
    opts.ai ??
    createAi({
      providers: [...(opts.providers ?? []), ...(mock.providers ?? [])],
      ...(mock.dialects ? { dialects: mock.dialects } : {}),
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

  const loadExtensions = async () => {
    if (!opts.noBuiltins) {
      try {
        for (const b of await (opts.builtins ?? defaultBuiltins)()) await host.load(b.extension, b.source)
      } catch (err) {
        const error = `failed to load built-in extensions: ${err instanceof Error ? err.message : String(err)}`
        bus.emit("extension.error", { source: "builtin", error }, { sessionId: "host" })
      }
    }
    for (const p of opts.packages?.packages ?? []) {
      for (const file of p.manifest.extensions) await host.loadFile(file)
    }
    for (const file of opts.extensions) await host.loadFile(file)
  }
  for (const p of opts.packages?.problems ?? []) {
    bus.emit("extension.error", { source: `package:${p.name}`, error: p.error }, { sessionId: "host" })
  }
  await loadExtensions()
  const { names: requested = [], from = "" } = opts.requestedDisabled ?? {}
  for (const name of requested) {
    if (tools.has(name)) continue
    const error = `${from}: no tool named "${name}"`
    bus.emit("extension.error", { source: "settings", error }, { sessionId: "host" })
  }
  // Like the other settings warnings, only where the caller reports them (not in print mode).
  if (opts.warnings) {
    for (const error of commandAliasWarnings(settings.commandAliases, host.commands)) {
      bus.emit("extension.error", { source: "settings", error }, { sessionId: "host" })
    }
  }
  tools.setDisabled(opts.disabledTools ?? [])
  await bus.flush()
  stopCapture()

  const tree = new AgentTree({
    ai,
    ...(settings.subagents?.maxDepth !== undefined ? { maxDepth: settings.subagents.maxDepth } : {}),
    ...(settings.subagents?.maxConcurrent ? { maxConcurrent: settings.subagents.maxConcurrent } : {}),
    ...(settings.budget ? { budget: settings.budget } : {}),
    ...(compaction ? { compaction } : {}),
    ...(settings.maxParallelTools ? { maxParallelTools: settings.maxParallelTools } : {}),
  })
  const approve = userApprover(host.ui)
  const newAgent = (m: ModelInfo, store: SessionStore | undefined) =>
    new Agent({
      tree,
      approve,
      ai,
      model: m,
      cwd: opts.cwd,
      sections: defaultSections({ cwd: opts.cwd, project: instructionsSection(loadInstructions(opts.cwd)) }),
      bus,
      interceptors,
      tools,
      ...(store ? { session: store } : {}),
      ...(compaction ? { compaction } : {}),
      ...(settings.maxParallelTools ? { maxParallelTools: settings.maxParallelTools } : {}),
    })
  const agent = newAgent(model, opts.store)
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
  return {
    agent,
    host,
    startupEvents,
    catalogRefresh,
    ai,
    tree,
    resume: (store, m) => newAgent(m ?? agent.model, store),
    reload: async () => {
      host.unloadAll()
      await loadExtensions()
    },
  }
}

/** Package skill directories are searched after the ones from settings. */
function withPackageSkills(settings: Settings, packages: ActivePackages | undefined): Settings {
  const dirs = packages?.packages.flatMap((p) => p.manifest.skills) ?? []
  if (!dirs.length) return settings
  return { ...settings, skills: { ...settings.skills, dirs: [...(settings.skills?.dirs ?? []), ...dirs] } }
}

/**
 * The top-level session's approvals go to the user (D13). Print mode cannot ask, so there a
 * call an interceptor asked about is denied.
 */
export function userApprover(ui: UiRequests): Approver {
  const dialogs = ui.api("approval")
  return async (request, signal) => {
    const args = JSON.stringify(request.args)
    const detail = `${request.reason}\n${args.length > 300 ? `${args.slice(0, 297)}...` : args}`
    const answer = await dialogs.confirm(`Allow ${request.name}?`, detail, { signal })
    if (answer) return { approved: true }
    return { approved: false, reason: answer === false ? "the user said no" : "nobody answered" }
  }
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
