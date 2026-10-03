import path from "node:path"
import {
  type Ai,
  type AssistantMessage,
  describeModelError,
  isContextOverflow,
  isNoModel,
  type Message,
  type ModelError,
  type ModelInfo,
  modelMessages,
  type ToolCallBlock,
  type ToolSpec,
  type UserMessage,
  userMessage,
} from "@amira/ai"
import type {
  AskOutcome,
  AskQuestion,
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
  SpawnGroupOptions,
  SpawnOptions,
  ToolDefinition,
  ToolSession,
} from "@amira/api"
import { ApprovalGate } from "./agent/approvals.ts"
import {
  type ArtifactUsageGroupInput,
  activeArtifactIds,
  artifactIdsToPrune,
  buildArtifactUsageGroups,
  type ManagedArtifactGroup,
  summarizeArtifactUsage,
} from "./agent/artifact-usage.ts"
import { Compactor } from "./agent/compactor.ts"
import {
  buildContext,
  toolRestriction as modelToolRestriction,
  offeredDeferredTools,
  offeredTools,
} from "./agent/context-builder.ts"
import { ContextManager } from "./agent/context-manager.ts"
import { History, keptHistoryViews } from "./agent/history.ts"
import { joinMessages, modelRef } from "./agent/messages.ts"
import { modelCall, Thinking } from "./agent/model-call.ts"
import { NoticeInbox } from "./agent/notices.ts"
import { ToolRunner } from "./agent/tool-runner.ts"
import {
  AgentAbortedError,
  AgentBusyError,
  type AgentOptions,
  type Approver,
  NOTICE_RETRY_MS,
  newTurnId,
  type PromptOptions,
  type Turn,
  type TurnResult,
} from "./agent/types.ts"
import {
  type ArtifactScope,
  ArtifactStore,
  type ArtifactUsage,
  artifactDir,
  referencedArtifacts,
  subagentSessionFiles,
} from "./artifacts.ts"

export {
  AgentAbortedError,
  AgentBusyError,
  type AgentOptions,
  type ApprovalDecision,
  type Approver,
  type Asker,
  NOTICE_RETRY_MS,
  newTurnId,
  type PromptOptions,
  type TurnResult,
} from "./agent/types.ts"

import { type CompactionOptions, contextTokens } from "./compaction.ts"
import type { ContextOptions, ContextView } from "./context.ts"
import { createToolSession } from "./deferred-tools.ts"
import { type EmitMeta, EventBus } from "./event-bus.ts"
import { FILE_REWIND_COVERAGE, FileRewind } from "./file-rewind.ts"
import { InterceptorRegistry } from "./interceptors.ts"
import { Permissions } from "./permissions/policy.ts"
import {
  addNonInteractive,
  NON_INTERACTIVE_LINE,
  type PromptSection,
  renderPrompt,
  setSection,
} from "./prompt.ts"
import { newSessionId, SessionStore } from "./session-store.ts"
import { PauseGate } from "./subagents/pause.ts"
import type { AgentTree } from "./subagents.ts"
import { resolveToolName } from "./tool-names.ts"
import { ToolRegistry } from "./tool-registry.ts"

/** The turn that starts once a manual compaction ends, from what was sent meanwhile. */
interface AfterCompaction {
  /** In the order they were sent; `steered` ones came through steer(). */
  messages: { message: UserMessage; steered: boolean }[]
  /** The id a prompt() call asked for. */
  turnId?: string
  /** A prompt() call is waiting; a second one is refused as busy. */
  prompted: boolean
  waiters: { resolve: (r: TurnResult) => void; reject: (err: unknown) => void }[]
}

type ModelReply =
  | { kind: "ok"; message: AssistantMessage }
  | { kind: "error"; error: string; model?: ModelError }
  | { kind: "aborted" }

/** One agent session: a conversation, a model and the loop that drives tool use. */
export class Agent {
  readonly sessionId: string
  readonly parentSessionId: string | undefined
  readonly bus: EventBus
  readonly interceptors: InterceptorRegistry
  readonly tools: ToolRegistry
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

