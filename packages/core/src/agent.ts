import path from "node:path"
import {
  type Ai,
  type AssistantMessage,
  addUsage,
  type CompactionLayout,
  describeModelError,
  emptyUsage,
  invalidArgs,
  isContextOverflow,
  isNoModel,
  type Message,
  type ModelError,
  type ModelInfo,
  type ModelRef,
  modelMessages,
  type Signature,
  type ToolCallBlock,
  type ToolResultMessage,
  type ToolSpec,
  type Usage,
  type UserMessage,
  unansweredCalls,
  userMessage,
} from "@amira/ai"
import {
  type ApprovalRequest,
  type AskOutcome,
  type AskQuestion,
  type AskRequest,
  artifactIdOf,
  type BackgroundJobHost,
  type BackgroundJobSession,
  type CompactionInfo,
  type CompactionReason,
  type CompactionUsage,
  type EventMap,
  type MutateFiles,
  outputPreview,
  outputSize,
  type PendingNotice,
  type ProviderSettings,
  type SessionData,
  type SessionStatus,
  type Settings,
  type SpawnGroupOptions,
  type SpawnOptions,
  type ToolApproval,
  type ToolDefinition,
  type ToolRejection,
  type ToolResult,
  type ToolSession,
} from "@amira/api"
import {
  type ArtifactUsageGroupInput,
  activeArtifactIds,
  artifactIdsToPrune,
  buildArtifactUsageGroups,
  type ManagedArtifactGroup,
  summarizeArtifactUsage,
} from "./agent/artifact-usage.ts"
import {
  buildContext,
  toolRestriction as modelToolRestriction,
  offeredDeferredTools,
  offeredTools,
} from "./agent/context-builder.ts"
import {
  concurrencyKey,
  copyArgs,
  formatK,
  joinMessages,
  modelRef,
  normalizeResult,
  resultMessage,
  toolError,
} from "./agent/messages.ts"
import { modelCall, type ThinkingFor, thinkingFor } from "./agent/model-call.ts"
import { approvalPermission, askedText, refusedText } from "./agent/permission-text.ts"
import {
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
import {
  type ArtifactScope,
  ArtifactStore,
  type ArtifactUsage,
  artifactDir,
  referencedArtifacts,
  subagentSessionFiles,
} from "./artifacts.ts"

export * from "./agent/types.ts"

import {
  type CompactionOptions,
  checkpointOf,
  contextTokens,
  estimateAfter,
  estimateTokens,
  isSummaryMessage,
  KEEP_USER_TOKENS,
  recentUserMessages,
  SummaryError,
  splitHistory,
  summarize,
  summaryMessages,
  summaryOf,
  windowGuessNotice,
} from "./compaction.ts"
import {
  AGING_DEFAULTS,
  agedStub,
  agingCandidates,
  type ContextOptions,
  type ContextView,
  duplicateView,
  lastSealedIndex,
  pairCalls,
  projectMessages,
  resultText,
  type StoredView,
} from "./context.ts"
import { createToolSession } from "./deferred-tools.ts"
import { type EmitMeta, EventBus } from "./event-bus.ts"
import { FILE_REWIND_COVERAGE, FileRewind } from "./file-rewind.ts"
import { amiraPath } from "./home.ts"
import { InterceptorRegistry } from "./interceptors.ts"
import { Permissions } from "./permissions/policy.ts"
import { writtenPaths } from "./permissions/protected.ts"
import {
  addNonInteractive,
  NON_INTERACTIVE_LINE,
  type PromptSection,
  renderPrompt,
  setSection,
} from "./prompt.ts"
import { newSessionId, type SessionEntryData, SessionStore } from "./session-store.ts"
import type { AgentTree } from "./subagents.ts"
import { resolveToolName } from "./tool-names.ts"
import { ToolRegistry } from "./tool-registry.ts"
import { toolTraits } from "./tool-traits.ts"
import { checkArgs } from "./validate-args.ts"

/** State that belongs to one turn, so late callbacks never leak into the next turn. */
interface Turn {
  id: string
  signal: AbortSignal
  /** Notices joined this turn and no model reply has come since. */
  unanswered?: boolean
}

/**
 * One tool call of a batch. Tracked by the call itself, not its id: providers reuse ids across
 * steps (and some even within one reply), and each call still needs its own events and result.
 */
interface CallRun {
  call: ToolCallBlock
  tool?: ToolDefinition
  writtenPaths?: string[]
  /** tool.execute.start has been emitted. */
  started: boolean
  /** The batch recorded this call's result; later updates and results from it are dropped. */
  finished: boolean
  /** The call has its result (tool.call.after may still be running on it). */
  returned?: boolean
  result?: ToolResultMessage
  /** Who approved it, when it needed approval. */
  approval?: ToolApproval
}

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
  /** The session-scoped background-job capability, when this host provides it. */
  readonly backgroundJobs: BackgroundJobSession | undefined
  /** The host implementation handed to child agents and lifecycle cleanup. */
  readonly backgroundJobsHost: BackgroundJobHost | undefined
  /** The permission policy of this session's tree. */
  readonly permissions: Permissions
  model: ModelInfo

  #ai: Ai
  #approve: Approver | undefined
  #inheritedApprover: Approver | undefined
  #ask: Asker | undefined
  /** Tool calls waiting for approval or for an answer right now. */
  #blockedCalls = 0
  #status: SessionStatus = "idle"
  #abort: AbortController | undefined
  #maxSteps: number
  #maxTokens: number | undefined
  #abortGraceMs: number
  #sections: PromptSection[]
  #compaction: CompactionOptions
  #context: ContextOptions
  /**
   * How tool results are sent instead of their content (context management, A0): decided once
   * per result and kept, so later requests repeat the same text.
   */
  #views = new Map<Message, ContextView>()
  /** The definition that executed a call, kept when a tool is later disabled or replaced. */
  #callTools = new WeakMap<ToolCallBlock, ToolDefinition>()
  /** Aging rounds so far (A3), for the next round's number. */
  #agingEpoch = 0
  /** Tokens aging freed since the last reply told the context size (an estimate). */
  #contextFreed = 0
  /** The aging round the last reported context size was counted after. */
  #epochAtReply = 0
  /** This session's saved tool outputs (A1). */
  readonly artifacts: ArtifactStore
  /** The session entry each message was stored as. */
  #entryIds = new Map<Message, string>()
  /** Why each compaction in `messages` happened, by its summary's user message. */
  #compactions = new WeakMap<Message, CompactionInfo>()
  /** The history each server checkpoint made in this run stands for, by its summary's user message. */
  #compacted = new WeakMap<Message, Message[]>()
  /** Compaction costs the session file does not hold (no file, or a compaction that failed). */
  #compactionCosts: CompactionUsage[] = []
  /** Context size reported with the last reply; unknown right after a compaction. */
  #contextTokens: number | undefined
  /** The next reply's context size tells whether the last compaction shrank the context enough. */
  #checkCompaction = false
  /** The notice that the context window is a guess was shown (once a session). */
  #windowGuessNoted = false
  /** Automatic compaction waits until the context passes this, after one that did not help. */
  #compactFloor: number | undefined
  #storeFailed = false
  #maxParallelTools: number
  /** Deferred tools this session loaded (via tool_search), in load order. */
  #loadedTools = new Set<string>()
  readonly providerSettings: Record<string, ProviderSettings>
  /** The effort sent for a model (see thinkingFor); a sub-agent inherits it for this.model. */
  readonly thinkingFor: ThinkingFor
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
  /**
   * Delivered notices (expectNotice) waiting for a model call. Unlike steering they are never
   * dropped: after an interrupted or failed turn they wait for the next one.
   */
  #notices: UserMessage[] = []
  /** Notices announced and not yet delivered or cancelled. */
  #expected = 0
  /** Delays between resends of notices after failed turns. */
  #noticeRetryMs: number[]
  /** The scheduled resend, if any. */
  #retry: { timer: ReturnType<typeof setTimeout>; attempt: number; at: number } | undefined
  /** Resends in a row whose turn failed. */
  #retries = 0
  /** A notice arrived during a manual compaction: it is sent once that ends. */
  #noticedDuringCompaction = false
  /**
   * What holds the session (busy, but no turn): "compaction" during a manual compaction, or
   * the work hold() runs, e.g. "reload".
   */
  #holding: string | undefined
  /** Messages sent during a manual compaction; they start one turn when it ends. */
  #afterCompaction: AfterCompaction | undefined
  #onIdleNotice: (() => void) | undefined
  #endTurn: (() => boolean) | undefined
  #originals: ((summary: Message) => Message[] | undefined) | undefined
  #jobNoticeTarget: Agent | undefined
  #pendingNotices = new Set<{ target: Agent }>()
  /** The running turn's promise, for owners that wait for whatever turn runs. */
  #current: Promise<TurnResult> | undefined
  #disposePromise: Promise<void> | undefined
  #disposed = false
  #sessionLease = false
  /** Extension records of a session without a file (see `data`). */
  #records: { key: string; data: unknown }[] = []

  /**
   * Records extensions keep in this session (SessionData): custom entries of its file, or
   * kept in memory when it has none.
   */
  readonly data: SessionData = {
    append: (key, data) => {
      const copy = JSON.parse(JSON.stringify(data ?? null)) as unknown
      if (this.session) this.#store({ type: "custom", ext: key, data: copy })
      else this.#records.push({ key, data: copy })
    },
    read: (key) => {
      const all = this.session
        ? this.session.branch().flatMap((e) => (e.type === "custom" && e.ext === key ? [e.data] : []))
        : this.#records.filter((r) => r.key === key).map((r) => r.data)
      return all.map((d) => structuredClone(d))
    },
  }

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
    this.thinkingFor = thinkingFor(opts)
    this.#sections = opts.sections ?? [{ name: "identity", text: opts.systemPrompt ?? "" }]
    this.#compaction = opts.compaction ?? {}
    this.#context = opts.context ?? {}
    this.#ai = opts.ai
    this.#maxSteps = opts.maxSteps ?? 200
    this.#maxTokens = opts.maxTokens
    this.#abortGraceMs = opts.abortGraceMs ?? 2000
    this.#noticeRetryMs = opts.noticeRetryMs ?? NOTICE_RETRY_MS
    this.#maxParallelTools = Math.max(1, opts.maxParallelTools ?? 8)
    this.tree = opts.tree
    this.backgroundJobs = opts.backgroundJobs?.forSession({
      sessionId: this.sessionId,
      depth: this.depth,
      ...(this.parentSessionId ? { parentSessionId: this.parentSessionId } : {}),
    })
    this.#approve = opts.approve
    this.#inheritedApprover = opts.permissionApprover
    this.#ask = opts.ask
    this.#onIdleNotice = opts.onIdleNotice
    this.#endTurn = opts.endTurn
    this.#originals = opts.originals

    if (opts.messages || !opts.session) {
      this.messages = opts.messages ?? []
      // An interrupted reply may carry no usage counted; the one before it tells the context.
      const last = this.messages.findLast(
        (m) => m.role === "assistant" && m.usage && contextTokens(m.usage) > 0,
      ) as AssistantMessage | undefined
      if (last?.usage) this.#contextTokens = contextTokens(last.usage)
      if (opts.views) {
        const kept = new Set(this.messages)
        for (const [m, v] of opts.views) {
          if (kept.has(m) && (v.kind !== "duplicate" || kept.has(v.of))) this.#views.set(m, v)
        }
      }
    } else {
      const restored = opts.session.restore()
      this.messages = restored.messages
      this.#entryIds = restored.entryIds
      for (const [m, info] of restored.compactions) this.#compactions.set(m, info)
      this.#contextTokens = restored.contextTokens
      for (const name of restored.loadedTools) this.#loadedTools.add(name)
      if (restored.loadedTools.length) this.#restoredTools = restored.loadedTools
      this.#views = restored.views
    }
    for (const v of this.#views.values()) {
      if (v.kind === "aged") this.#agingEpoch = Math.max(this.#agingEpoch, v.epoch)
    }
    this.#epochAtReply = this.#agingEpoch
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
    const stored = opts.session?.model()
    // NO_MODEL is a placeholder until one is picked, not a model the session ran on.
    const changed = stored?.provider !== this.model.provider || stored.model !== this.model.id
    if (opts.session && changed && !isNoModel(this.model)) {
      this.#store({ type: "model_change", model: modelRef(this.model) })
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
        if (added.length) this.#store({ type: "tools_loaded", names: added })
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
            expectNotice: () => agent.#noticeTarget().expectNotice(),
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
    if (this.#disposed) return { deliver: () => {}, cancel: () => {} }
    const pending = { target: this }
    this.#pendingNotices.add(pending)
    this.#expected++
    const close = () => {
      if (!pending.target.#pendingNotices.delete(pending)) return false
      pending.target.#expected--
      return true
    }
    return {
      deliver: (message, opts) => {
        if (close()) pending.target.#receive(message, opts?.wake !== false)
      },
      cancel: () => void close(),
    }
  }

  /** The session that gets this one's notices: its latest replacement after switches, if any. */
  #noticeTarget(): Agent {
    let target: Agent = this
    while (target.#jobNoticeTarget) target = target.#jobNoticeTarget
    return target
  }

  /** Sends notices for top-level background work to the replacement session after a switch. */
  handoverBackgroundNotices(next: Agent): void {
    if (this.depth !== 0) return
    this.#jobNoticeTarget = next
    for (const pending of this.#pendingNotices) {
      this.#pendingNotices.delete(pending)
      this.#expected--
      pending.target = next
      next.#pendingNotices.add(pending)
      next.#expected++
    }
  }

  /** Notices announced (expectNotice) and not yet delivered or cancelled. */
  get expectedNotices(): number {
    return this.#expected
  }

  /** Delivered notices that have not reached the model yet. */
  get waitingNotices(): number {
    return this.#notices.length
  }

  /**
   * Takes the delivered notices that have not reached the model, so they are never sent: for
   * an owner that ends the session, to report them.
   */
  takeNotices(): UserMessage[] {
    return this.#notices.splice(0)
  }

  #receive(message: UserMessage, wake = true) {
    if (this.#disposed) return
    this.#notices.push(message)
    const turn = this.#turn
    if (turn) this.#emit(turn, "turn.steer", { message, state: "queued" })
    else if (this.#holding) {
      // A manual compaction (or other held work) runs: it is sent once that ends.
      if (wake) this.#noticedDuringCompaction = true
      this.#emit(undefined, "turn.steer", { message, state: "queued" })
    } else if (!wake) {
      // It waits for the next turn, which the user's next message starts.
      this.#emit(undefined, "turn.steer", { message, state: "queued" })
    } else if (this.#onIdleNotice) this.#onIdleNotice()
    else this.#wake()
  }

  /**
   * Starts a turn with the delivered notices waiting, if any and the session is idle; for
   * owners that passed `onIdleNotice`. Returns the turn, or undefined when none started.
   */
  wake(): Promise<TurnResult> | undefined {
    if (this.#disposed || this.#abort || this.#holding || !this.#notices.length) return undefined
    return this.prompt(joinMessages(this.#notices.splice(0)))
  }

  /** The turn running now, if any: settles with its result. */
  get currentTurn(): Promise<TurnResult> | undefined {
    return this.#current
  }

  /** When held notices are sent again after a failed turn, if they will be. */
  get noticeRetry(): { attempt: number; at: number } | undefined {
    return this.#retry && { attempt: this.#retry.attempt, at: this.#retry.at }
  }

  /** Stops a scheduled resend of held notices, e.g. when the session is left (/clear, quit). */
  cancelNoticeRetry(): void {
    this.#cancelRetry()
  }

  #cancelRetry() {
    if (!this.#retry) return
    clearTimeout(this.#retry.timer)
    this.#retry = undefined
  }

  /**
   * A turn carrying notices failed before the model answered them (or left some unsent): send
   * them again later, starting a turn, with growing delays. After the last retry fails they
   * wait for the user's next message.
   */
  #scheduleRetry(error: string | undefined) {
    if (this.#disposed) return
    this.#cancelRetry()
    const delays = this.#noticeRetryMs
    if (this.#retries >= delays.length) return
    const delayMs = delays[this.#retries]!
    const attempt = this.#retries + 1
    const timer = setTimeout(() => this.#redeliver(), delayMs)
    // Never what keeps a process alive: print and rpc wait for it on their own terms.
    ;(timer as { unref?: () => void }).unref?.()
    this.#retry = { timer, attempt, at: Date.now() + delayMs }
    this.#emit(undefined, "notice.retry", {
      attempt,
      attempts: delays.length,
      delayMs,
      ...(error !== undefined ? { error } : {}),
    })
  }

  #redeliver() {
    if (this.#disposed) return
    this.#retry = undefined
    this.#retries++
    const message = this.#notices.length
      ? joinMessages(this.#notices.splice(0))
      : userMessage(
          "The previous turn failed before you handled the results of your background sub-agents above. Handle them now. (Sent automatically; the user did not write this message.)",
          {
            text: `◆ sending the sub-agents' results again (retry ${this.#retries} of ${this.#noticeRetryMs.length})`,
            origin: "subagent",
          },
        )
    // A turn cancels the timer, so only a manual compaction can be running: the message then
    // waits for it like any notice arriving meanwhile.
    if (this.#holding) {
      this.#notices.push(message)
      this.#noticedDuringCompaction = true
      this.#emit(undefined, "turn.steer", { message, state: "queued" })
      return
    }
    this.prompt(message).catch(() => {})
  }

  /** Starts a turn with the waiting notices. */
  #wake() {
    if (this.#disposed || this.#abort || !this.#notices.length) return
    this.prompt(joinMessages(this.#notices.splice(0))).catch(() => {})
  }

  /** Notes a sub-agent in this session's file, so its branch points at the child's session. */
  recordSubagent(childSessionId: string, role: string | undefined, title?: string): void {
    this.#store({ type: "subagent", childSessionId, role: role ?? "", ...(title ? { title } : {}) })
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
      ...(this.#ask
        ? {
            askUser: {
              value: (questions: AskQuestion[], signal?: AbortSignal) =>
                this.#askFromTool(turn, toolCallId, questions, signal),
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
    return this.#entryIds.get(message)
  }

  /**
   * Why and how the compaction whose summary `message` is happened (its user message; see
   * isSummaryMessage). Undefined for other messages and for compactions stored without it.
   */
  compactionInfo(message: Message): CompactionInfo | undefined {
    return this.#compactions.get(message)
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
    this.#compactFloor = undefined
    if (!isNoModel(model)) this.#store({ type: "model_change", model: modelRef(model) })
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
      async (signal) => (await this.#compact("manual", signal, undefined, instructions)) === true,
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
      const noticed = this.#noticedDuringCompaction
      this.#noticedDuringCompaction = false
      // Held prompts and steers start their turn (an abort drops them); notices that came
      // meanwhile join it before its first model call. Notices are never dropped: without such
      // a turn they start one, unless the work was aborted: then they wait for the next.
      this.#startAfterCompaction(abort.signal.aborted, what)
      if (noticed && !abort.signal.aborted) this.#wake()
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
    return this.#contextTokens
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
    return this.#views
  }

  /**
   * The history as requests carry it (before the context.build interceptors): for anything
   * that sends this session's conversation on its own, such as a consultation of its model.
   */
  projectedMessages(): Message[] {
    return projectMessages(this.messages, this.#views)
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
    extra: Omit<
      EventMap["session.start"],
      "reason" | "cwd" | "model" | "contextTokens" | "contextWindow"
    > = {},
  ): void {
    const context =
      this.#contextTokens !== undefined && reason !== "clear"
        ? { contextTokens: this.#contextTokens, contextWindow: this.model.contextWindow }
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
    this.#cancelRetry()
    this.#abort?.abort()
    this.#steerAbort?.abort()
    ;(this.backgroundJobs as { dispose?: () => void } | undefined)?.dispose?.()
    this.#steering.splice(0)
    this.#notices.splice(0)
    this.#pendingNotices.clear()
    this.#expected = 0
    // Messages held for a running hold are dropped as an abort of it drops them.
    this.#startAfterCompaction(true, this.#holding ?? "session")
    // #jobNoticeTarget stays: a job that asks for its notice after this switch must still reach
    // the replacement session.
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
   * Adds a message to the running turn without interrupting it (D29): it joins the history
   * before the next model call, and a running tool finishes first. Queued messages the turn
   * never reached become the next prompt; with no turn running, the message starts one.
   * During a manual compaction it is queued (a turn.steer without a turn id) and promoted to
   * the turn that starts when the compaction ends.
   */
  steer(input: string | UserMessage): void {
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
    this.#steering.push(message)
    this.#emit(turn, "turn.steer", { message, state: "queued" })
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
    this.#cancelRetry()
    if (user.display?.origin) turn.unanswered = true

    let steps = 0
    let result: TurnResult = { reason: "done", steps: 0 }
    this.#emit(turn, "turn.start", { prompt: user })
    this.#setStatus(turn, "working")
    try {
      this.#push(user)
      let compactFailed = false
      /** A request over the context window is compacted and sent again, once a turn. */
      let overflowRetried = false
      let overflowCompacted: boolean | undefined
      /** A request over the window first gets one aging round (A3), once a turn. */
      let overflowAged = false
      while (true) {
        this.#noteWindowGuess(turn)
        // Planned synchronously: a turn with nothing to age goes on without waiting.
        const aging = this.#age(turn)
        if (aging) await aging
        if (!compactFailed && this.#needsCompaction()) {
          compactFailed = (await this.#compact("threshold", abort.signal, turn)) === false
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
        if (reply.kind === "aborted") {
          result = { reason: "aborted", steps }
          break
        }
        if (reply.kind === "error") {
          const overflow = reply.model && isContextOverflow(reply.model)
          if (overflow && !overflowAged) {
            overflowAged = true
            const aging = this.#age(turn, true)
            if (aging && (await aging)) continue
          }
          if (overflow && !overflowRetried && this.#compaction.auto !== false) {
            overflowRetried = true
            this.#noteWindowGuess(turn, true)
            overflowCompacted = await this.#compact("overflow", abort.signal, turn)
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
        await this.#runTools(turn, calls)
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
      this.#repairHistory()
      this.#abort = undefined
      this.#turn = undefined
      this.#steerAbort = undefined
      const leftover = this.#steering.splice(0)
      // Notices are never dropped: after an interrupted or failed turn they wait for the next.
      // An owner that decides when turns run (onIdleNotice) starts the next one itself.
      const notices = result.reason === "done" && !this.#onIdleNotice ? this.#notices.splice(0) : []
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
      if (result.reason !== "error") this.#retries = 0
      else if (!this.#disposed && (turn.unanswered || this.#notices.length)) this.#scheduleRetry(result.error)
      if (nextTurnId && !this.#disposed) {
        this.prompt(joinMessages(leftover), { turnId: nextTurnId }).catch(() => {})
      }
    }
    return result
  }

  #injectSteering(turn: Turn) {
    const notices = this.#notices.splice(0)
    if (notices.length) turn.unanswered = true
    // The steers reach the model now: later waits in this turn wait again.
    if (this.#steerAbort?.signal.aborted) this.#steerAbort = new AbortController()
    for (const message of [...this.#steering.splice(0), ...(notices.length ? [joinMessages(notices)] : [])]) {
      this.#push(message)
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
      views: () => this.#views,
      interceptors: this.interceptors,
      sessionId: this.sessionId,
      signal,
    })
  }

  #readKey(call: ToolCallBlock, cwd = this.cwd): string | undefined {
    const tool = this.#callTools.get(call) ?? this.tools.get(call.name)
    if (!tool?.readKey) return undefined
    try {
      return tool.readKey(call.args, { cwd })
    } catch {
      return undefined
    }
  }

  async #callModel(turn: Turn): Promise<ModelReply> {
    const unreadable = await this.#fillSummaries(turn, turn.signal)
    if (turn.signal.aborted) return { kind: "aborted" }
    if (unreadable) return { kind: "error", error: unreadable }
    const ctx = await this.#buildContext(turn.signal)
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
      thinking: this.thinkingFor(this.model),
      signal: turn.signal,
      emit: <K extends keyof EventMap>(type: K, data: EventMap[K]) => this.#emit(turn, type, data),
    })
    const { message, aborted, error, modelError } = call
    if (!aborted && !error)
      message.content = message.content.map((b) => (b.type === "toolCall" ? this.#fixToolName(b) : b))
    if (message.content.length) this.#push(message)
    // An interrupted reply may end with no usage counted: the context is still what it was.
    if (message.usage && contextTokens(message.usage) > 0) this.#noteContext(contextTokens(message.usage))
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
    // A disabled tool stays loaded for when it is turned back on; one that became active is
    // offered anyway.
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
   * Runs tool calls concurrently where it is safe (D71): calls start in order, a `serial` tool
   * waits for everything before it and runs alone, calls with the same concurrency key (e.g. the
   * same file) run one after another, and at most maxParallelTools run at once. Every call gets
   * exactly one result, even if a tool throws, misbehaves or ignores abort.
   */
  async #runTools(turn: Turn, calls: ToolCallBlock[]): Promise<void> {
    const runs: CallRun[] = calls.map((call) => ({ call, started: false, finished: false }))
    try {
      const running = new Set<Promise<void>>()
      const started: Promise<void>[] = []
      const lastByKey = new Map<string, Promise<void>>()
      for (const run of runs) {
        const call = run.call
        if (turn.signal.aborted) break
        const tool = this.tools.get(call.name)
        run.tool = tool
        if (tool) this.#callTools.set(call, tool)
        const serial = tool !== undefined && (tool.concurrency ?? "serial") === "serial"
        if (serial) await this.#untilDoneOrAbandoned(turn.signal, Promise.all(started))
        while (running.size >= this.#maxParallelTools && !turn.signal.aborted) {
          await this.#untilDoneOrAbandoned(turn.signal, Promise.race(running))
        }
        if (turn.signal.aborted) break

        const key = serial ? undefined : concurrencyKey(tool, call, this.cwd)
        const before = key === undefined ? undefined : lastByKey.get(key)
        const task: Promise<void> = (async () => {
          if (before) await before
          const r = await this.#runTool(turn, run, runs)
          if (!run.finished) run.result = r
        })().finally(() => running.delete(task))
        running.add(task)
        started.push(task)
        if (key !== undefined) lastByKey.set(key, task)
        if (serial) await this.#untilDoneOrAbandoned(turn.signal, task)
      }
      await this.#untilDoneOrAbandoned(turn.signal, Promise.all(started))
    } finally {
      for (const run of runs) {
        if (!run.result) {
          run.result = toolError(run.call, "Aborted by the user before this tool finished.", "aborted")
          this.#emitToolStart(turn, run, run.call.args)
          this.#emitToolEnd(turn, run, { content: run.result.content, isError: true }, 0, "aborted")
        }
        run.finished = true
      }
      const results = runs.map((run) => run.result!)
      const views = this.#dedupe(results)
      this.#push(...results)
      this.#storeViews(views)
    }
  }

  /**
   * A1: a result whose text is over the size limit (a tool that does not cut its own output,
   * such as an MCP server's) is saved whole as an artifact; the model gets a preview with the
   * artifact's id. Saving that fails leaves a preview that says so. Images stay as they are.
   */
  async #keepLarge(call: ToolCallBlock, result: ToolResult): Promise<ToolResult> {
    const reader = this.#callTools.get(call) ?? this.tools.get(call.name)
    if (reader && toolTraits(reader)?.artifactReader) return result
    const texts = result.content.flatMap((b) => (b.type === "text" ? [b.text] : []))
    const text = texts.join("\n")
    if (outputSize(text) <= this.artifacts.limits.saveAbove) return result
    let artifact: Awaited<ReturnType<ArtifactStore["save"]>> | undefined
    let saveError: string | undefined
    try {
      artifact = await this.artifacts.save({ text, tool: call.name, toolCallId: call.id })
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err)
    }
    const preview = outputPreview({
      text,
      ...(artifact ? { artifact } : {}),
      ...(saveError ? { saveError } : {}),
      ...(result.isError ? { facts: ["the tool reported an error"] } : {}),
      previewChars: this.artifacts.limits.previewChars,
    })
    const images = result.content.filter((b) => b.type !== "text")
    return { ...result, content: [{ type: "text", text: preview }, ...images] }
  }

  /** A2: views for the reads among a batch's results that repeat an earlier read still in context. */
  #dedupe(results: ToolResultMessage[]): [ToolResultMessage, ContextView][] {
    if (this.#context.dedupeReads === false) return []
    // Only a tool that names repeatable reads can repeat one.
    if (!results.some((r) => this.tools.get(r.toolName)?.readKey)) return []
    const all = [...this.messages, ...results]
    const pairs = pairCalls(all)
    const out: [ToolResultMessage, ContextView][] = []
    for (const [i, result] of results.entries()) {
      const call = pairs.get(result)
      if (!call || !this.#readKey(call)) continue
      const history = all.slice(0, this.messages.length + i)
      const view = duplicateView(history, this.#views, pairs, result, call, this.cwd, (c, cwd) =>
        this.#readKey(c, cwd),
      )
      if (!view) continue
      this.#views.set(result, view)
      out.push([result, view])
    }
    return out
  }

  /** Records views in the session file, so a resumed session sends the same. */
  #storeViews(views: [Message, ContextView][]) {
    const stored: StoredView[] = []
    for (const [m, v] of views) {
      const entry = this.#entryIds.get(m)
      if (!entry) continue
      if (v.kind === "duplicate") {
        const of = this.#entryIds.get(v.of)
        if (of) stored.push({ entry, kind: "duplicate", text: v.text, of })
      } else stored.push({ entry, kind: "aged", text: v.text, epoch: v.epoch })
    }
    if (stored.length) this.#store({ type: "context", views: stored })
  }

  /**
   * The size of the next request, estimated: the context the last reply reported, less what
   * aging freed since, plus what was added after it, counted in characters and scaled by how
   * the model's own count compared for what it saw (so text of any script comes out close).
   */
  #estimateNext(): number {
    const projected = projectMessages(this.messages, this.#views)
    const fixed = Math.ceil(
      (renderPrompt(this.#sections).length + JSON.stringify(this.#offeredTools()).length) / 4,
    )
    const last = this.messages.findLastIndex(
      (m) => m.role === "assistant" && m.usage !== undefined && contextTokens(m.usage) > 0,
    )
    const observed = this.#contextTokens
    if (observed === undefined || last === -1) return fixed + estimateTokens(projected)
    const seen = fixed + estimateTokens(projectMessages(this.messages.slice(0, last + 1), this.#seenViews()))
    const scale = Math.min(4, Math.max(0.5, observed / Math.max(1, seen)))
    return (
      Math.max(0, observed - this.#contextFreed) +
      Math.round(scale * estimateTokens(projected.slice(last + 1)))
    )
  }

  /** How the model's count compares with estimateTokens for this session's history. */
  #tokenScale(): number {
    const observed = this.#contextTokens
    const last = this.messages.findLastIndex(
      (m) => m.role === "assistant" && m.usage !== undefined && contextTokens(m.usage) > 0,
    )
    if (observed === undefined || last === -1) return 1
    const seen = estimateTokens(projectMessages(this.messages.slice(0, last + 1), this.#seenViews()))
    return Math.min(4, Math.max(0.5, observed / Math.max(1, seen)))
  }

  /**
   * The views the last reported context size was counted with: aging rounds since then are
   * left out (that size is from before them), so comparing it with an estimate stays fair.
   */
  #seenViews(): ReadonlyMap<Message, ContextView> {
    const since = [...this.#views].filter(([, v]) => v.kind === "aged" && v.epoch > this.#epochAtReply)
    if (!since.length) return this.#views
    const out = new Map(this.#views)
    for (const [m] of since) out.delete(m)
    return out
  }

  /**
   * A3: when the next request would pass `start` of the window (or passed it: `overflow`), old
   * tool results are cleared in one batch down to `target`: each is sent from then on as a short
   * stub that says how to get it back, and its whole text is kept as an artifact. Only where the
   * history may be rewritten: nothing before signed or encrypted provider data that a request
   * would send back. A round freeing less than minSavedTokens is skipped, keeping the prompt
   * prefix as it is. Undefined when there is nothing to age; else resolves whether it cleared
   * anything.
   */
  #age(turn: Turn, overflow = false): Promise<boolean> | undefined {
    const o = { ...AGING_DEFAULTS, ...this.#context.aging }
    if (!o.enabled || isNoModel(this.model)) return undefined
    const window = this.model.contextWindow
    const estimate = this.#estimateNext()
    const pressure = overflow || estimate > o.start * window
    if (!pressure && o.afterTurns <= 0) return undefined
    const sealed = lastSealedIndex(this.messages, this.#ai.replayTarget(this.model))
    const candidates = agingCandidates(this.messages, this.#views, {
      keepTurns: o.keepTurns,
      keepSteps: o.keepSteps,
      sealed,
      cwd: this.cwd,
      ...(pressure ? {} : { olderThanTurns: o.afterTurns }),
    })
    if (!candidates.length) return undefined
    const scale = this.#tokenScale()
    // After an overflow the window or the estimate was wrong: free a good part whatever they say.
    const down = estimate - Math.min(o.target, o.start) * window
    const goal = overflow ? Math.max(down, 0.3 * estimate) : pressure ? down : Number.POSITIVE_INFINITY
    const picks: { m: ToolResultMessage; call: ToolCallBlock | undefined; saved: number }[] = []
    let saved = 0
    for (const c of candidates) {
      if (saved >= goal) break
      // A stub is about 100 tokens.
      const gain = Math.max(0, Math.round(scale * (c.tokens - 100)))
      picks.push({ m: c.message, call: c.call, saved: gain })
      saved += gain
    }
    // A window whose aging band is narrower than minSavedTokens still ages: never ask for more than the band.
    const minSaved = Math.min(o.minSavedTokens, Math.max(0, (o.start - Math.min(o.target, o.start)) * window))
    if (saved <= 0 || (!overflow && saved < minSaved)) return undefined
    return this.#applyAging(turn, picks)
  }

  /** Sends the picked results as stubs from now on, each with its whole text kept as an artifact. */
  async #applyAging(
    turn: Turn,
    picks: { m: ToolResultMessage; call: ToolCallBlock | undefined; saved: number }[],
  ): Promise<boolean> {
    const epoch = this.#agingEpoch + 1
    const aged: [Message, ContextView][] = []
    let freed = 0
    for (const p of picks) {
      if (turn.signal.aborted) break
      const text = resultText(p.m) ?? ""
      let artifact = artifactIdOf(text)
      if (!artifact) {
        try {
          artifact = (await this.artifacts.save({ text, tool: p.m.toolName, toolCallId: p.m.toolCallId })).id
        } catch {
          // Without its artifact only a file read can be read again.
          if (!p.call || !this.#readKey(p.call)) continue
        }
      }
      const tool = p.call ? (this.#callTools.get(p.call) ?? this.tools.get(p.call.name)) : undefined
      // A tool no longer registered (disabled, unloaded) is judged by its name, as built-ins were.
      const traits = toolTraits(tool ?? { name: p.m.toolName })
      const view: ContextView = {
        kind: "aged",
        text: agedStub(p.m, p.call, artifact, {
          read: tool ? tool.readKey !== undefined : p.m.toolName === "read",
          shell: traits?.shell !== undefined || tool?.shellKind !== undefined,
        }),
        epoch,
      }
      this.#views.set(p.m, view)
      aged.push([p.m, view])
      freed += p.saved
    }
    if (!aged.length) return false
    this.#agingEpoch = epoch
    this.#contextFreed += freed
    this.#storeViews(aged)
    this.#emit(turn, "extension.notice", {
      source: "context",
      text: `Cleared ${aged.length} old tool ${aged.length === 1 ? "result" : "results"} from the context (about ${formatK(freed)} tokens); the model can read them again with output_read or read.`,
      level: "info",
    })
    return true
  }

  /** Waits for the batch, but after an abort gives tools only abortGraceMs to stop. */
  async #untilDoneOrAbandoned(signal: AbortSignal, work: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const abandoned = new Promise<void>((resolve) => {
      onAbort = () => {
        timer = setTimeout(resolve, this.#abortGraceMs)
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      await Promise.race([work, abandoned])
    } finally {
      clearTimeout(timer)
      if (onAbort) signal.removeEventListener("abort", onAbort)
    }
  }

  /** Never rejects: every failure becomes an error result for the model. */
  async #runTool(turn: Turn, run: CallRun, batch: readonly CallRun[]): Promise<ToolResultMessage> {
    const call = run.call
    const started = performance.now()
    // Every outcome goes through tool.call.after (skipped once the turn is interrupted), then
    // tool.execute.end.
    const finish = async (
      args: Record<string, unknown>,
      first: ToolResult,
      durationMs: number,
      rejected?: ToolRejection,
    ): Promise<ToolResultMessage> => {
      run.returned = true
      if (rejected) this.#emitToolStart(turn, run, args)
      const result = await this.#keepLarge(
        call,
        await this.#afterTool(turn, run, batch, args, first, rejected),
      )
      if (!run.finished) this.#emitToolEnd(turn, run, result, durationMs, rejected, run.approval)
      return resultMessage(call, result, rejected)
    }
    const reject = (rejected: ToolRejection, text: string, args = call.args) =>
      finish(args, { content: [{ type: "text", text }], isError: true }, 0, rejected)
    try {
      const bad = invalidArgs(call.args)
      if (bad !== undefined) {
        return await reject(
          "invalidArgs",
          `Invalid JSON in tool arguments. Retry with valid JSON. Received: ${bad.slice(0, 500)}`,
        )
      }
      const tool = this.tools.get(call.name)
      run.tool = tool
      // A tool hidden from this model is not available even if it calls the name anyway.
      if (!tool || !this.#allowsTool(tool)) {
        const names = this.tools
          .active()
          .filter((t) => this.#allowsTool(t))
          .map((t) => t.name)
          .join(", ")
        return await reject("unknownTool", `Unknown tool "${call.name}". Available tools: ${names}`)
      }
      const gate = await this.interceptors.run(
        "tool.call.before",
        { toolCallId: call.id, name: call.name, args: call.args },
        { sessionId: this.sessionId, signal: turn.signal },
      )
      if (gate.blocked) {
        return turn.signal.aborted
          ? await reject("aborted", "Aborted by the user before this tool ran.")
          : await reject("blocked", `Tool call blocked: ${gate.reason}`)
      }
      const args = gate.value.args
      // The core policy decides on the arguments the tool will get, whatever the interceptors
      // made of them; no extension can take it away.
      const policy = await this.permissions.check(tool, args, this.cwd)
      if (turn.signal.aborted)
        return await reject("aborted", "Aborted by the user before this tool ran.", args)
      if (policy.decision === "deny") return await reject("blocked", refusedText(policy), args)
      const asking = policy.decision === "ask"
      if (asking || gate.ask) {
        const reasons = [...(asking ? [policy.reason] : []), ...(gate.ask ?? [])]
        const request: ApprovalRequest = {
          sessionId: this.sessionId,
          toolCallId: call.id,
          name: call.name,
          args,
          reason: reasons.join("; "),
          ...(asking ? { permission: approvalPermission(policy, this.permissions.mode) } : {}),
        }
        // A permission question goes to the user, also from a sub-agent (whose interceptors'
        // questions go to its parent); the user's answer covers the interceptors' reasons too.
        const verdict = await this.#askApproval(
          turn,
          request,
          asking ? this.#permissionApprover() : this.#approve,
        )
        // Dismissing the question stops the turn, like an interrupt.
        if (!verdict.approved && verdict.interrupt && this.#turn === turn) this.#abort?.abort()
        if (verdict.approved && verdict.by) run.approval = verdict.by
        if (turn.signal.aborted)
          return await reject("aborted", "Aborted by the user before this tool ran.", args)
        if (!verdict.approved) {
          const why = `Tool call not approved${verdict.reason ? `: ${verdict.reason}` : "."}`
          return await reject("blocked", asking ? `${why}\n${askedText(policy)}` : why, args)
        }
      }
      const problem = checkArgs(tool.parameters, args)
      if (problem) return await reject("invalidArgs", `Invalid arguments for ${call.name}: ${problem}`, args)
      const paths = await writtenPaths(tool, args, this.cwd)
      if (paths !== undefined) run.writtenPaths = paths

      // Listeners get a copy: the arguments the policy checked are the ones the tool runs with.
      this.#emitToolStart(turn, run, copyArgs(args))
      // Let frontends draw "running <tool>" first: a tool may block the event loop for a while
      // (spawning a process can stall for seconds on some Windows machines).
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      let result: ToolResult
      try {
        const mutateFiles: MutateFiles | undefined = this.fileRewind
          ? async (changes, write) => {
              if (this.#storeFailed && this.fileRewind!.enabled)
                throw new Error("File write refused: the session could not be saved")
              return this.fileRewind!.mutate(changes, write, {
                sessionId: this.sessionId,
                toolCallId: call.id,
                turnId: turn.id,
              })
            }
          : undefined
        const context = {
          cwd: this.cwd,
          toolCallId: call.id,
          signal: turn.signal,
          ...(this.#steerAbort ? { steerSignal: this.#steerAbort.signal } : {}),
          ...(this.backgroundJobs ? { backgroundJobs: this.backgroundJobs } : {}),
          session: this.#callSession(turn, call.id),
          ...(mutateFiles ? { mutateFiles } : {}),
          update: (partial: ToolResult) => {
            if (run.finished) return
            this.#emit(turn, "tool.execute.update", { toolCallId: call.id, name: call.name, partial })
          },
        }
        const traits = toolTraits(tool)
        const pathCapture =
          this.fileRewind?.enabled &&
          paths !== undefined &&
          paths.length > 0 &&
          (traits?.writesFiles === true || traits?.writesFiles === "paths") &&
          traits.usesMutationHook !== true
        const execute = (mutateFilesOverride?: MutateFiles) =>
          tool.execute(args, {
            ...context,
            ...(mutateFilesOverride ? { mutateFiles: mutateFilesOverride } : {}),
          })
        if (pathCapture) {
          // Like the mutateFiles hook: no captured write once the session cannot be saved.
          if (this.#storeFailed) throw new Error("File write refused: the session could not be saved")
          let captured: ToolResult | undefined
          await this.fileRewind!.mutatePaths(
            paths!,
            this.cwd,
            async (mutateFiles) => {
              captured = await execute(mutateFiles)
            },
            {
              sessionId: this.sessionId,
              toolCallId: call.id,
              turnId: turn.id,
            },
          )
          result = normalizeResult(captured!)
        } else {
          result = normalizeResult(await execute(mutateFiles))
        }
      } catch (err) {
        const msg = turn.signal.aborted
          ? "Aborted by the user."
          : `Tool failed: ${err instanceof Error ? err.message : String(err)}`
        result = { content: [{ type: "text", text: msg }], isError: true }
      }
      return await finish(args, result, Math.round(performance.now() - started))
    } catch (err) {
      const text = `Tool call failed before running: ${err instanceof Error ? err.message : String(err)}`
      // Like the other rejections, through tool.call.after (a handler waiting for the last
      // call of the batch must see this one), unless finishing is what failed.
      if (!run.returned) {
        try {
          return await reject("blocked", text)
        } catch {}
      }
      run.returned = true
      this.#emitToolStart(turn, run, call.args)
      if (!run.finished) {
        this.#emitToolEnd(turn, run, { content: [{ type: "text", text }], isError: true }, 0, "blocked")
      }
      return toolError(call, text, "blocked")
    }
  }

  /**
   * Runs tool.call.after on a call's result. An interrupt skips it: the result stands as it
   * is, like after a failing handler.
   */
  async #afterTool(
    turn: Turn,
    run: CallRun,
    batch: readonly CallRun[],
    args: Record<string, unknown>,
    result: ToolResult,
    rejected?: ToolRejection,
  ): Promise<ToolResult> {
    if (turn.signal.aborted || run.finished) return result
    const pending = batch
      .filter((r) => r !== run && !r.returned && !r.finished)
      .map((r) => ({ toolCallId: r.call.id, name: r.call.name }))
    const out = await this.interceptors.run(
      "tool.call.after",
      {
        toolCallId: run.call.id,
        name: run.call.name,
        args,
        cwd: this.cwd,
        ...(rejected ? { rejected } : {}),
        pending,
        result,
      },
      { sessionId: this.sessionId, signal: turn.signal },
    )
    // The registry already dropped modifications without content (see InterceptorRegistry.run).
    const next = out.value.result
    return next === result ? result : normalizeResult(next)
  }

  /**
   * Waits for the approver while the session shows as blocked (D44: with the number of calls
   * waiting). A missing or failing approver denies.
   */
  async #askApproval(
    turn: Turn,
    request: ApprovalRequest,
    approve: Approver | undefined,
  ): Promise<ApprovalDecision> {
    if (!approve) return { approved: false, reason: "it needs approval and nobody can approve it here" }
    try {
      return await this.#waitBlocked(turn, `approval for ${request.name}`, () =>
        approve(request, turn.signal),
      )
    } catch (err) {
      return {
        approved: false,
        reason: `approval failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Who answers the permission policy's questions: the user of the tree (Permissions.approver),
   * else a top-level session's own approver. Never a parent's model: a model cannot widen what
   * its sub-agents may do.
   */
  #permissionApprover(): Approver | undefined {
    return this.permissionApprover
  }

  /**
   * Who answers this session's permission questions, for its sub-agents to ask the same: the
   * tree's user (Permissions.approver), else the one handed down from the top-level session,
   * else a top-level session's own approver.
   */
  get permissionApprover(): Approver | undefined {
    return (
      this.permissions.approver ?? this.#inheritedApprover ?? (this.depth === 0 ? this.#approve : undefined)
    )
  }

  /** A tool's questions (ToolSession.askUser), asked while the session shows as blocked. */
  async #askFromTool(turn: Turn, toolCallId: string, questions: AskQuestion[], signal?: AbortSignal) {
    const ask = this.#ask
    if (!ask) return { unavailable: "nobody can answer questions here" }
    const both = signal && signal !== turn.signal ? AbortSignal.any([turn.signal, signal]) : turn.signal
    const request: AskRequest = { sessionId: this.sessionId, toolCallId, questions }
    const who = this.depth === 0 ? "the user" : "the commander"
    try {
      return await this.#waitBlocked(turn, `question for ${who}`, () => ask(request, both))
    } catch (err) {
      return { unavailable: `asking failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /**
   * Puts questions to whoever answers for this session (the `ask` option): for a commander
   * passing on its sub-agent's questions. Says so when nobody can answer here.
   */
  askQuestions(request: AskRequest, signal: AbortSignal): Promise<AskOutcome> {
    return this.#ask
      ? this.#ask(request, signal)
      : Promise.resolve({ unavailable: "nobody can answer questions here" })
  }

  /**
   * Waits for `wait` while the session shows as blocked (D44: with the number of calls waiting,
   * for approval or for an answer).
   */
  async #waitBlocked<T>(turn: Turn, reason: string, wait: () => Promise<T>): Promise<T> {
    this.#blockedCalls++
    this.#status = "blocked"
    this.#emit(turn, "status.changed", { status: "blocked", reason, pending: this.#blockedCalls })
    try {
      return await wait()
    } finally {
      this.#blockedCalls--
      // A wait that ends after its turn did (aborted, abandoned) must not wake the session.
      const live = this.#turn === turn && !turn.signal.aborted
      if (this.#blockedCalls === 0 && live) this.#setStatus(turn, "working")
    }
  }

  #emitToolStart(turn: Turn, run: CallRun, args: Record<string, unknown>) {
    if (run.started) return
    run.started = true
    const traits = run.tool && toolTraits(run.tool)
    this.#emit(turn, "tool.execute.start", {
      toolCallId: run.call.id,
      name: run.call.name,
      args,
      ...(traits ? { traits } : {}),
      ...(run.writtenPaths !== undefined ? { writtenPaths: run.writtenPaths } : {}),
    })
  }

  #emitToolEnd(
    turn: Turn,
    run: CallRun,
    result: ToolResult,
    durationMs: number,
    rejected?: ToolRejection,
    approval?: ToolApproval,
  ) {
    const traits = run.tool && toolTraits(run.tool)
    this.#emit(turn, "tool.execute.end", {
      toolCallId: run.call.id,
      name: run.call.name,
      result,
      durationMs,
      ...(traits ? { traits } : {}),
      ...(run.writtenPaths !== undefined ? { writtenPaths: run.writtenPaths } : {}),
      ...(rejected ? { rejected } : {}),
      ...(approval ? { approval } : {}),
    })
  }

  /** Guarantees every tool call in history has a result, so the next request is valid. */
  #repairHistory() {
    const missing = [...unansweredCalls(this.messages)]
    this.#push(...missing.map((b) => toolError(b, "This tool call did not complete.", "aborted")))
  }

  /** Adds messages to the history and persists each one. */
  #push(...messages: Message[]) {
    for (const m of messages) {
      this.messages.push(m)
      const id = this.#store({ type: "message", message: m })
      if (id) this.#entryIds.set(m, id)
    }
  }

  /** Appends to the session file. A failing disk is reported once and never breaks the turn. */
  #store(data: SessionEntryData): string | undefined {
    if (!this.session) return undefined
    try {
      return this.session.append(data)
    } catch (err) {
      if (!this.#storeFailed) {
        this.#storeFailed = true
        const error = `could not save the session: ${err instanceof Error ? err.message : String(err)}`
        this.bus.emit("extension.error", { source: "session", error }, { sessionId: this.sessionId })
      }
      return undefined
    }
  }

  #overThreshold(tokens: number): boolean {
    return tokens > (this.#compaction.threshold ?? 0.8) * this.model.contextWindow
  }

  /**
   * Once a session, when automatic compaction goes by a context window that is only a guess
   * (no settings or catalog entry for the model): a notice on where to set it. Only once it
   * starts to matter, when the context passes half the guessed window or the model rejects a
   * request as too long (`overflow`), so short sessions stay quiet and a catalog still
   * loading in the background can name the window first. Sub-agents leave it to their
   * commander's session.
   */
  #noteWindowGuess(turn: Turn, overflow = false) {
    if (this.#windowGuessNoted || this.parentSessionId !== undefined) return
    if (this.#compaction.auto === false || this.model.contextWindowSource !== "default") return
    if (isNoModel(this.model)) return
    if (!overflow && (this.#contextTokens ?? 0) <= this.model.contextWindow / 2) return
    this.#windowGuessNoted = true
    const text = windowGuessNotice(this.model, amiraPath("settings.json"))
    this.#emit(turn, "extension.notice", { source: "compaction", text, level: "info" })
  }

  #needsCompaction(): boolean {
    if (this.#compaction.auto === false || this.#contextTokens === undefined) return false
    // What aging freed since the last reply no longer counts.
    const tokens = this.#contextTokens - this.#contextFreed
    if (this.#compactFloor !== undefined && tokens <= this.#compactFloor) return false
    return this.#overThreshold(tokens)
  }

  /**
   * Notes the context size of a reply. The first one after a compaction shows whether it
   * worked: still over the threshold means summarizing again right away would not help
   * either, so automatic compaction waits until the context has grown by a twentieth of the
   * window, which gives the next summary new steps to fold in.
   */
  #noteContext(tokens: number) {
    this.#contextTokens = tokens
    this.#contextFreed = 0
    this.#epochAtReply = this.#agingEpoch
    if (!this.#checkCompaction) return
    this.#checkCompaction = false
    this.#compactFloor = this.#overThreshold(tokens) ? tokens + this.model.contextWindow / 20 : undefined
  }

  /**
   * Replaces older history with a summary (D19, D57). Never throws; failures emit compact.failed.
   * compact.before runs first, so a compaction it blocks never starts and is reported as blocked.
   * Resolves true when it compacted, false when it failed or was blocked, and undefined when
   * there was nothing to compact yet (a long turn may have enough a few steps later).
   */
  async #compact(
    reason: CompactionReason,
    signal: AbortSignal,
    turn: Turn | undefined,
    instructions?: string,
  ): Promise<boolean | undefined> {
    // What is compacted must be readable by this model first (an earlier checkpoint of another).
    const unreadable = await this.#fillSummaries(turn, signal)
    if (unreadable || signal.aborted) {
      this.#emit(turn, "compact.failed", { error: unreadable ?? "aborted" })
      return false
    }
    const split = splitHistory(
      this.messages,
      this.#compaction.keepTurns ?? 2,
      this.#compaction.keepSteps ?? 2,
    )
    if (!split) {
      if (reason === "manual")
        this.#emit(turn, "compact.failed", { error: "nothing to compact yet", empty: true })
      return undefined
    }
    try {
      const gate = await this.interceptors.run(
        "compact.before",
        { messages: split.older, kept: split.kept },
        { sessionId: this.sessionId, signal },
      )
      if (signal.aborted) throw new Error("aborted")
      if (gate.blocked) {
        this.#emit(turn, "compact.failed", { error: gate.reason, blocked: true })
        return false
      }
      const supplied = gate.value.summary?.trim()
      // The server compacts when the provider has it on, unless the summary is the user's or
      // an extension's to shape (/compact instructions, compact.model, an interceptor's).
      const server =
        supplied || instructions?.trim() || this.#compaction.model
          ? undefined
          : this.#ai.nativeCompaction(this.model)
      const wanted = this.#compaction.layout ?? "tail"
      const layout: CompactionLayout = server?.layouts.includes(wanted) ? wanted : "tail"
      // A "tail" checkpoint over the first steps of a long turn only where the dialect allows.
      const native =
        server && (layout === "recent-user" || !split.prompt || server.midTurn) ? server : undefined
      // What is compacted, and what stays verbatim (before the summary for "recent-user").
      const retained =
        native && layout === "recent-user"
          ? recentUserMessages(this.messages, this.#compaction.keepUserTokens ?? KEEP_USER_TOKENS)
          : []
      const older = native && layout === "recent-user" ? [...this.messages] : split.older
      const kept = native && layout === "recent-user" ? retained : split.kept
      this.#emit(turn, "compact.start", {
        reason,
        replacing: older.length - retained.length,
        kept: kept.length,
        ...(this.#contextTokens !== undefined ? { tokens: this.#contextTokens } : {}),
        ...(native ? { native: true } : {}),
      })

      let usage = emptyUsage()
      let counted = false
      const count = (u: Usage | undefined) => {
        if (!u) return
        usage = addUsage(usage, u)
        counted = true
      }
      let summary: string | undefined
      let checkpoint: Signature | undefined
      /** Tokens the server wrote for the checkpoint: about what it takes up in the context. */
      let checkpointTokens = 0
      let fallback: string | undefined
      let compacted: Message[] | undefined
      if (native) {
        // The history as the server compacts it: in a long turn its prompt goes along in place.
        const olderSet = new Set(older)
        const input =
          layout === "recent-user"
            ? older
            : this.messages.filter((m) => olderSet.has(m) || m === split.prompt)
        const built = await this.#buildContext(signal).catch(() => undefined)
        const systemPrompt = built && !built.blocked ? built.value.systemPrompt : renderPrompt(this.#sections)
        // The same tools a reply would get: the client web_search stays hidden from a model
        // with the hosted search, which the dialect adds beside them as in every request.
        const r = await this.#ai.compact(
          {
            model: this.model,
            systemPrompt,
            // Sent as requests send them; `compacted` keeps the messages themselves.
            messages: projectMessages(input, this.#views),
            tools: this.#offeredTools(),
          },
          signal,
        )
        count(r.usage)
        if (signal.aborted) throw new Error("aborted")
        if (r.ok) {
          summary = r.summary ?? ""
          checkpoint = r.checkpoint
          compacted = input
          checkpointTokens = r.usage.output
        } else fallback = r.error
      }
      const writer = this.#compaction.model ?? this.model
      if (summary === undefined) {
        try {
          const written = supplied
            ? { summary: supplied }
            : await summarize(
                this.#ai,
                writer,
                projectMessages(this.#readable(split.older), this.#views),
                signal,
                instructions,
                split.prompt,
              )
          count(written.usage)
          summary = written.summary
        } catch (err) {
          // What the failed compaction still cost: the server attempts before it, and its own.
          if (err instanceof SummaryError) count(err.usage)
          if (counted) this.#recordCompactionUsage(usage, modelRef(writer), false)
          throw err
        }
      }
      if (signal.aborted) throw new Error("aborted")
      // A text summary replaces the older part and keeps the tail, whatever the layout.
      const recent = checkpoint && layout === "recent-user"
      const replacedMessages = recent ? older : split.older
      const keptMessages = recent ? retained : split.kept
      const ids = (ms: Message[]) => [
        ...new Set(ms.flatMap((m) => (this.#entryIds.has(m) ? [this.#entryIds.get(m)!] : []))),
      ]
      const replaces = ids(replacedMessages)
      const retainedIds = recent ? ids(retained) : []
      const replacement = summaryMessages(summary, modelRef(checkpoint ? this.model : writer), checkpoint)
      const before = this.#contextTokens
      const nativeRef = checkpoint ? modelRef(this.model) : undefined
      const info: CompactionInfo = {
        reason,
        ...(before !== undefined
          ? {
              tokensBefore: before,
              tokensAfter: estimateAfter(
                before,
                projectMessages(
                  replacedMessages.filter((m) => !retained.includes(m)),
                  this.#views,
                ),
                projectMessages(keptMessages, this.#views),
                // The checkpoint replaces both summary messages on the wire. Its size is
                // already in tokens; without usage, estimate from its encrypted length.
                checkpoint ? checkpointTokens || Math.ceil(checkpoint.value.length / 16) : replacement,
              ),
            }
          : {}),
        ...(isNoModel(this.model) ? {} : { contextWindow: this.model.contextWindow }),
        // Separate objects: a JSON writer that marks repeated references as cycles would drop one.
        ...(supplied ? {} : { model: nativeRef ? { ...nativeRef } : modelRef(writer) }),
        ...(nativeRef ? { native: nativeRef, layout } : {}),
        ...(fallback ? { fallback } : {}),
      }
      const entryId = this.#store({
        type: "compaction",
        summary,
        replaces,
        ...info,
        ...(checkpoint ? { checkpoint } : {}),
        ...(retainedIds.length ? { retained: retainedIds } : {}),
        ...(counted ? { usage } : {}),
      })
      if (counted)
        this.#recordCompactionUsage(usage, nativeRef ?? modelRef(writer), Boolean(checkpoint), true)
      this.#compactions.set(replacement[0]!, info)
      if (compacted) this.#compacted.set(replacement[0]!, compacted)
      for (const m of replacement) if (entryId) this.#entryIds.set(m, entryId)
      for (const m of replacedMessages) if (!retained.includes(m)) this.#entryIds.delete(m)
      if (recent) {
        // Codex's layout: the latest user messages, then the checkpoint last.
        this.messages.splice(0, this.messages.length, ...retained, ...replacement)
      } else {
        // The summary goes first; everything it does not replace keeps its order after it (in
        // a long turn that is the turn's prompt and its latest steps).
        const replaced = new Set(split.older)
        const rest = this.messages.filter((m) => !replaced.has(m))
        this.messages.splice(0, this.messages.length, ...replacement, ...rest)
      }
      this.#contextTokens = undefined
      this.#contextFreed = 0
      this.#checkCompaction = true
      this.#emit(turn, "compact.end", {
        summary,
        replaced: replacedMessages.length - retained.length,
        kept: keptMessages.length,
        ...(counted ? { usage } : {}),
        ...info,
      })
      return true
    } catch (err) {
      this.#emit(turn, "compact.failed", { error: err instanceof Error ? err.message : String(err) })
      return false
    }
  }

  /**
   * Counts what a compaction's requests cost toward the tree's budget and, without a session
   * file to read it from later, keeps it for compactionUsage. `stored` says the session file
   * has it (in the compaction entry).
   */
  #recordCompactionUsage(usage: Usage | undefined, model: ModelRef, native: boolean, stored = false) {
    if (!usage || usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) return
    this.tree?.recordUsage(this, usage)
    if (!stored || !this.session) this.#compactionCosts.push({ model, usage, ...(native ? { native } : {}) })
  }

  /**
   * History a model can read as text: a summary pair whose checkpoint has no readable text
   * stands as the history it compacted instead (from memory, or rebuilt from the session file).
   */
  #readable(messages: Message[], depth = 0): Message[] {
    if (depth > 8) return messages
    return messages.flatMap((m) => {
      if (!isSummaryMessage(m) || !checkpointOf(m) || summaryOf(m)) return [m]
      if (m.role === "assistant") return []
      const originals = this.#originalsOf(m)
      return originals ? this.#readable(originals, depth + 1) : [m]
    })
  }

  /** The history a checkpoint's summary message stands for, if it can still be found. */
  #originalsOf(m: Message): Message[] | undefined {
    const known = this.#compacted.get(m)
    if (known) return known
    const id = this.#entryIds.get(m)
    return (id ? this.session?.compacted(id) : undefined) ?? this.#originals?.(m)
  }

  /**
   * The history a compaction's summary message (the user message of the pair) stands for, if
   * it can still be found: for agents forked from this one (AgentOptions.originals).
   */
  compactedHistory(summary: Message): Message[] | undefined {
    return this.#originalsOf(summary)
  }

  /**
   * Makes sure the model can read every compaction in the history: a server checkpoint it
   * cannot be sent (another provider, host or model; canReplay) and that has no readable
   * summary gets one written now from the history it stands for, once, and stored as a
   * compaction entry that fills in the original (it keeps the checkpoint, so switching back
   * uses it again). Resolves an error message when that was not possible.
   */
  async #fillSummaries(turn: Turn | undefined, signal: AbortSignal): Promise<string | undefined> {
    // Without a model nothing can be read or written; the request fails on its own terms.
    if (isNoModel(this.model)) return undefined
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i]!
      const cp = m.role === "user" && isSummaryMessage(m) ? checkpointOf(m) : undefined
      if (!cp || summaryOf(m) || this.#ai.canReplay(cp, this.model)) continue
      const target = `${this.model.provider}/${this.model.id}`
      const originals = this.#originalsOf(m)
      if (!originals?.length) {
        return `the conversation was compacted by ${cp.provider}'s server for ${cp.model}, which ${target} cannot read, and the messages it stands for are not in the session any more; switch back with /model ${cp.provider}/${cp.model}`
      }
      const writer = this.#compaction.model ?? this.model
      let written: { summary: string; usage?: Usage }
      try {
        written = await summarize(
          this.#ai,
          writer,
          projectMessages(this.#readable(originals), this.#views),
          signal,
        )
      } catch (err) {
        if (err instanceof SummaryError) this.#recordCompactionUsage(err.usage, modelRef(writer), false)
        if (signal.aborted) return undefined
        const why = err instanceof Error ? err.message : String(err)
        return `${target} cannot read the server-side compaction made by ${cp.provider} for ${cp.model}, and writing a text summary for it failed: ${why}`
      }
      const oldId = this.#entryIds.get(m)
      const original = oldId ? this.session?.get(oldId) : undefined
      const pair = summaryMessages(written.summary, modelRef(writer), cp)
      const prior = this.#compactions.get(m)
      const info: CompactionInfo | undefined = prior ? { ...prior, model: modelRef(writer) } : undefined
      const entryId = this.#store({
        type: "compaction",
        summary: written.summary,
        replaces: oldId ? [oldId] : [],
        ...(info ?? { model: modelRef(writer) }),
        checkpoint: cp,
        ...(original?.type === "compaction" && original.retained ? { retained: original.retained } : {}),
        ...(written.usage ? { usage: written.usage } : {}),
        ...(oldId ? { fills: oldId } : {}),
      })
      if (written.usage) this.#recordCompactionUsage(written.usage, modelRef(writer), false, true)
      const ack = this.messages[i + 1]
      const pairLength = ack?.role === "assistant" && isSummaryMessage(ack) ? 2 : 1
      this.messages.splice(i, pairLength, ...pair)
      if (info) this.#compactions.set(pair[0]!, info)
      this.#compacted.set(pair[0]!, originals)
      for (const p of pair) if (entryId) this.#entryIds.set(p, entryId)
      this.#emit(turn, "extension.notice", {
        source: "compaction",
        text: `${target} cannot use the server-side compaction made by ${cp.provider} for ${cp.model}, so a text summary of it was written for it.`,
        level: "info",
      })
    }
    return undefined
  }

  /** What this session's compactions cost, one entry each (SessionControl.compactions). */
  get compactionUsage(): CompactionUsage[] {
    const stored: CompactionUsage[] = (this.session?.entries ?? []).flatMap((e) => {
      if (e.type !== "compaction" || !e.usage) return []
      const model = e.model ?? e.native ?? { provider: "", model: "" }
      return [{ model, usage: e.usage, ...(e.native && !e.fills ? { native: true } : {}) }]
    })
    return [...stored, ...this.#compactionCosts]
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
