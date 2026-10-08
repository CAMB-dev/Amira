import { type Ai, createAi, isNoModel, type ModelInfo, NO_MODEL, type ProviderConfig } from "@amira/ai"
import type { AnyEvent, Extension, ReloadReport, Settings, SettingsLayers, ShellMode } from "@amira/api"
import { DEFAULT_SHELL, DEFAULT_WEB_NATIVE_SEARCH } from "@amira/api"
import {
  Agent,
  AgentTree,
  amiraHome,
  amiraPath,
  type CompactionOptions,
  commandAliasWarnings,
  defaultSections,
  EventBus,
  ExtensionHost,
  fileCompactionMemory,
  InterceptorRegistry,
  instructionsSection,
  loadInstructions,
  Permissions,
  type ResolvedPermissions,
  type SessionStore,
  ToolRegistry,
  TraceRecorder,
  toolTraits,
} from "@amira/core"
import type { ActivePackages } from "@amira/packages"
import { UsageError } from "./args.ts"
import { type CatalogCacheOptions, readCatalogCache, refreshCatalog } from "./catalog.ts"
import { userApprover, userAsker } from "./session/approvals.ts"
import { createExtensionLoader, createReloadReplay } from "./session/extension-loading.ts"
import {
  compactionFromSettings,
  contextFromSettings,
  onlyProviderModel,
  resolveModel,
  retryFromSettings,
  toolsToDisable,
  withPackageSkills,
} from "./session/settings-adapters.ts"
import { testAiOptions } from "./test-hooks.ts"

export type { ApproverOptions } from "./session/approvals.ts"
export { approvalPreview, userApprover, userAsker } from "./session/approvals.ts"
export {
  contextFromSettings,
  onlyProviderModel,
  retryFromSettings,
  toolsToDisable,
} from "./session/settings-adapters.ts"

export interface SessionOptions {
  /**
   * "provider/model". Unset: the first model the only configured provider lists, else no
   * model (NO_MODEL) until one is picked, and `modelNotice` says why.
   */
  model?: string
  /** Throw a UsageError instead of starting without a model (print mode cannot pick one). */
  requireModel?: boolean
  autoTitle?: boolean
  cwd: string
  extensions: string[]
  /**
   * Installed packages (D24, D60): loaded after the built-ins and before `extensions`. A
   * function is asked again on each reload, so packages installed or removed since load then.
   */
  packages?: ActivePackages | (() => ActivePackages)
  noBuiltins: boolean
  /** Tools hidden from the model. */
  disabledTools?: string[]
  /** Shell mode used to filter tools after their capabilities are registered. */
  shell?: ShellMode
  /** The model cannot ask a person; print mode and RPC without a UI use this. */
  nonInteractive?: boolean
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
  /** Explicit settings values by source layer, handed to extensions with the merged settings. */
  settingsLayers?: SettingsLayers
  /** Re-reads settings for `/reload`, with their warnings; omitted by isolated session callers. */
  reloadSettings?: () => { settings: Settings; layers: SettingsLayers; warnings?: string[] }
  /** Providers from settings; there are no others. Unused when `ai` is given. */
  providers?: ProviderConfig[]
  /** Stored API keys by provider id (auth.json). Unused when `ai` is given. */
  apiKeys?: Record<string, string>
  /**
   * Settings warnings, reported as extension.error events from "settings" among the startup
   * events. When given, command aliases the loaded commands shadow are reported too.
   */
  warnings?: string[]
  /** Delays before notices of a failed turn are sent again; for tests. Default 10, 30 and 90 s. */
  noticeRetryMs?: number[]
  /** The permission mode and rules (resolveConfig). Default: auto mode without rules. */
  permissions?: ResolvedPermissions
}

export interface Session {
  agent: Agent
  host: ExtensionHost
  /** One host recorder shared by resumed agents and their descendants; absent in lightweight fixtures. */
  traceRecorder?: TraceRecorder
  /** Extension events emitted while loading, before any frontend subscribed. */
  startupEvents: AnyEvent[]
  /** Why the session has no model yet (NO_MODEL) and what to do; for the UI to show. */
  modelNotice?: string
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
  /**
   * Unloads every extension and loads them again (/reload), with the packages and their skill
   * directories as they are installed now; failures arrive as extension.error. Says what changed.
   * The extensions loaded again get the events that say where `agent` (default: the one this
   * session started with) is, as they had them before: its session.start with the model and
   * context as they are now, the last workspace.changed and budget.update.
   */
  reload(agent?: Agent): Promise<ReloadReport>
}