  #ai: Ai
  #approvals: ApprovalGate
  #toolRunner: ToolRunner
  #history: History
  #contextManager: ContextManager
  #compactor: Compactor
  #status: SessionStatus = "idle"
  #abort: AbortController | undefined
  #maxSteps: number
  #maxTokens: number | undefined
  #abortGraceMs: number
  #sections: PromptSection[]
  #compaction: CompactionOptions
  #context: ContextOptions
  /** This session's saved tool outputs (A1). */
  readonly artifacts: ArtifactStore
  #maxParallelTools: number
  /** Deferred tools this session loaded (via tool_search), in load order. */
  #loadedTools = new Set<string>()
  readonly providerSettings: Record<string, ProviderSettings>
  /** The effort for each model, with the /thinking override; new sub-agents inherit it. */
  readonly thinking: Thinking
  /**
   * Loaded tools restored from the session file, checked at the first model call: by then
   * system.build has waited for tools that register late (MCP servers).
   */
  #restoredTools: string[] | undefined
  #toolSession: ToolSession
  #turn: Turn | undefined
  /** Steering messages waiting for the next model call of the running turn. */
  #steering: UserMessage[] = []
  /** Aborts waits that can return partial output as soon as steering arrives. */
  #steerAbort: AbortController | undefined
  #inbox: NoticeInbox
  /**
   * What holds the session (busy, but no turn): "compaction" during a manual compaction, or
   * the work hold() runs, e.g. "reload".
   */
  #holding: string | undefined
  /** Messages sent during a manual compaction; they start one turn when it ends. */
  #afterCompaction: AfterCompaction | undefined
  #onIdleNotice: (() => void) | undefined
  #endTurn: (() => boolean) | undefined
  /** The running turn's promise, for owners that wait for whatever turn runs. */
  #current: Promise<TurnResult> | undefined
  #disposePromise: Promise<void> | undefined
  #disposed = false
  #sessionLease = false

  /**
   * Records extensions keep in this session (SessionData): custom entries of its file, or
   * kept in memory when it has none.
   */
  readonly data: SessionData

