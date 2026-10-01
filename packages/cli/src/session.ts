import path from "node:path"
import {
  type Ai,
  createAi,
  isNoModel,
  type ModelInfo,
  NO_MODEL,
  type ProviderConfig,
  type RetryOptions,
} from "@amira/ai"
import type {
  AnyEvent,
  EventEnvelope,
  Extension,
  ReloadReport,
  Settings,
  ToolLine,
  ToolPresenter,
} from "@amira/api"
import {
  type ActivePackages,
  Agent,
  AgentTree,
  type Approver,
  type Asker,
  amiraPath,
  type CompactionOptions,
  type ContextOptions,
  commandAliasWarnings,
  defaultSections,
  EventBus,
  ExtensionHost,
  fileCompactionMemory,
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
import { withProviderHint } from "./provider-command.ts"
import { testAiOptions } from "./test-hooks.ts"

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
}

export interface Session {
  agent: Agent
  host: ExtensionHost
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
  const readPackages = () => (typeof opts.packages === "function" ? opts.packages() : opts.packages)
  let packages = readPackages()
  const settings = withPackageSkills(opts.settings ?? {}, packages)
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
      ...(settings.web?.nativeSearch === false ? { webSearch: false } : {}),
      compactionMemory: fileCompactionMemory(amiraPath("cache", "native-compaction.json")),
    })
  const modelRef = opts.model ?? storedModel(ai, opts.store) ?? onlyProviderModel(ai)
  const model = modelRef ? resolveModel(ai, modelRef) : NO_MODEL
  const modelNotice = modelRef ? undefined : noModelNotice(ai)
  if (modelNotice && opts.requireModel) throw new UsageError(noModelError(ai))
  const compaction = opts.compaction ?? compactionFromSettings(ai, settings.compact)
  const context = contextFromSettings(settings.context)
  const bus = new EventBus(opts.onSubscriberError)
  const interceptors = new InterceptorRegistry({
    onError: (point, source, error) =>
      bus.emit("extension.error", { source, error: `${point}: ${error}` }, { sessionId: "host" }),
  })
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors, tools, settings, cwd: opts.cwd })
  const startupEvents: AnyEvent[] = []
  const stopCapture = bus.subscribe((e) => void startupEvents.push(e), {
    types: ["extension.error", "extension.loaded", "extension.notice"],
  })
  for (const error of opts.warnings ?? []) {
    bus.emit("extension.error", { source: "settings", error }, { sessionId: "host" })
  }

  /** Loads everything; returns the sources that failed. */
  const loadExtensions = async (): Promise<string[]> => {
    const failed: string[] = []
    if (!opts.noBuiltins) {
      try {
        for (const b of await (opts.builtins ?? defaultBuiltins)()) {
          if (!(await host.load(b.extension, b.source))) failed.push(b.source)
        }
      } catch (err) {
        const error = `failed to load built-in extensions: ${err instanceof Error ? err.message : String(err)}`
        bus.emit("extension.error", { source: "builtin", error }, { sessionId: "host" })
        failed.push("builtin")
      }
    }
    for (const p of packages?.packages ?? []) {
      for (const file of p.manifest.extensions) {
        const label = packageLabel(p, file)
        if (!(await host.loadFile(file, label))) failed.push(label.source)
      }
    }
    for (const file of opts.extensions) {
      const source = fileLabel(file, opts.cwd)
      if (!(await host.loadFile(file, { source }))) failed.push(source)
    }
    for (const p of packages?.problems ?? []) {
      bus.emit("extension.error", { source: p.name, error: p.error }, { sessionId: "host" })
      failed.push(p.name)
    }
    return failed
  }
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
  tools.setDisabled(opts.disabledTools ?? [])
  await bus.flush()
  stopCapture()

  // What a reload hands the extensions it loads again: the top-level session's start, where it
  // works and what it cost since (D37: the whole tree's).
  const state: {
    start?: EventEnvelope<"session.start">
    workspace?: EventEnvelope<"workspace.changed">
    budget?: EventEnvelope<"budget.update">
  } = {}
  bus.subscribe(
    (e) => {
      if (e.type === "session.start" && e.parentSessionId === undefined) {
        state.start = e
        // A cost counts from the start of its session.
        delete state.budget
      } else if (e.type === "workspace.changed") state.workspace = e
      else if (e.type === "budget.update") state.budget = e
    },
    { types: ["session.start", "workspace.changed", "budget.update"] },
  )
  const reloadReplay = (a: Agent): AnyEvent[] => {
    const out: AnyEvent[] = []
    const start = state.start
    if (start?.sessionId === a.sessionId) {
      const { contextTokens: _t, contextWindow: _w, ...rest } = start.data
      const tokens = a.contextTokens
      out.push({
        ...start,
        data: {
          ...rest,
          model: { provider: a.model.provider, model: a.model.id },
          ...(tokens !== undefined ? { contextTokens: tokens, contextWindow: a.model.contextWindow } : {}),
        },
      })
    }
    if (state.workspace) out.push(state.workspace)
    if (state.budget) out.push(state.budget)
    return out.sort((x, y) => x.seq - y.seq)
  }

  const tree = new AgentTree({
    ai,
    ...(settings.subagents?.maxDepth !== undefined ? { maxDepth: settings.subagents.maxDepth } : {}),
    ...(settings.subagents?.maxConcurrent ? { maxConcurrent: settings.subagents.maxConcurrent } : {}),
    ...(settings.budget ? { budget: settings.budget } : {}),
    ...(compaction ? { compaction } : {}),
    ...(context ? { context } : {}),
    ...(settings.maxParallelTools ? { maxParallelTools: settings.maxParallelTools } : {}),
  })
  const approve = userApprover(host.ui, {
    presenters: host.renderers,
    notify: (text) =>
      bus.emit("extension.notice", { source: "approval", text, level: "info" }, { sessionId: "host" }),
  })
  const ask = userAsker(host.ui, tree)
  const newAgent = (picked: ModelInfo, store: SessionStore | undefined) => {
    // A session resumed while no model is selected continues on the one it ran on.
    const stored = isNoModel(picked) ? storedModel(ai, store) : undefined
    const m = stored ? ai.model(stored) : picked
    return new Agent({
      tree,
      approve,
      ask,
      ai,
      model: m,
      providerSettings: settings.providers,
      cwd: opts.cwd,
      sections: defaultSections({ cwd: opts.cwd, project: instructionsSection(loadInstructions(opts.cwd)) }),
      bus,
      interceptors,
      tools,
      ...(store ? { session: store } : {}),
      ...(opts.autoTitle && settings.sessions?.autoTitle !== false
        ? { autoTitle: { ...(settings.compact?.model ? { model: ai.model(settings.compact.model) } : {}) } }
        : {}),
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
      host.setSettings(withPackageSkills(opts.settings ?? {}, packages))
      host.unloadAll()
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

/**
 * How a package's extension file is named in errors and /help: the package's name, and the
 * file too when the package has several. Its failures say how to turn it off.
 */
function packageLabel(p: ActivePackages["packages"][number], file: string): { source: string; hint: string } {
  const rel = path.relative(p.dir, file).split(path.sep).join("/")
  const source = p.manifest.extensions.length > 1 ? `${p.name}/${rel}` : p.name
  return { source, hint: `${p.scope} package; amira ext disable ${p.name} turns it off` }
}

/** An extension file given with --extension: its path relative to the working directory, if inside it. */
function fileLabel(file: string, cwd: string): string {
  const abs = path.resolve(cwd, file)
  const rel = path.relative(cwd, abs)
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs
}

/** Package skill directories are searched after the ones from settings. */
function withPackageSkills(settings: Settings, packages: ActivePackages | undefined): Settings {
  const dirs = packages?.packages.flatMap((p) => p.manifest.skills) ?? []
  if (!dirs.length) return settings
  return { ...settings, skills: { ...settings.skills, dirs: [...(settings.skills?.dirs ?? []), ...dirs] } }
}

export interface ApproverOptions {
  /** Where tools' presenters are, to show what a call would do (a command, a diff). */
  presenters?: { get(toolName: string): ToolPresenter<any, any> | undefined }
  /** Tells the user something, e.g. that a call is allowed for the rest of the session. */
  notify?: (text: string) => void
}

/**
 * The top-level session's approvals go to the user (D13). Print mode cannot ask, so there a
 * call an interceptor asked about is denied. Dismissing the question (Esc) denies the call
 * and interrupts the turn.
 */
export function userApprover(ui: UiRequests, opts: ApproverOptions = {}): Approver {
  /** Calls the user said not to ask about again: a tool with the reason it was asked about. */
  const allowed = new Set<string>()
  return async (request, signal) => {
    const key = JSON.stringify([request.name, request.reason])
    if (allowed.has(key)) return { approved: true, by: "rule" }
    if (ui.unavailable) return { approved: false, reason: `nobody can approve it (${ui.unavailable})` }
    const preview = approvalPreview(request.args, opts.presenters?.get(request.name))
    // "Don't ask again" covers this tool asked about for this reason; the message says so.
    const scope = `"Don't ask again" covers ${request.name} asked about for: ${request.reason}`
    const message = preview
      ? `${request.reason}\n${scope}`
      : `${request.reason}\n${rawArgs(request.args)}\n${scope}`
    const answer = await ui.ask(
      {
        kind: "confirm",
        title: `Allow ${request.name}?`,
        message,
        always: true,
        other: true,
        ...(preview ? { preview } : {}),
      },
      { signal, source: "approval" },
    )
    if (answer === "always") {
      allowed.add(key)
      opts.notify?.(
        `${request.name} is allowed without asking for the rest of this session (${request.reason}).`,
      )
    }
    if (answer === true || answer === "always") return { approved: true, by: "user" }
    if (typeof answer === "object") return { approved: false, reason: `the user said no: ${answer.other}` }
    if (answer === false) return { approved: false, reason: "the user said no" }
    // Cancelled: by the turn's interrupt, or by the user dismissing the question.
    if (signal.aborted) return { approved: false, reason: "the turn was interrupted" }
    return {
      approved: false,
      reason: "the user dismissed the question and stopped the turn",
      interrupt: true,
    }
  }
}

/** A call's arguments as JSON, cut short. */
function rawArgs(args: Record<string, unknown>): string {
  const json = JSON.stringify(args)
  return json.length > 300 ? `${json.slice(0, 299)}…` : json
}

/**
 * What an asked-about call would do, as its presenter shows it: the lines of its body worked
 * out from the arguments alone (edit and write show their diff), else its summary as a line
 * of code (bash shows the command). Undefined when the tool has no presenter for it.
 */
export function approvalPreview(
  args: Record<string, unknown>,
  presenter: ToolPresenter<any, any> | undefined,
): ToolLine[] | undefined {
  if (!presenter) return undefined
  try {
    const view = { args, result: { content: [] }, text: "" }
    const body = presenter.body?.(view, { detail: "full", width: 100 }) ?? []
    const summary = presenter.summary?.(args)?.trim()
    if (body.length) return summary ? [{ kind: "muted", text: summary }, ...body] : body
    // A command is shown whole: the summary has its first line only.
    const command = typeof args.command === "string" && args.command.trim() ? args.command : summary
    if (command) return command.split("\n").map((text) => ({ kind: "code", text }))
  } catch {
    // A presenter that cannot show it leaves the raw arguments.
  }
  return undefined
}

/**
 * The top-level session's questions (ask_user) go to the user; a sub-agent's reach here when
 * its commander passes them on, marked as such. Print mode says nobody can answer.
 */
export function userAsker(ui: UiRequests, tree?: AgentTree): Asker {
  return async (request, signal) => {
    if (ui.unavailable) return { unavailable: ui.unavailable }
    const source = tree?.subagent(request.sessionId) ? "sub-agent" : undefined
    const answers = await ui.api(source).ask(request.questions, { signal })
    return answers ? { answers } : { declined: true }
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
    throw new UsageError(withProviderHint(err instanceof Error ? err.message : String(err), "startup"))
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

/** With exactly one provider configured, the first model it lists ("provider/model"). */
export function onlyProviderModel(ai: Ai): string | undefined {
  const providers = ai.providers()
  const [only] = providers
  const first = only?.models?.find((m) => m.id)?.id
  return providers.length === 1 && only && first ? `${only.id}/${first}` : undefined
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
    ? 'no providers configured; add one with "amira provider add", then pass --model provider/model'
    : 'no model selected. Pass --model provider/model, set AMIRA_MODEL or set "model" in settings.json.'
}

/** Settings `compact` as agent options; its model is resolved like --model. */
function compactionFromSettings(ai: Ai, compact: Settings["compact"]): CompactionOptions | undefined {
  if (!compact) return undefined
  const out: CompactionOptions = {}
  if (compact.threshold !== undefined) out.threshold = compact.threshold
  if (compact.model) out.model = resolveModel(ai, compact.model)
  if (compact.layout) out.layout = compact.layout
  return Object.keys(out).length ? out : undefined
}

/** Settings `context` as agent options. */
export function contextFromSettings(context: Settings["context"]): ContextOptions | undefined {
  if (!context) return undefined
  const out: ContextOptions = {}
  const o = context.outputs
  if (o?.saveAbove !== undefined) out.saveAbove = o.saveAbove
  if (o?.previewChars !== undefined)
    out.previewChars = Math.min(o.previewChars, o.saveAbove ?? o.previewChars)
  if (o?.quotaMB !== undefined) out.quotaBytes = o.quotaMB * 1024 * 1024
  if (context.dedupeReads !== undefined) out.dedupeReads = context.dedupeReads
  if (context.aging) out.aging = { ...context.aging }
  return Object.keys(out).length ? out : undefined
}

/** The tools to hide for a shell mode and an explicit list (D68, D70). */
export function toolsToDisable(shell: "auto" | "bash" | "powershell", explicit: string[]): string[] {
  const out = new Set(explicit)
  if (shell === "bash") out.add("powershell")
  if (shell === "powershell") out.add("bash")
  return [...out]
}