/** Extensions bundled with Amira and loaded by default (D50). */
async function defaultBuiltins(): Promise<{ source: string; extension: Extension }[]> {
  const bundled: [string, () => Promise<{ default?: unknown }>][] = [
    ["builtin:tools", () => import("../../../extensions/builtin-tools/src/index.ts")],
    [
      "builtin:tool-search",
      async () => ({
        default: (await import("../../../extensions/builtin-tools/src/tool-search.ts")).toolSearchExtension,
      }),
    ],
    ["builtin:status", () => import("../../../extensions/status/src/index.ts")],
    ["builtin:terminal-status", () => import("../../../extensions/terminal-status/src/index.ts")],
    ["builtin:commands", () => import("../../../extensions/commands/src/index.ts")],
    ["builtin:auto-title", () => import("../../../extensions/auto-title/src/index.ts")],
    ["builtin:skills", () => import("../../../extensions/skills/src/index.ts")],
    ["builtin:mcp", () => import("../../../extensions/mcp/src/index.ts")],
    ["builtin:web", () => import("../../../extensions/web/src/index.ts")],
    ["builtin:agent", () => import("../../../extensions/agent/src/index.ts")],
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
  const readPackages = () => (typeof opts.packages === "function" ? opts.packages() : opts.packages)
  let packages = readPackages()
  const settings = withPackageSkills(opts.settings ?? {}, packages)
  const extensionSettings = (value: Settings): Settings =>
    opts.autoTitle === false ? { ...value, sessions: { ...value.sessions, autoTitle: false } } : value
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
      // Hosted web search is per provider (compat.webSearch); this turns it off for all.
      ...((settings.web?.nativeSearch ?? DEFAULT_WEB_NATIVE_SEARCH) === false ? { webSearch: false } : {}),
      compactionMemory: fileCompactionMemory(amiraPath("cache", "native-compaction.json")),
    })
  const modelRef = opts.model ?? storedModel(ai, opts.store) ?? onlyProviderModel(ai)
  const model = modelRef ? resolveModel(ai, modelRef) : NO_MODEL
  const modelNotice = modelRef ? undefined : noModelNotice(ai)
  if (modelNotice && opts.requireModel) throw new UsageError(noModelError(ai))
  const compaction = opts.compaction ?? compactionFromSettings(ai, settings.compact)
  const context = contextFromSettings(settings.context)
  const bus = new EventBus(opts.onSubscriberError)
  const traceRecorder = new TraceRecorder(bus)
  const interceptors = new InterceptorRegistry({
    onError: (point, source, error) =>
      bus.emit("extension.error", { source, error: `${point}: ${error}` }, { sessionId: "host" }),
  })
  const tools = new ToolRegistry()
  const host = new ExtensionHost({
    bus,
    interceptors,
    tools,
    ai,
    settings: extensionSettings(settings),
    settingsLayers: opts.settingsLayers,
    cwd: opts.cwd,
  })
  const startupEvents: AnyEvent[] = []
  const stopCapture = bus.subscribe((e) => void startupEvents.push(e), {
    types: ["extension.error", "extension.loaded", "extension.notice"],
  })
  for (const error of opts.warnings ?? []) {
    bus.emit("extension.error", { source: "settings", error }, { sessionId: "host" })
  }

  const loadExtensions = createExtensionLoader({
    host,
    bus,
    noBuiltins: opts.noBuiltins,
    builtins: () => (opts.builtins ?? defaultBuiltins)(),
    getPackages: () => packages,
    extensions: opts.extensions,
    cwd: opts.cwd,
  })
  const untrusted = packages?.skipped.filter((s) => s.why === "untrusted").map((s) => s.name) ?? []
  if (untrusted.length) {
    const text = `Not loading this project's extension packages (${untrusted.join(", ")}): the project is not trusted. amira ext trust loads them from the next start.`
    bus.emit("extension.notice", { source: "packages", text, level: "warning" }, { sessionId: "host" })
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
  const disabled = new Set(
    toolsToDisable(
      opts.shell ?? settings.shell ?? DEFAULT_SHELL,
      opts.disabledTools ?? [],
      tools.list().map(({ tool }) => tool),
    ),
  )
  if (opts.nonInteractive) {
    for (const { tool } of tools.list()) if (toolTraits(tool)?.interactive) disabled.add(tool.name)
  }
  tools.setDisabled(disabled)
  await bus.flush()
  stopCapture()

  const reloadReplay = createReloadReplay(bus)

  const tree = new AgentTree({
    ai,
    sections: (cwd) =>
      defaultSections({
        cwd,
        nonInteractive: opts.nonInteractive,
        project: instructionsSection(loadInstructions(cwd)),
      }),
    ...(settings.subagents?.maxDepth !== undefined ? { maxDepth: settings.subagents.maxDepth } : {}),
    ...(settings.subagents?.maxConcurrent ? { maxConcurrent: settings.subagents.maxConcurrent } : {}),
    ...(settings.budget ? { budget: settings.budget } : {}),
    ...(compaction ? { compaction } : {}),
    ...(context ? { context } : {}),
    ...(settings.maxParallelTools ? { maxParallelTools: settings.maxParallelTools } : {}),
  })
  const approve = userApprover(host.ui, {
    presenters: host.renderers,
    tree,
    notify: (text) =>
      bus.emit("extension.notice", { source: "approval", text, level: "info" }, { sessionId: "host" }),
  })
  // One policy for every agent of this session and their sub-agents; its questions go to the user.
  const resolved = opts.permissions
  const permissions = new Permissions({
    ...(resolved
      ? {
          mode: resolved.mode,
          rules: resolved.rules,
          warnings: resolved.warnings,
          modeSource: resolved.modeSource,
        }
      : {}),
    protect: { amiraHome: amiraHome() },
    approver: approve,
  })
  const ask = userAsker(host.ui, tree)
  const newAgent = (picked: ModelInfo, store: SessionStore | undefined) => {
    if (store) traceRecorder.register(store.id, store.file)
    // A session resumed while no model is selected continues on the one it ran on.
    const stored = isNoModel(picked) ? storedModel(ai, store) : undefined
    const m = stored ? ai.model(stored) : picked
    return new Agent({
      tree,
      approve,
      permissions,
      ask,
      ai,
      model: m,
      providerSettings: settings.providers,
      defaultThinking: settings.thinking,
      thinking: opts.settingsLayers?.thinking?.some((layer) => layer.scope === "flags")
        ? settings.thinking
        : undefined,
      fileRewindSettings: settings.fileRewind,
      cwd: opts.cwd,
      sections: defaultSections({
        cwd: opts.cwd,
        nonInteractive: opts.nonInteractive,
        project: instructionsSection(loadInstructions(opts.cwd)),
      }),
      bus,
      interceptors,
      tools,
      backgroundJobs: host.backgroundJobs,
      ...(store ? { session: store } : {}),
      ...(compaction ? { compaction } : {}),
      ...(context ? { context } : {}),
      ...(settings.maxParallelTools ? { maxParallelTools: settings.maxParallelTools } : {}),
      ...(opts.noticeRetryMs ? { noticeRetryMs: opts.noticeRetryMs } : {}),
    })
  }
  const agent = newAgent(model, opts.store)
  // A stale or missing catalog is refreshed in the background; startup never waits for it.
  const catalogRefresh =
    catalogOpts && cached?.stale
      ? refreshCatalog(catalogOpts)
          .then((catalog) => {
            if (!catalog) return
            ai.setCatalog?.(catalog)
            // Only replace the model this session started with, not one chosen since.
            if (modelRef && agent.model === model) agent.model = ai.model(modelRef)
          })
          .catch(() => {})
      : Promise.resolve()
  return {
    agent,
    host,
    traceRecorder,
    startupEvents,
    ...(modelNotice ? { modelNotice } : {}),
    catalogRefresh,
    ai,
    tree,
    resume: (store, m) => newAgent(m ?? agent.model, store),
    reload: async (current = agent) => {
      const before = new Set(host.loaded)
      const skillsBefore = new Set(host.skills.list().map((s) => s.name))
      packages = readPackages()
      const reloaded = opts.reloadSettings?.()
      for (const error of reloaded?.warnings ?? []) {
        bus.emit("extension.error", { source: "settings", error }, { sessionId: "host" })
      }
      host.unloadAll()
      host.setSettings(
        extensionSettings(withPackageSkills(reloaded?.settings ?? opts.settings ?? {}, packages)),
        reloaded?.layers ?? opts.settingsLayers,
      )
      host.replayOnLoad(reloadReplay(current))
      let failed: string[]
      try {
        failed = await loadExtensions()
      } finally {
        host.replayOnLoad(undefined)
      }
      const after = new Set(host.loaded)
      const skillsAfter = new Set(host.skills.list().map((s) => s.name))
      return {
        loaded: [...after].filter((s) => !before.has(s)),
        unloaded: [...before].filter((s) => !after.has(s)),
        failed,
        extensions: after.size,
        skillsAdded: [...skillsAfter].filter((s) => !skillsBefore.has(s)).length,
        skillsRemoved: [...skillsBefore].filter((s) => !skillsAfter.has(s)).length,
      }
    },
  }
}

/** The model a stored session last ran on, when a configured provider still has it. */
function storedModel(ai: Ai, store: SessionStore | undefined): string | undefined {
  const m = store?.model()
  if (!m) return undefined
  const ref = `${m.provider}/${m.model}`
  try {
    ai.model(ref)
    return ref
  } catch {
    return undefined
  }
}

/** What the UI says when a session starts without a model. */
function noModelNotice(ai: Ai): string {
  return ai.providers().length === 0
    ? "No providers configured — add one with /provider add, then pick a model with /model."
    : 'No model selected — pick one with /model, or set "model" in settings.json.'
}

/** The print-mode error for the same, which cannot be fixed from inside the run. */
function noModelError(ai: Ai): string {
  return ai.providers().length === 0
    ? 'no providers configured; add one with "amira provider add", then pass -m provider/model'
    : 'no model selected. Pass -m provider/model, set AMIRA_MODEL or set "model" in settings.json.'
}