  constructor(opts: AgentOptions) {
    this.session = opts.session
    this.depth = opts.depth ?? 0
    if (this.session && this.depth === 0 && !opts.parentSessionId) this.#sessionLease = this.session.claim()
    this.fileRewindSettings = opts.fileRewindSettings
    this.fileRewind =
      opts.fileRewind ?? (opts.session ? new FileRewind(opts.session, opts.fileRewindSettings) : undefined)
    let recovered: ReturnType<FileRewind["recover"]>
    let unrecovered: string | undefined
    try {
      recovered = !opts.fileRewind ? this.fileRewind?.recover() : undefined
    } catch (error) {
      // The session must still open: the user resolves the conflicts or abandons the restore.
      unrecovered = (error as Error).message
    }
    this.sessionId = opts.session?.id ?? opts.sessionId ?? newSessionId()
    this.parentSessionId = opts.parentSessionId
    this.backgroundJobsHost = opts.backgroundJobs
    this.bus = opts.bus ?? new EventBus()
    if (recovered || unrecovered) {
      this.bus.emit(
        "extension.notice",
        {
          source: "file-rewind",
          level: recovered ? "info" : "warning",
          text: recovered
            ? `Finished interrupted file restore: ${recovered.restored} restored, ${recovered.removed} removed. ${FILE_REWIND_COVERAGE}`
            : `An interrupted file restore could not finish, and file tools cannot write until it does. ${unrecovered}\nResolve the conflicts and rewind to the same message with files, or rewind the conversation only to abandon it.`,
        },
        { sessionId: this.sessionId },
      )
    }
    this.interceptors = opts.interceptors ?? new InterceptorRegistry()
    this.tools = opts.tools ?? new ToolRegistry()
    this.permissions = opts.permissions ?? new Permissions()
    this.cwd = opts.cwd
    this.model = opts.model
    this.providerSettings = opts.providerSettings ?? {}
    this.thinking = new Thinking(opts, (data) => this.#emit(undefined, "thinking.changed", data))
    this.#sections = opts.sections ?? [{ name: "identity", text: opts.systemPrompt ?? "" }]
    this.#compaction = opts.compaction ?? {}
    this.#context = opts.context ?? {}
    this.#ai = opts.ai
    this.#maxSteps = opts.maxSteps ?? 200
    this.#maxTokens = opts.maxTokens
    this.#abortGraceMs = opts.abortGraceMs ?? 2000
    const retryMs = opts.noticeRetryMs ?? NOTICE_RETRY_MS
    this.#maxParallelTools = Math.max(1, opts.maxParallelTools ?? 8)
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
      isCurrentTurn: (turn) => this.#turn === turn,
      blocked: (turn, reason, pending) => {
        this.#status = "blocked"
        this.#emit(turn, "status.changed", { status: "blocked", reason, pending })
      },
      working: (turn) => this.#setStatus(turn, "working"),
    })
    this.#toolRunner = new ToolRunner({
      tools: this.tools,
      interceptors: this.interceptors,
      permissions: this.permissions,
      approvals: this.#approvals,
      cwd: this.cwd,
      sessionId: this.sessionId,
      maxParallelTools: this.#maxParallelTools,
      abortGraceMs: this.#abortGraceMs,
      fileRewind: this.fileRewind,
      backgroundJobs: this.backgroundJobs,
      allowsTool: (tool) => this.#allowsTool(tool),
      steerSignal: () => this.#steerAbort?.signal,
      storeFailed: () => this.#history.storeFailed,
      callSession: (turn, toolCallId) => this.#callSession(turn, toolCallId),
      keepLarge: (call, result) => this.#contextManager.keepLarge(call, result),
      interruptTurn: (turn) => {
        if (this.#turn === turn) this.#abort?.abort()
      },
      emit: (turn, type, data) => this.#emit(turn, type, data),
    })
    this.#onIdleNotice = opts.onIdleNotice
    this.#inbox = new NoticeInbox({
      retryMs,
      disposed: () => this.#disposed,
      turn: () => this.#turn,
      holding: () => this.#holding,
      busy: () => this.#abort !== undefined,
      onIdleNotice: this.#onIdleNotice?.bind(this),
      prompt: (message) => this.prompt(message),
      emit: (turn, type, data) => this.#emit(turn, type, data),
    })
    this.#endTurn = opts.endTurn

    let history: ConstructorParameters<typeof History>[1]
    let tokens: number | undefined
    if (opts.messages || !opts.session) {
      const messages = opts.messages ?? []
      // An interrupted reply may carry no usage counted; the one before it tells the context.
      const last = messages.findLast(
        (m) => m.role === "assistant" && m.usage && contextTokens(m.usage) > 0,
      ) as AssistantMessage | undefined
      if (last?.usage) tokens = contextTokens(last.usage)
      history = { messages, views: keptHistoryViews(messages, opts.views) }
    } else {
      const restored = opts.session.restore()
      history = restored
      tokens = restored.contextTokens
      for (const name of restored.loadedTools) this.#loadedTools.add(name)
      if (restored.loadedTools.length) this.#restoredTools = restored.loadedTools
    }
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
    this.data = this.#history.data
    // A session forked from another (beside it) still finds the artifacts its copied history names.
    const forkedFrom = opts.session?.header.parent
    const outputsParent =
      opts.outputsParent ??
      (forkedFrom && opts.session
        ? new ArtifactStore({
            dir: artifactDir(path.join(path.dirname(opts.session.file), `${forkedFrom}.jsonl`), forkedFrom),
            sessionId: forkedFrom,
          })
        : undefined)
    this.artifacts = new ArtifactStore({
      dir: artifactDir(opts.session?.file, this.sessionId),
      sessionId: this.sessionId,
      limits: {
        ...(this.#context.saveAbove !== undefined ? { saveAbove: this.#context.saveAbove } : {}),
        ...(this.#context.previewChars !== undefined ? { previewChars: this.#context.previewChars } : {}),
      },
      ...(this.#context.quotaBytes !== undefined ? { quotaBytes: this.#context.quotaBytes } : {}),
      ...(outputsParent ? { parent: outputsParent } : {}),
    })
    this.#contextManager = new ContextManager(
      {
        history: this.#history,
        artifacts: this.artifacts,
        tools: this.tools,
        toolFor: (call) => this.#toolRunner.toolFor(call),
        cwd: this.cwd,
        options: this.#context,
        model: () => this.model,
        replayTarget: () => this.#ai.replayTarget(this.model),
        fixedChars: () => renderPrompt(this.#sections).length + JSON.stringify(this.#offeredTools()).length,
        emit: (turn, type, data) => this.#emit(turn, type, data),
      },
      { contextTokens: tokens },
    )
    this.#compactor = new Compactor({
      ai: this.#ai,
      model: () => this.model,
      options: this.#compaction,
      history: this.#history,
      context: this.#contextManager,
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
    })
    const stored = opts.session?.model()
    // NO_MODEL is a placeholder until one is picked, not a model the session ran on.
    const changed = stored?.provider !== this.model.provider || stored.model !== this.model.id
    if (opts.session && changed && !isNoModel(this.model)) {
      this.#history.store({ type: "model_change", model: modelRef(this.model) })
    }
    const agent = this
    const tree = opts.tree
    const deferred = createToolSession(this.sessionId, this.tools, this.#loadedTools, (t) =>
      this.#allowsTool(t),
    )
    this.#toolSession = {
      ...deferred,
      ...(opts.session ? { dir: opts.session.file.replace(/\.jsonl$/, "") } : {}),
      data: this.data,
      outputs: this.artifacts,
      contextHas: (text) => agent.contextHas(text),
      // Recorded in the session, so resuming it offers the same tools again.
      loadTools: (names) => {
        const added = deferred.loadTools(names)
        if (added.length) this.#history.store({ type: "tools_loaded", names: added })
        return added
      },
      depth: this.depth,
      get maxDepth() {
        return tree?.maxDepth ?? 0
      },
      get model() {
        return modelRef(agent.model)
      },
      ...(tree
        ? {
            spawn: (o: SpawnOptions) => tree.spawn(agent, o),
            createGroup: (o: SpawnGroupOptions) => tree.createGroup(agent, o),
            groups: () => tree.groups(),
          }
        : {}),
      // A sub-agent's life is one turn, and nothing may wake it afterwards, unless it is
      // persistent (its owner wakes it for the notices it gets).
      ...(this.depth === 0 || this.#onIdleNotice
        ? {
            expectNotice: () => agent.#inbox.target().expect(),
          }
        : {}),
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
    const base = this.#toolSession
    const spawn = base.spawn
    const tree = this.tree
    const props: PropertyDescriptorMap = {
      ...(this.#approvals.hasAsker
        ? {
            askUser: {
              value: (questions: AskQuestion[], signal?: AbortSignal) =>
                this.#approvals.askFromTool(turn, toolCallId, questions, signal),
              enumerable: true,
            },
          }
        : {}),
    }
    if (spawn && tree) {
      props.spawn = {
        value: (o: SpawnOptions) => spawn({ ...o, toolCallId: o.toolCallId ?? toolCallId }),
        enumerable: true,
      }
      props.createGroup = {
        value: (o: SpawnGroupOptions) => tree.createGroup(this, o, { toolCallId }),
        enumerable: true,
      }
    }
    return Object.keys(props).length ? (Object.create(base, props) as ToolSession) : base
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
  async hold<T>(what: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#abort) throw new AgentBusyError("a turn or compaction is already running")
    const abort = new AbortController()
    this.#abort = abort
    this.#holding = what
    try {
      return await work(abort.signal)
    } finally {
      this.#abort = undefined
      this.#holding = undefined
      const noticed = this.#inbox.takeNoticedDuringHold()
      // Held prompts and steers start their turn (an abort drops them); notices that came
      // meanwhile join it before its first model call. Notices are never dropped: without such
      // a turn they start one, unless the work was aborted: then they wait for the next.
      this.#startAfterCompaction(abort.signal.aborted, what)
      if (noticed && !abort.signal.aborted) this.#inbox.wakeQuietly()
    }
  }

  /** What holds the session while it is busy without a turn ("compaction", "reload"), if anything. */
  get holdingFor(): string | undefined {
    return this.#holding
  }

  /** Holds a message sent during a manual compaction for the turn that follows it. */
  #holdForCompaction(message: UserMessage, steered: boolean, turnId?: string): AfterCompaction {
    this.#afterCompaction ??= { messages: [], prompted: false, waiters: [] }
    const next = this.#afterCompaction
    next.messages.push({ message, steered })
    if (turnId !== undefined) next.turnId = turnId
    return next
  }

  /** Starts the turn held during a manual compaction, if anything was sent meanwhile. */
  #startAfterCompaction(aborted: boolean, what: string) {
    const next = this.#afterCompaction
    this.#afterCompaction = undefined
    if (!next) return
    if (aborted) {
      for (const { message } of next.messages)
        this.#emit(undefined, "turn.steer", { message, state: "dropped" })
      const err = new AgentAbortedError(`the ${what} was aborted before the message was sent`)
      for (const w of next.waiters) w.reject(err)
      return
    }
    const turnId = next.turnId ?? newTurnId()
    for (const { message, steered } of next.messages) {
      if (steered) this.#emit(undefined, "turn.steer", { message, state: "promoted", nextTurnId: turnId })
    }
    const [only, ...more] = next.messages
    const prompt: UserMessage =
      only && !more.length
        ? only.message
        : { role: "user", content: next.messages.flatMap((m) => m.message.content) }
    this.prompt(prompt, { turnId }).then(
      (r) => {
        for (const w of next.waiters) w.resolve(r)
      },
      (err) => {
        for (const w of next.waiters) w.reject(err)
      },
    )
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
    return summarizeArtifactUsage(this.#artifactGroups())
  }

  /** Builds the parent and sub-agent stores with one consistent reference snapshot. */
  #artifactGroups(): ManagedArtifactGroup[] {
    const initiallyActive = activeArtifactIds([this.messages, this.projectedMessages()])
    const referenced = this.session ? referencedArtifacts(this.session) : initiallyActive
    const labels = new Map<string, string>()
    const rememberLabels = (entries: readonly object[]) => {
      for (const e of entries) {
        if ((e as { type?: unknown }).type !== "subagent") continue
        const id = (e as { childSessionId?: unknown }).childSessionId
        if (typeof id !== "string") continue
        const role = (e as { role?: unknown }).role
        const title = (e as { title?: unknown }).title
        labels.set(
          id,
          `Sub-agent: ${typeof title === "string" && title ? title : typeof role === "string" && role ? role : id} (${id})`,
        )
      }
    }
    const files = this.session ? subagentSessionFiles(this.session) : []
    if (this.session) {
      rememberLabels(this.session.entries)
      for (const child of files) rememberLabels(child.entries)
    }
    const live = new Set(this.tree?.children.map((child) => child.id) ?? [])
    for (const child of this.tree?.children ?? [])
      labels.set(child.id, `Sub-agent: ${child.title} (${child.id})`)
    const childMessages: (readonly Message[])[] = []
    for (const child of files) {
      const known = this.tree?.subagent(child.id)
      if (known?.messages) childMessages.push(known.messages)
      else {
        try {
          childMessages.push(SessionStore.open(child.file).restore().messages)
        } catch {
          // A torn or foreign child file has no current context to classify as active.
        }
      }
    }

    const active = new Set(initiallyActive)
    for (const id of activeArtifactIds(childMessages)) active.add(id)
    const inputs: ArtifactUsageGroupInput[] = [
      {
        store: this.artifacts,
        artifacts: this.artifacts.list(),
        id: this.sessionId,
        label: "This session",
        protectedStore: live.size > 0,
      },
    ]
    for (const child of files) {
      const store = new ArtifactStore({
        dir: artifactDir(child.file, child.id),
        sessionId: child.id,
        limits: this.artifacts.limits,
        quotaBytes: this.artifacts.quotaBytes,
      })
      inputs.push({
        store,
        artifacts: store.list(),
        id: child.id,
        label: labels.get(child.id) ?? `Sub-agent: ${child.id} (${child.id})`,
        protectedStore: live.has(child.id),
      })
    }
    return buildArtifactUsageGroups(active, referenced, inputs)
  }

  /**
   * Deletes artifacts on request (/prune): "unused" ones, "inactive" ones too, or "all".
   * Their metadata stays, so reading one says it was pruned.
   */
  async pruneArtifacts(scope: ArtifactScope): Promise<{ removed: number; bytes: number }> {
    if (this.tree?.children.length) {
      throw new Error(
        "cannot prune artifacts while a sub-agent is running, queued or idle; wait for it to finish or stop it (/agents stop)",
      )
    }
    let removed = 0
    let bytes = 0
    for (const { group, ids } of artifactIdsToPrune(this.#artifactGroups(), scope)) {
      const result = await group.store.prune(ids)
      removed += result.removed
      bytes += result.bytes
    }
    return { removed, bytes }
  }

  /** Most tool calls this agent runs at once. */
  get maxParallelTools(): number {
    return this.#maxParallelTools
  }

  /** True while a turn or a manual compaction runs; a compaction has no turn id. */
  get busy(): boolean {
    return this.#abort !== undefined
  }

  /** Id of the running turn, if any. */
  get turnId(): string | undefined {
    return this.#turn?.id
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
        model: { provider: this.model.provider, model: this.model.id },
      },
      {
        sessionId: this.sessionId,
        ...(this.parentSessionId ? { parentSessionId: this.parentSessionId } : {}),
      },
    )
  }

  /** Aborts the running turn, if any. The turn still ends with a turn.end event. */
  abort(): void {
    this.#abort?.abort()
  }

  /** Ends this agent and all of its owned resources. Safe to call more than once. */
  dispose(reason: EventMap["session.end"]["reason"] = "exit"): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise
    this.#disposed = true
    this.#disposePromise = this.#dispose(reason)
    return this.#disposePromise
  }

  async #dispose(reason: EventMap["session.end"]["reason"]): Promise<void> {
    this.#inbox.cancelRetry()
    this.#abort?.abort()
    this.#steerAbort?.abort()
    ;(this.backgroundJobs as { dispose?: () => void } | undefined)?.dispose?.()
    this.#steering.splice(0)
    this.#inbox.clear()
    // Messages held for a running hold are dropped as an abort of it drops them.
    this.#startAfterCompaction(true, this.#holding ?? "session")
    // A sub-agent's end is subagent.end; session.end means the conversation itself ended.
    if (this.depth === 0) this.#emit(undefined, "session.end", { reason })

    if (this.depth === 0) this.tree?.abortAll("the session ended")
    else this.tree?.abortChildren(this.sessionId, "the session ended")
    const current = this.#current
    if (current) await current.catch(() => {})
    await this.tree?.waitForChildren(this.depth === 0 ? undefined : this.sessionId)

    // Never rejects: a job that fails to stop here still ends with the process.
    const jobs = this.backgroundJobsHost
    if (jobs && this.depth > 0) await jobs.closeSession(this.sessionId).catch(() => {})
    else if (jobs && reason !== "switch") await jobs.closeRoot(this.sessionId).catch(() => {})
    if (this.#sessionLease) {
      this.#sessionLease = false
      this.session?.release()
    }
  }

  /**
   * Steers before the next call (D29); notice ownership preserves persistent-child admission.
   * Idle input starts a turn; compaction holds input until the next turn.
   */
  steer(input: string | UserMessage, opts?: { notice?: boolean }): void {
    if (this.#disposed) return
    const message = typeof input === "string" ? userMessage(input) : input
    const turn = this.#turn
    if (!turn && this.#holding) {
      this.#holdForCompaction(message, true)
      this.#emit(undefined, "turn.steer", { message, state: "queued" })
      return
    }
    if (!turn) {
      this.prompt(message).catch(() => {})
      return
    }
    this.#steerAbort?.abort()
    if (opts?.notice) this.#inbox.receive(message)
    else {
      this.#steering.push(message)
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
    if (this.#holding && !this.#afterCompaction?.prompted) {
      const user = typeof input === "string" ? userMessage(input) : input
      const next = this.#holdForCompaction(user, false, opts.turnId)
      next.prompted = true
      return new Promise((resolve, reject) => next.waiters.push({ resolve, reject }))
    }
    const turn = this.#runTurn(input, opts)
    this.#current = turn
    const clear = () => {
      if (this.#current === turn) this.#current = undefined
    }
    turn.then(clear, clear)
    return turn
  }

  async #runTurn(input: string | UserMessage, opts: PromptOptions): Promise<TurnResult> {
    if (this.#abort) throw new AgentBusyError("a turn or compaction is already running")
    const abort = new AbortController()
    this.#abort = abort
    this.#steerAbort = new AbortController()
    const turn: Turn = {
      id: opts.turnId ?? newTurnId(),
      signal: abort.signal,
    }
    this.#turn = turn
    const user = typeof input === "string" ? userMessage(input) : input
    // Whatever starts now takes the held notices along: no retry is needed any more.
    this.#inbox.cancelRetry()
    if (user.display?.origin) turn.unanswered = true

    let steps = 0
    let result: TurnResult = { reason: "done", steps: 0 }
    this.#emit(turn, "turn.start", { prompt: user })
    this.#setStatus(turn, "working")
    try {
      this.#history.push(user)
      let compactFailed = false
      /** A request over the context window is compacted and sent again, once a turn. */
      let overflowRetried = false
      let overflowCompacted: boolean | undefined
      /** A request over the window first gets one aging round (A3), once a turn. */
      let overflowAged = false
      while (true) {
        this.#compactor.noteWindowGuess(turn)
        // Planned synchronously: a turn with nothing to age goes on without waiting.
        const aging = this.#contextManager.age(turn)
        if (aging) await aging
        if (!compactFailed && this.#compactor.needsCompaction()) {
          compactFailed = (await this.#compactor.compact("threshold", abort.signal, turn)) === false
        }
        if (abort.signal.aborted) {
          result = { reason: "aborted", steps }
          break
        }
        if (steps >= this.#maxSteps) {
          result = { reason: "error", steps, error: `stopped after ${this.#maxSteps} model calls` }
          break
        }
        steps++
        this.#injectSteering(turn)
        const reply = await this.#callModel(turn)
        if (this.execution.paused) await this.execution.wait(abort.signal)
        if (reply.kind === "aborted" || (this.execution.paused && abort.signal.aborted)) {
          result = { reason: "aborted", steps }
          break
        }
        if (reply.kind === "error") {
          const overflow = reply.model && isContextOverflow(reply.model)
          if (overflow && !overflowAged) {
            overflowAged = true
            const aging = this.#contextManager.age(turn, true)
            if (aging && (await aging)) continue
          }
          if (overflow && !overflowRetried && this.#compaction.auto !== false) {
            overflowRetried = true
            this.#compactor.noteWindowGuess(turn, true)
            overflowCompacted = await this.#compactor.compact("overflow", abort.signal, turn)
            if (overflowCompacted === true) continue
          }
          const failure = reply.model
            ? describeModelError(reply.model, { provider: this.model.provider })
            : undefined
          // Compacted once already, or nothing could be: the user decides what to leave out.
          if (failure && overflow && overflowRetried) {
            failure.hint =
              overflowCompacted === undefined
                ? "Nothing older to compact: /clear starts over, or /model switches to a model with a larger window"
                : "Run /compact with what to keep, /clear to start over, or /model for a larger window"
          }
          result = { reason: "error", steps, error: reply.error, ...(failure ? { failure } : {}) }
          break
        }
        turn.unanswered = false
        const calls = reply.message.content.filter((b): b is ToolCallBlock => b.type === "toolCall")
        if (calls.length === 0) {
          result = { reason: "done", steps }
          break
        }
        await this.#toolRunner.run(turn, calls, (results) => {
          const views = this.#contextManager.dedupe(results)
          this.#history.push(...results)
          this.#history.storeViews(views)
        })
        if (this.execution.paused) await this.execution.wait(abort.signal)
        if (abort.signal.aborted) {
          result = { reason: "aborted", steps }
          break
        }
        if (this.#endTurn?.()) {
          result = { reason: "done", steps }
          break
        }
      }
    } catch (err) {
      result = { reason: "error", steps, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.#history.repair()
      this.#abort = undefined
      this.#turn = undefined
      this.#steerAbort = undefined
      const leftover = this.#steering.splice(0)
      // Notices are never dropped: after an interrupted or failed turn they wait for the next.
      // An owner that decides when turns run (onIdleNotice) starts the next one itself.
      const notices = result.reason === "done" && !this.#onIdleNotice ? this.#inbox.take() : []
      const nextTurnId =
        result.reason === "done" && (leftover.length || notices.length) ? newTurnId() : undefined
      for (const message of leftover) {
        this.#emit(
          turn,
          "turn.steer",
          nextTurnId ? { message, state: "promoted", nextTurnId } : { message, state: "dropped" },
        )
      }
      if (notices.length && nextTurnId) {
        const message = joinMessages(notices)
        this.#emit(turn, "turn.steer", { message, state: "promoted", nextTurnId })
        leftover.push(message)
      }
      if (result.reason === "error") this.#setStatus(turn, "error", result.error)
      this.#emit(turn, "turn.end", {
        reason: result.reason,
        steps,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.failure ? { failure: result.failure } : {}),
      })
      this.#setStatus(turn, "idle")
      // A success resets the notice retries; after an interrupt the user decides when to go on.
      if (result.reason !== "error") this.#inbox.resetRetries()
      else if (!this.#disposed && (turn.unanswered || this.#inbox.waiting))
        this.#inbox.scheduleRetry(result.error)
      if (nextTurnId && !this.#disposed) {
        this.prompt(joinMessages(leftover), { turnId: nextTurnId }).catch(() => {})
      }
    }
    return result
  }

  #injectSteering(turn: Turn) {
    const notices = this.#inbox.take()
    if (notices.length) turn.unanswered = true
    // The steers reach the model now: later waits in this turn wait again.
    if (this.#steerAbort?.signal.aborted) this.#steerAbort = new AbortController()
    for (const message of [...this.#steering.splice(0), ...(notices.length ? [joinMessages(notices)] : [])]) {
      this.#history.push(message)
      this.#emit(turn, "turn.steer", { message, state: "injected" })
    }
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

  /** Deferred tools this model may load, after its provider and model choices. */
  #offeredDeferred() {
    return offeredDeferredTools(this.tools, (tool) => this.#allowsTool(tool))
  }

  /** The system prompt and history for a model call, through the system.build and context.build interceptors. */
  async #buildContext(signal: AbortSignal) {
    return buildContext({
      sections: this.#sections,
      offeredDeferred: () => this.#offeredDeferred(),
      messages: () => this.messages,
      views: () => this.#history.views,
      interceptors: this.interceptors,
      sessionId: this.sessionId,
      signal,
    })
  }

  /** Rebuilt for a sub-agent's user messages, a few times at most: a stream of them cannot starve the model. */
  async #callModel(turn: Turn): Promise<ModelReply> {
    const unreadable = await this.#compactor.fillSummaries(turn, turn.signal)
    if (turn.signal.aborted) return { kind: "aborted" }
    if (unreadable) return { kind: "error", error: unreadable }
    let ctx = await this.#buildContext(turn.signal)
    for (let rebuilds = 0; ; rebuilds++) {
      if (await this.execution.wait(turn.signal)) return { kind: "aborted" }
      if (this.depth === 0 || rebuilds >= 3 || !(this.#steering.length || this.#inbox.waiting)) break
      this.#injectSteering(turn)
      ctx = await this.#buildContext(turn.signal)
    }
    this.#checkRestoredTools()
    if (turn.signal.aborted) return { kind: "aborted" }
    if (ctx.blocked) return { kind: "error", error: `context.build blocked the request: ${ctx.reason}` }

    const requestModelRef = { provider: this.model.provider, model: this.model.id }
    this.#emit(turn, "message.start", { model: requestModelRef, contextWindow: this.model.contextWindow })
    const call = await modelCall({
      ai: this.#ai,
      model: this.model,
      modelRef: requestModelRef,
      systemPrompt: ctx.value.systemPrompt,
      messages: ctx.value.messages,
      tools: () => this.#offeredTools(),
      maxTokens: this.#maxTokens,
      thinking: this.thinking.for(this.model),
      signal: turn.signal,
      emit: <K extends keyof EventMap>(type: K, data: EventMap[K]) => this.#emit(turn, type, data),
    })
    const { message, aborted, error, modelError } = call
    if (!aborted && !error)
      message.content = message.content.map((b) => (b.type === "toolCall" ? this.#fixToolName(b) : b))
    if (message.content.length) this.#history.push(message)
    // An interrupted reply may end with no usage counted: the context is still what it was.
    if (message.usage && contextTokens(message.usage) > 0)
      this.#compactor.noteContext(contextTokens(message.usage))
    this.#emit(turn, "message.end", { message })
    if (message.usage) this.tree?.recordUsage(this, message.usage)

    if (aborted) return { kind: "aborted" }
    if (error) return { kind: "error", error, ...(modelError ? { model: modelError } : {}) }
    return { kind: "ok", message }
  }

  /** Drops restored tools that are gone (e.g. an MCP server removed since), with a note. */
  #checkRestoredTools() {
    const restored = this.#restoredTools
    if (!restored) return
    this.#restoredTools = undefined
    // Disabled tools stay loaded for later; tools that became active are offered anyway.
    const unavailable = restored.filter((name) => !this.tools.has(name))
    for (const name of restored) {
      const tool = this.tools.get(name)
      if (!this.tools.has(name) || (tool && tool.exposure !== "deferred")) this.#loadedTools.delete(name)
    }
    if (!unavailable.length) return
    const error = `tools loaded earlier in this session are no longer available: ${unavailable.join(", ")}`
    this.bus.emit("extension.error", { source: "session", error }, { sessionId: this.sessionId })
  }

  /** Renames a call to a tool the model misspelled, so history, events and results agree. */
  #fixToolName(call: ToolCallBlock): ToolCallBlock {
    if (this.tools.get(call.name)) return call
    const name = resolveToolName(
      call.name,
      this.tools.active().map((t) => t.name),
    )
    return name ? { ...call, name } : call
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
