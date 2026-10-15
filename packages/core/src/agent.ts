import {
  hasFastMode,
  isNoModel,
  type Message,
  type ModelInfo,
  modelMessages,
  type ToolSpec,
  type UserMessage,
  userMessage,
} from "@amira/ai"
import type {
  AskOutcome,
  AskRequest,
  BackgroundJobHost,
  BackgroundJobSession,
  CompactionInfo,
  CompactionUsage,
  EventMap,
  PendingNotice,
  ProviderSettings,
  SessionData,
  SessionStatus,
  Settings,
  ToolDefinition,
  ToolSession,
} from "@amira/api"
import { DEFAULT_MAX_PARALLEL_TOOLS } from "@amira/api"
import { ApprovalGate } from "./agent/approvals.ts"
import {
  type ArtifactSession,
  discoverArtifactGroups,
  pruneArtifacts,
  summarizeArtifactUsage,
} from "./agent/artifact-usage.ts"
import type { Compactor } from "./agent/compactor.ts"
import {
  buildContext,
  toolRestriction as modelToolRestriction,
  offeredDeferredTools,
  offeredTools,
} from "./agent/context-builder.ts"
import type { ContextManager } from "./agent/context-manager.ts"
import { History } from "./agent/history.ts"
import { SessionHold } from "./agent/hold.ts"
import { modelRef } from "./agent/messages.ts"
import { reportedSpeed, Thinking } from "./agent/model-call.ts"
import { NoticeInbox } from "./agent/notices.ts"
import { OwnedToolRunner } from "./agent/owned-tool.ts"
import {
  callToolSession,
  createSessionArtifacts,
  recoverFileRewind,
  reportFileRewind,
  restoreHistory,
  setupContext,
  setupToolSession,
} from "./agent/setup.ts"
import { checkRestoredTools, setupToolRunner } from "./agent/tool-setup.ts"
import { TurnRunner, type TurnState } from "./agent/turn-runner.ts"
import {
  AgentAbortedError,
  type AgentOptions,
  type Approver,
  NOTICE_RETRY_MS,
  type PromptOptions,
  type Turn,
  type TurnResult,
} from "./agent/types.ts"
import type { ArtifactScope, ArtifactStore, ArtifactUsage } from "./artifacts.ts"

export * from "./agent/exports.ts"

import { withCallableServerTools } from "./callable-server-tools.ts"
import type { CompactionOptions } from "./compaction.ts"
import type { ContextOptions, ContextView } from "./context.ts"
import { type EmitMeta, EventBus } from "./event-bus.ts"
import { FileRewind } from "./file-rewind.ts"
import { InterceptorRegistry } from "./interceptors.ts"
import { assertOwnedSession } from "./owned-session.ts"
import { Permissions } from "./permissions/policy.ts"
import { intersectWriteRoots } from "./permissions/write-roots.ts"
import {
  addNonInteractive,
  NON_INTERACTIVE_LINE,
  type PromptSection,
  renderPrompt,
  setSection,
} from "./prompt.ts"
import { newSessionId, type SessionStore } from "./session-store.ts"
import { scopeAdmission } from "./subagents/lifecycle.ts"
import { PauseGate } from "./subagents/pause.ts"
import type { AgentTree } from "./subagents.ts"
import { ToolRegistry } from "./tool-registry.ts"

/** One agent session: a conversation, a model and the loop that drives tool use. */
export class Agent {
  // Wiring/collaborators: session capabilities, configuration and their owners.
  readonly sessionId: string
  readonly parentSessionId: string | undefined
  readonly bus: EventBus
  readonly interceptors: InterceptorRegistry
  readonly tools: ToolRegistry
  readonly callableTools: ReadonlySet<string> | undefined
  #writeRoots: readonly string[] | undefined
  get writeRoots(): readonly string[] | undefined {
    return this.#writeRoots
  }
  readonly cwd: string
  readonly messages: Message[]
  readonly session: SessionStore | undefined
  readonly fileRewind: FileRewind | undefined
  readonly fileRewindSettings: Settings["fileRewind"]
  /** 0 for a top-level session, 1 for its sub-agents, and so on. */
  readonly depth: number
  readonly tree: AgentTree | undefined
  readonly execution = new PauseGate()
  /** The session-scoped background-job capability, when this host provides it. */
  readonly backgroundJobs: BackgroundJobSession | undefined
  /** The host implementation handed to child agents and lifecycle cleanup. */
  readonly backgroundJobsHost: BackgroundJobHost | undefined
  /** The permission policy of this session's tree. */
  readonly permissions: Permissions
  model: ModelInfo
  /** Requested session preference, retained across switches to unsupported models. */
  fastMode: boolean
  /** Speed reported by the most recent model response, absent when not reported. */
  lastSpeed: string | undefined
  lastFastPricingUnknown: boolean | undefined
  get fastModeApplied(): boolean {
    return this.fastMode && hasFastMode(this.model)
  }
  /** This session's saved tool outputs (A1). */
  readonly artifacts: ArtifactStore
  readonly providerSettings: Record<string, ProviderSettings>
  /** The effort for each model, with the /thinking override; new sub-agents inherit it. */
  readonly thinking: Thinking
  /** Retried request usage for sessions without a backing file; never part of model context. */
  #retryUsage: CompactionUsage[] = []
  get retryUsage(): readonly CompactionUsage[] {
    return this.#retryUsage
  }
  /**
   * Records extensions keep in this session (SessionData): custom entries of its file, or
   * kept in memory when it has none.
   */
  readonly data: SessionData
  #approvals: ApprovalGate
  #history: History
  #contextManager: ContextManager
  #compactor: Compactor
  #inbox: NoticeInbox
  #maxParallelTools: number
  #sections: PromptSection[]
  #compaction: CompactionOptions
  #context: ContextOptions
  /** Deferred tools this session loaded (via tool_search), in load order. */
  #loadedTools = new Set<string>()
  /**
   * Loaded tools restored from the session file, checked at the first model call: by then
   * system.build has waited for tools that register late (MCP servers).
   */
  #restoredTools: string[] | undefined
  #toolSession: ToolSession
  #onIdleNotice: (() => void) | undefined
  #endTurn: (() => boolean) | undefined

  // Turn state: execution, status and steering (the abort controller also guards holds).
  #status: SessionStatus = "idle"
  #turnState: TurnState = { abort: undefined, turn: undefined, steering: [], steerAbort: undefined }
  #turnRunner: TurnRunner
  #ownedTools: OwnedToolRunner
  /** The running turn's promise, for owners that wait for whatever turn runs. */
  #current: Promise<TurnResult> | undefined

  /** Between-turn work and the messages queued behind it. */
  #hold: SessionHold

  // Lifecycle: disposal and ownership of the session lease.
  #disposePromise: Promise<void> | undefined
  #disposed = false
  #releaseSessionLease: (() => void) | undefined

  constructor(opts: AgentOptions) {
    assertOwnedSession(opts)
    this.session = opts.session
    this.depth = opts.depth ?? 0
    if (this.session) {
      if (this.depth === 0 && !opts.parentSessionId) {
        this.session.claim()
        this.#releaseSessionLease = () => this.session!.release()
      } else this.#releaseSessionLease = this.session.claimOnWrite()
    }
    try {
      this.fileRewindSettings = opts.fileRewindSettings
      this.fileRewind =
        opts.fileRewind ?? (opts.session ? new FileRewind(opts.session, opts.fileRewindSettings) : undefined)
      const rewind = recoverFileRewind(this.fileRewind, opts)
      this.sessionId = opts.session?.id ?? opts.sessionId ?? newSessionId()
      this.parentSessionId = opts.parentSessionId
      this.backgroundJobsHost = opts.backgroundJobs
      this.bus = opts.bus ?? new EventBus()
      reportFileRewind(this.bus, this.sessionId, rewind)
      this.interceptors = opts.interceptors ?? new InterceptorRegistry()
      this.tools = opts.tools ?? new ToolRegistry()
      this.callableTools = opts.callableTools
      this.#writeRoots = intersectWriteRoots(
        intersectWriteRoots(opts.session?.header.owned?.spec.writeRoots, opts.session?.header.writeRoots),
        opts.writeRoots,
      )
      this.permissions = opts.permissions ?? new Permissions()
      this.cwd = opts.cwd
      this.model = opts.model
      this.fastMode = opts.fastMode ?? false
      this.providerSettings = opts.providerSettings ?? {}
      this.thinking = new Thinking(opts, (data) => this.#emit(undefined, "thinking.changed", data))
      this.#sections = opts.sections ?? [{ name: "identity", text: opts.systemPrompt ?? "" }]
      this.#compaction = opts.compaction ?? {}
      this.#context = opts.context ?? {}
      const ai = withCallableServerTools(opts.ai, this.callableTools)
      const maxSteps = opts.maxSteps ?? 200
      const maxTokens = opts.maxTokens
      const retryMs = opts.noticeRetryMs ?? NOTICE_RETRY_MS
      this.#maxParallelTools = Math.max(1, opts.maxParallelTools ?? DEFAULT_MAX_PARALLEL_TOOLS)
      this.tree = opts.tree
      this.backgroundJobs = opts.backgroundJobs?.forSession({
        sessionId: this.sessionId,
        depth: this.depth,
        ...(this.parentSessionId ? { parentSessionId: this.parentSessionId } : {}),
      })
      this.#approvals = new ApprovalGate({
        sessionId: this.sessionId,
        depth: this.depth,
        approve: opts.approve,
        inheritedApprover: opts.permissionApprover,
        ask: opts.ask,
        forwardAsk: opts.ask?.bind(this),
        resolvePermissionApprover: () => this.permissionApprover,
        permissions: this.permissions,
        isCurrentTurn: (turn) => this.#turnState.turn === turn,
        blocked: (turn, reason, pending) => {
          this.#status = "blocked"
          this.#emit(turn, "status.changed", { status: "blocked", reason, pending })
        },
        working: (turn) => this.#setStatus(turn, "working"),
      })
      const toolRunner = setupToolRunner(this, {
        approvals: this.#approvals,
        abortGraceMs: opts.abortGraceMs ?? 2000,
        allowsTool: (tool) => this.#allowsTool(tool),
        steerSignal: () => this.#turnState.steerAbort?.signal,
        storeFailed: () => this.#history.storeFailed,
        callSession: (turn, toolCallId) => this.#callSession(turn, toolCallId),
        keepLarge: (call, result) => this.#contextManager.keepLarge(call, result),
        interruptTurn: (turn) => {
          if (this.#turnState.turn === turn) this.#turnState.abort?.abort()
        },
        emit: (turn, type, data) => this.#emit(turn, type, data),
      })
      this.#ownedTools = new OwnedToolRunner(
        this,
        this.#turnState,
        toolRunner,
        (turn, status) => this.#setStatus(turn, status),
        () => this.#disposed,
      )
      this.#onIdleNotice = opts.onIdleNotice
      this.#inbox = new NoticeInbox({
        retryMs,
        disposed: () => this.#disposed,
        turn: () => this.#turnState.turn,
        holding: () => this.#hold.what,
        busy: () => this.#turnState.abort !== undefined,
        onIdleNotice: this.#onIdleNotice?.bind(this),
        prompt: (message) => this.prompt(message),
        emit: (turn, type, data) => this.#emit(turn, type, data),
      })
      this.#hold = new SessionHold({
        state: this.#turnState,
        inbox: this.#inbox,
        prompt: (message, options) => this.prompt(message, options),
        emit: (turn, type, data) => this.#emit(turn, type, data),
      })
      this.#endTurn = opts.endTurn

      const { history, tokens, restoredTools } = restoreHistory(opts, this.#loadedTools)
      this.#restoredTools = restoredTools
      this.#history = new History(
        {
          session: this.session,
          reportStoreError: (error) =>
            this.bus.emit("extension.error", { source: "session", error }, { sessionId: this.sessionId }),
          originals: opts.originals?.bind(this),
        },
        history,
      )
      this.messages = this.#history.messages
      const lastReply = this.messages.findLast((m) => m.role === "assistant")
      const lastUsage = lastReply?.usage
      let lastModel = this.model
      if (lastReply) {
        try {
          lastModel = opts.ai.model(`${lastReply.model.provider}/${lastReply.model.model}`)
        } catch {}
      }
      this.lastSpeed = reportedSpeed(lastModel, lastUsage)
      this.lastFastPricingUnknown = lastUsage?.pricingUnknown
      this.data = this.#history.data
      this.artifacts = createSessionArtifacts(opts, this.sessionId, this.#context)
      const { contextManager, compactor } = setupContext(
        {
          ai,
          model: () => this.model,
          context: this.#context,
          compaction: this.#compaction,
          history: this.#history,
          artifacts: this.artifacts,
          tools: this.tools,
          toolFor: (call) => toolRunner.toolFor(call),
          cwd: this.cwd,
          interceptors: this.interceptors,
          session: this.session,
          sessionId: this.sessionId,
          isSubAgent: this.parentSessionId !== undefined,
          execution: this.execution,
          buildContext: (signal) => this.#buildContext(signal),
          renderSections: () => renderPrompt(this.#sections),
          offeredTools: () => this.#offeredTools(),
          recordTreeUsage: (usage) => this.tree?.recordUsage(this, usage),
          emit: (turn, type, data) => this.#emit(turn, type, data),
        },
        tokens,
      )
      this.#contextManager = contextManager
      this.#compactor = compactor
      const stored = opts.session?.model()
      // NO_MODEL is a placeholder until one is picked, not a model the session ran on.
      const changed = stored?.provider !== this.model.provider || stored.model !== this.model.id
      if (opts.session && changed && !isNoModel(this.model)) {
        this.#history.store({ type: "model_change", model: modelRef(this.model) })
      }
      const tree = opts.tree
      this.#toolSession = setupToolSession({
        sessionId: this.sessionId,
        tools: this.tools,
        loadedTools: this.#loadedTools,
        allowsTool: (tool) => this.#allowsTool(tool),
        session: opts.session,
        history: this.#history,
        artifacts: this.artifacts,
        contextHas: (text) => this.contextHas(text),
        depth: this.depth,
        maxDepth: () => tree?.maxDepth ?? 0,
        model: () => this.model,
        spawning: tree
          ? {
              restricted: tree.restricted,
              spawn: (o) => tree.spawn(this, o),
              createGroup: (o) => tree.createGroup(this, o),
              groups: () => tree.groups(),
            }
          : undefined,
        expectNotice:
          this.depth === 0 || this.#onIdleNotice ? () => this.#inbox.target().expect() : undefined,
      })
      this.#turnRunner = new TurnRunner(this.#turnState, {
        ai,
        history: this.#history,
        compactor: this.#compactor,
        contextManager: this.#contextManager,
        toolRunner,
        inbox: this.#inbox,
        execution: this.execution,
        tools: this.tools,
        thinking: this.thinking,
        fastMode: () => this.fastModeApplied,
        recordAttempt: (message) => {
          if (!message.usage) return
          const entry = { model: message.model, usage: message.usage, label: "request retry" }
          if (!this.session) this.#retryUsage.push(entry)
          this.#history.store({ type: "side_usage", ...entry })
          this.tree?.recordUsage(this, message.usage)
        },
        recordSpeed: (speed, pricingUnknown) => {
          this.lastSpeed = speed
          this.lastFastPricingUnknown = pricingUnknown
        },
        model: () => this.model,
        maxSteps,
        maxTokens,
        depth: this.depth,
        compaction: this.#compaction,
        buildContext: (signal) => this.#buildContext(signal),
        offeredTools: () => this.#offeredTools(),
        checkRestoredTools: () => this.#checkRestoredTools(),
        emit: (turn, type, data) => this.#emit(turn, type, data),
        setStatus: (turn, status, reason) => this.#setStatus(turn, status, reason),
        prompt: (input, options) => this.prompt(input, options),
        disposed: () => this.#disposed,
        ownsIdleNotices: () => !!this.#onIdleNotice,
        endTurn: () => this.#endTurn?.(),
        recordTreeUsage: (usage) => this.tree?.recordUsage(this, usage),
      })
    } catch (error) {
      this.#releaseSessionLease?.()
      throw error
    }
  }

  /**
   * Announces a message this session gets later from outside its turns, such as a background
   * sub-agent's result (see PendingNotice). Delivered while a turn runs it joins the turn
   * before its next model call (and starts the next turn if the turn ends first); delivered
   * while idle it starts a turn. Notices waiting together reach the model as one message. One
   * that an interrupted or failed turn did not reach waits for the next turn.
   */
  expectNotice(): PendingNotice {
    return this.#inbox.expect()
  }

  /** Sends notices for top-level background work to the replacement session after a switch. */
  handoverBackgroundNotices(next: Agent): void {
    if (this.depth === 0) this.#inbox.handover(next.#inbox)
  }

  /** Notices announced (expectNotice) and not yet delivered or cancelled. */
  get expectedNotices(): number {
    return this.#inbox.expected
  }

  /** Delivered notices that have not reached the model yet. */
  get waitingNotices(): number {
    return this.#inbox.waiting
  }

  /**
   * Takes the delivered notices that have not reached the model, so they are never sent: for
   * an owner that ends the session, to report them.
   */
  takeNotices(): UserMessage[] {
    return this.#inbox.take()
  }

  /**
   * Starts a turn with the delivered notices waiting, if any and the session is idle; for
   * owners that passed `onIdleNotice`. Returns the turn, or undefined when none started.
   */
  wake(): Promise<TurnResult> | undefined {
    return this.#inbox.wake()
  }

  /** The turn running now, if any: settles with its result. */
  get currentTurn(): Promise<TurnResult> | undefined {
    return this.#current
  }

  /** When held notices are sent again after a failed turn, if they will be. */
  get noticeRetry(): { attempt: number; at: number } | undefined {
    return this.#inbox.retry
  }

  /** Stops a scheduled resend of held notices, e.g. when the session is left (/clear, quit). */
  cancelNoticeRetry(): void {
    this.#inbox.cancelRetry()
  }

  /** Notes a sub-agent in this session's file, so its branch points at the child's session. */
  recordSubagent(childSessionId: string, role: string | undefined, title?: string): void {
    this.#history.store({ type: "subagent", childSessionId, role: role ?? "", ...(title ? { title } : {}) })
  }

  /**
   * The tool session one call gets: sub-agents it spawns carry the call's id, so frontends
   * show them under that call without guessing.
   */
  #callSession(turn: Turn, toolCallId: string): ToolSession {
    const tree = this.tree
    return callToolSession(
      this.#toolSession,
      this.#approvals,
      turn,
      toolCallId,
      tree ? (o) => tree.createGroup(this, o, { toolCallId }) : undefined,
    )
  }

  /** Offers deferred tools to the model from its next call on, e.g. when restoring a session. */
  loadTools(names: string[]): string[] {
    return this.#toolSession.loadTools(names)
  }

  get loadedTools(): string[] {
    return [...this.#loadedTools]
  }

  /**
   * The session entry `message` (one of `messages`) was stored as; for a compaction's summary
   * that is the compaction entry. Undefined without a session file or for an unknown message.
   */
  entryId(message: Message): string | undefined {
    return this.#history.entryId(message)
  }

  /**
   * Why and how the compaction whose summary `message` is happened (its user message; see
   * isSummaryMessage). Undefined for other messages and for compactions stored without it.
   */
  compactionInfo(message: Message): CompactionInfo | undefined {
    return this.#history.compactionInfo(message)
  }

  get status(): SessionStatus {
    return this.#status
  }

  /** The system prompt before system.build interceptors run. Setting it replaces every section. */
  get systemPrompt(): string {
    return renderPrompt(this.#sections)
  }

  set systemPrompt(text: string) {
    this.#sections = [{ name: "identity", text }]
  }

  get sections(): readonly PromptSection[] {
    return this.#sections
  }

  /** Whether this agent's system prompt tells it to decide without asking a user. */
  get nonInteractive(): boolean {
    return this.#sections.some((s) => s.text.includes(NON_INTERACTIVE_LINE))
  }

  /** Marks this agent and fresh children as non-interactive. */
  setNonInteractive(): void {
    this.#sections = addNonInteractive(this.#sections)
  }

  /** Replaces one section of the system prompt, leaving the others untouched. */
  setSection(name: string, text: string): void {
    this.#sections = setSection(this.#sections, name, text)
  }

  /** Switches models for later model calls and records the change in the session (D59). */
  setModel(model: ModelInfo): void {
    const from = modelRef(this.model)
    this.model = model
    if (from.provider === model.provider && from.model === model.id) return
    // The floor was measured against the old model's window.
    this.#compactor.modelChanged()
    if (!isNoModel(model)) this.#history.store({ type: "model_change", model: modelRef(model) })
    this.#emit(undefined, "model.changed", { from, to: modelRef(model) })
  }

  /**
   * Summarizes older history now, keeping recent turns verbatim; `instructions` steer the
   * summary. Resolves false when there was nothing to compact or compaction failed (see
   * compact.failed). Messages sent meanwhile (prompt or steer) start a turn once it ends, also
   * when it failed. An abort drops them, as it drops a turn's steering: each gets a turn.steer
   * `dropped` and a waiting prompt() rejects with AgentAbortedError.
   */
  async compact(instructions?: string): Promise<boolean> {
    return this.hold(
      "compaction",
      async (signal) => (await this.#compactor.compact("manual", signal, undefined, instructions)) === true,
    )
  }

  /**
   * Runs `work` with the session held, as during a manual compaction (busy, but no turn):
   * prompts, steers and notices sent meanwhile wait, and start one turn once it ends; an abort
   * drops the prompts and steers. For work no turn may overlap, such as /reload replacing the
   * tools. `what` names it (holdingFor).
   */
  hold<T>(what: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.#hold.run(what, work)
  }

  /** What holds the session while it is busy without a turn ("compaction", "reload"), if anything. */
  get holdingFor(): string | undefined {
    return this.#hold.what
  }

  /** Tokens the context held at the last reply; unknown before one and right after a compaction. */
  get contextTokens(): number | undefined {
    return this.#contextManager.tokens
  }

  /**
   * What the next model call would send: the system prompt and history after the system.build
   * and context.build interceptors, and the tools offered. Throws when context.build blocks.
   */
  async preview(signal: AbortSignal = new AbortController().signal): Promise<{
    systemPrompt: string
    messages: Message[]
    tools: ToolSpec[]
  }> {
    const built = await this.#buildContext(signal)
    if (built.blocked) throw new Error(`context.build blocked the request: ${built.reason}`)
    return {
      systemPrompt: built.value.systemPrompt,
      // As sent: the ai client drops what only frontends read.
      messages: modelMessages(built.value.messages),
      tools: this.#offeredTools(),
    }
  }

  /** When and with which model this agent compacts. */
  get compaction(): Readonly<CompactionOptions> {
    return this.#compaction
  }

  /** Context management options (settings `context`). */
  get context(): Readonly<ContextOptions> {
    return this.#context
  }

  /** How tool results are sent instead of their content, by message (see AgentOptions.views). */
  get contextViews(): ReadonlyMap<Message, ContextView> {
    return this.#history.views
  }

  /**
   * The history as requests carry it (before the context.build interceptors): for anything
   * that sends this session's conversation on its own, such as a consultation of its model.
   */
  projectedMessages(): Message[] {
    return this.#history.project()
  }

  /** Whether this text is in the context the model sees now: not compacted or aged away. */
  contextHas(text: string): boolean {
    return this.projectedMessages().some((message) =>
      message.content.some((block) => block.type === "text" && block.text.includes(text)),
    )
  }

  /**
   * This session's artifacts by how they are referenced: "active" ones the context the model
   * sees mentions, "inactive" ones only history it no longer sees mentions (compacted, rewound
   * away, a sub-agent's), "unused" ones nothing mentions.
   */
  artifactUsage(): ArtifactUsage {
    return summarizeArtifactUsage(discoverArtifactGroups(this.#artifactSession()))
  }

  #artifactSession(): ArtifactSession {
    const agent = this
    return {
      get sessionId() {
        return agent.sessionId
      },
      get artifacts() {
        return agent.artifacts
      },
      get session() {
        return agent.session
      },
      get messages() {
        return agent.messages
      },
      projectedMessages: () => agent.projectedMessages(),
      get children() {
        return agent.tree?.children ?? []
      },
      subagent: (id) => agent.tree?.subagent(id),
    }
  }

  /**
   * Deletes artifacts on request (/prune): "unused" ones, "inactive" ones too, or "all".
   * Their metadata stays, so reading one says it was pruned.
   */
  pruneArtifacts(scope: ArtifactScope): Promise<{ removed: number; bytes: number }> {
    return pruneArtifacts(this.#artifactSession(), scope)
  }

  /** Most tool calls this agent runs at once. */
  get maxParallelTools(): number {
    return this.#maxParallelTools
  }

  /** True while a turn or a manual compaction runs; a compaction has no turn id. */
  get busy(): boolean {
    return this.#turnState.abort !== undefined
  }

  /** Id of the running turn, if any. */
  get turnId(): string | undefined {
    return this.#turnState.turn?.id
  }

  /** Announces the session to subscribers. Frontends call this once they are listening. */
  start(
    reason: EventMap["session.start"]["reason"],
    extra: Pick<EventMap["session.start"], "sessionFile" | "resume"> = {},
  ): void {
    // A cleared session starts empty, whatever this agent held.
    const context =
      this.#contextManager.tokens !== undefined && reason !== "clear"
        ? { contextTokens: this.#contextManager.tokens, contextWindow: this.model.contextWindow }
        : {}
    this.bus.emit(
      "session.start",
      {
        ...extra,
        ...context,
        reason,
        cwd: this.cwd,
        ...(this.session?.title ? { title: this.session.title } : {}),
        model: modelRef(this.model),
      },
      {
        sessionId: this.sessionId,
        ...(this.parentSessionId ? { parentSessionId: this.parentSessionId } : {}),
      },
    )
  }

  /** Aborts the running turn, if any. The turn still ends with a turn.end event. */
  abort(): void {
    this.#turnState.abort?.abort()
  }

  /** Ends this agent and all of its owned resources. Safe to call more than once. */
  dispose(reason: EventMap["session.end"]["reason"] = "exit"): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise
    this.#disposed = true
    if (this.tree) scopeAdmission(this.tree).closeParent(this.sessionId)
    this.#disposePromise = this.#dispose(reason)
    return this.#disposePromise
  }

  async #dispose(reason: EventMap["session.end"]["reason"]): Promise<void> {
    this.#inbox.cancelRetry()
    this.#turnState.abort?.abort()
    this.#turnState.steerAbort?.abort()
    ;(this.backgroundJobs as { dispose?: () => void } | undefined)?.dispose?.()
    this.#turnState.steering.splice(0)
    this.#inbox.clear()
    // Messages held for a running hold are dropped as an abort of it drops them.
    this.#hold.cancel()
    // A sub-agent's end is subagent.end; session.end means the conversation itself ended.
    if (this.depth === 0) this.#emit(undefined, "session.end", { reason })
    if (this.depth === 0) this.tree?.abortAll("the session ended")
    else this.tree?.abortChildren(this.sessionId, "the session ended")
    const current = this.#current
    if (current) await current.catch(() => {})
    await this.#ownedTools.current?.catch(() => {})
    await this.#ownedTools.drain()
    await this.tree?.waitForChildren(this.depth === 0 ? undefined : this.sessionId)

    // Never rejects: a job that fails to stop here still ends with the process.
    const jobs = this.backgroundJobsHost
    if (jobs && this.depth > 0) await jobs.closeSession(this.sessionId).catch(() => {})
    else if (jobs && reason !== "switch") await jobs.closeRoot(this.sessionId).catch(() => {})
    this.#releaseSessionLease?.()
    this.#releaseSessionLease = undefined
  }

  /**
   * Steers before the next call (D29); notice ownership preserves persistent-child admission.
   * Idle input starts a turn; compaction holds input until the next turn.
   */
  steer(input: string | UserMessage, opts?: { notice?: boolean }): void {
    if (this.#disposed) return
    const message = typeof input === "string" ? userMessage(input) : input
    const turn = this.#turnState.turn
    if (!turn && this.#hold.what) {
      this.#hold.steer(message)
      return
    }
    if (!turn) {
      this.prompt(message).catch(() => {})
      return
    }
    this.#turnState.steerAbort?.abort()
    if (opts?.notice) this.#inbox.receive(message)
    else {
      this.#turnState.steering.push(message)
      this.#emit(turn, "turn.steer", { message, state: "queued" })
    }
  }

  /**
   * Runs one turn. Everything up to the turn.start event happens synchronously, so once this
   * returns the turn is running and `turnId` is set. During a manual compaction the turn
   * starts when the compaction ends, together with anything steered meanwhile.
   */
  prompt(input: string | UserMessage, opts: PromptOptions = {}): Promise<TurnResult> {
    if (this.#disposed) return Promise.reject(new AgentAbortedError("the session has ended"))
    if (this.#hold.what && !this.#hold.prompted) {
      const user = typeof input === "string" ? userMessage(input) : input
      return this.#hold.prompt(user, opts.turnId)
    }
    const turn = this.#turnRunner.run(input, opts)
    this.#current = turn
    const clear = () => {
      if (this.#current === turn) this.#current = undefined
    }
    turn.then(clear, clear)
    return turn
  }

  /** Why this model cannot use a registered tool, independent of explicit disabled tools. */
  toolRestriction(tool: ToolDefinition): string | undefined {
    return modelToolRestriction(tool, this.model, this.providerSettings)
  }

  #allowsTool(tool: ToolDefinition): boolean {
    return this.toolRestriction(tool) === undefined
  }

  #offeredTools() {
    return offeredTools(this.tools, this.#loadedTools, (tool) => this.#allowsTool(tool))
  }

  /** The system prompt and history for a model call, through the system.build and context.build interceptors. */
  async #buildContext(signal: AbortSignal) {
    return buildContext({
      sections: this.#sections,
      offeredDeferred: () => offeredDeferredTools(this.tools, (tool) => this.#allowsTool(tool)),
      messages: () => this.messages,
      views: () => this.#history.views,
      interceptors: this.interceptors,
      sessionId: this.sessionId,
      signal,
    })
  }

  /** Drops restored tools that are gone (e.g. an MCP server removed since), with a note. */
  #checkRestoredTools() {
    checkRestoredTools(this, this.#loadedTools, this.#restoredTools)
    this.#restoredTools = undefined
  }

  /**
   * Who answers this session's permission questions, for its sub-agents to ask the same: the
   * tree's user (Permissions.approver), else the one handed down from the top-level session,
   * else a top-level session's own approver.
   */
  get permissionApprover(): Approver | undefined {
    return this.#approvals.permissionApprover
  }

  /**
   * Puts questions to whoever answers for this session (the `ask` option): for a commander
   * passing on its sub-agent's questions. Says so when nobody can answer here.
   */
  askQuestions(request: AskRequest, signal: AbortSignal): Promise<AskOutcome> {
    return this.#approvals.askQuestions(request, signal)
  }

  /**
   * The history a compaction's summary message (the user message of the pair) stands for, if
   * it can still be found: for agents forked from this one (AgentOptions.originals).
   */
  compactedHistory(summary: Message): Message[] | undefined {
    return this.#compactor.compactedHistory(summary)
  }

  /** What this session's compactions cost, one entry each (SessionControl.compactions). */
  get compactionUsage(): CompactionUsage[] {
    return this.#compactor.usage
  }

  #setStatus(turn: Turn, status: SessionStatus, reason?: string) {
    if (status === this.#status && reason === undefined) return
    this.#status = status
    this.#emit(turn, "status.changed", { status, ...(reason !== undefined ? { reason } : {}) })
  }

  #emit<K extends keyof EventMap>(turn: Turn | undefined, type: K, data: EventMap[K]) {
    const meta: EmitMeta = { sessionId: this.sessionId, ...(turn ? { turnId: turn.id } : {}) }
    if (this.parentSessionId) meta.parentSessionId = this.parentSessionId
    this.bus.emit(type, data, meta)
  }
}
