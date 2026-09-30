import {
  type Ai,
  type AssistantMessage,
  describeModelError,
  invalidArgs,
  isContextOverflow,
  isNoModel,
  type Message,
  type ModelError,
  type ModelErrorInfo,
  type ModelInfo,
  type ModelRef,
  modelMessages,
  type ToolCallBlock,
  type ToolResultMessage,
  type ToolSpec,
  type UserMessage,
  unansweredCalls,
  userMessage,
} from "@amira/ai"
import type {
  ApprovalRequest,
  AskOutcome,
  AskQuestion,
  AskRequest,
  CompactionInfo,
  CompactionReason,
  EventMap,
  PendingNotice,
  SessionData,
  SessionStatus,
  SpawnGroupOptions,
  SpawnOptions,
  ToolApproval,
  ToolDefinition,
  ToolRejection,
  ToolResult,
  ToolSession,
  TurnEndReason,
} from "@amira/api"
import {
  type CompactionOptions,
  contextTokens,
  estimateAfter,
  splitHistory,
  summarize,
  summaryMessages,
  windowGuessNotice,
} from "./compaction.ts"
import { createToolSession, deferredToolsSection, offeredTools } from "./deferred-tools.ts"
import { type EmitMeta, EventBus } from "./event-bus.ts"
import { amiraPath } from "./home.ts"
import { InterceptorRegistry } from "./interceptors.ts"
import { type PromptSection, renderPrompt, setSection } from "./prompt.ts"
import { newSessionId, type SessionEntryData, type SessionStore } from "./session-store.ts"
import type { AgentTree } from "./subagents.ts"
import { resolveToolName } from "./tool-names.ts"
import { ToolRegistry } from "./tool-registry.ts"
import { checkArgs } from "./validate-args.ts"

export interface ApprovalDecision {
  approved: boolean
  /** Shown to the model when the call is denied. */
  reason?: string
  /** Who approved it, for the call's row (tool.execute.end `approval`). */
  by?: ToolApproval
  /** The user dismissed the question: the call is denied and the whole turn interrupted. */
  interrupt?: boolean
}

/** Decides a tool call that a tool.call.before interceptor asked about (D13, D14). */
export type Approver = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>

/** Answers the questions a session puts (ToolSession.askUser). */
export type Asker = (request: AskRequest, signal: AbortSignal) => Promise<AskOutcome>

export interface AgentOptions {
  ai: Ai
  model: ModelInfo
  cwd: string
  /** The whole system prompt as one "identity" section; `sections` takes precedence. */
  systemPrompt?: string
  /** The system prompt's named sections, in order (D43). */
  sections?: PromptSection[]
  /**
   * Where the conversation is persisted. Its id becomes the session id and, unless
   * `messages` is given, its current branch is restored.
   */
  session?: SessionStore
  compaction?: CompactionOptions
  sessionId?: string
  parentSessionId?: string
  bus?: EventBus
  interceptors?: InterceptorRegistry
  tools?: ToolRegistry
  /** Upper bound on model calls per turn. Default 200. */
  maxSteps?: number
  maxTokens?: number
  /** How long tools get to stop after an abort before they are abandoned. Default 2000 ms. */
  abortGraceMs?: number
  /** Most tool calls running at once (D71). Default 8. */
  maxParallelTools?: number
  /**
   * After a turn carrying notices fails, they are sent again after each of these delays in
   * turn while the resends keep failing. Default 10 s, 30 s, 90 s.
   */
  noticeRetryMs?: number[]
  messages?: Message[]
  /** Sub-agent nesting depth; 0 (the default) for a top-level session. */
  depth?: number
  /** The agent tree this session belongs to: it spawns sub-agents and keeps the shared budget. */
  tree?: AgentTree
  /**
   * Decides tool calls an interceptor asked about. Sub-agents get one from their tree that
   * asks the parent's model; without one such calls are denied.
   */
  approve?: Approver
  /**
   * Answers questions this session's tools put (ToolSession.askUser, the ask_user tool): the
   * user for a top-level session, the parent's model for sub-agents. Without one nobody answers.
   */
  ask?: Asker
  /**
   * Called instead of starting a turn when a notice arrives while the session is idle, for an
   * owner that decides when turns run (a persistent sub-agent waits for a place in its tree);
   * the owner starts it with wake(). Notices left when a turn ends then wait as well, instead
   * of starting the next turn by themselves.
   */
  onIdleNotice?: () => void
  /**
   * Asked after each batch of tool calls: true ends the turn there, as done, without another
   * model call (a sub-agent that handed back its structured result).
   */
  endTurn?: () => boolean
}

export interface TurnResult {
  reason: TurnEndReason
  steps: number
  error?: string
  /** A failed model request, read for the user (turn.end `failure`). */
  failure?: ModelErrorInfo
}

export interface PromptOptions {
  /** Id for the new turn, so a caller can report it before the turn runs. Default: a fresh one. */
  turnId?: string
}

export class AgentBusyError extends Error {}

/** A message sent during a manual compaction was dropped because the compaction was aborted. */
export class AgentAbortedError extends Error {}

export function newTurnId(): string {
  return `t_${crypto.randomUUID().slice(0, 8)}`
}

/** State that belongs to one turn, so late callbacks never leak into the next turn. */
interface Turn {
  id: string
  signal: AbortSignal
  /** Notices joined this turn and no model reply has come since. */
  unanswered?: boolean
}

/** Default delays before held notices are sent again after failed turns. */
export const NOTICE_RETRY_MS = [10_000, 30_000, 90_000]

/**
 * One tool call of a batch. Tracked by the call itself, not its id: providers reuse ids across
 * steps (and some even within one reply), and each call still needs its own events and result.
 */
interface CallRun {
  call: ToolCallBlock
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
  /** 0 for a top-level session, 1 for its sub-agents, and so on. */
  readonly depth: number
  readonly tree: AgentTree | undefined
  model: ModelInfo

  #ai: Ai
  #approve: Approver | undefined
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
  /** The session entry each message was stored as. */
  #entryIds = new Map<Message, string>()
  /** Why each compaction in `messages` happened, by its summary's user message. */
  #compactions = new WeakMap<Message, CompactionInfo>()
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
  /**
   * Loaded tools restored from the session file, checked at the first model call: by then
   * system.build has waited for tools that register late (MCP servers).
   */
  #restoredTools: string[] | undefined
  #toolSession: ToolSession
  #turn: Turn | undefined
  /** Steering messages waiting for the next model call of the running turn. */
  #steering: UserMessage[] = []
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
  /** The running turn's promise, for owners that wait for whatever turn runs. */
  #current: Promise<TurnResult> | undefined
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
    this.sessionId = opts.session?.id ?? opts.sessionId ?? newSessionId()
    this.parentSessionId = opts.parentSessionId
    this.bus = opts.bus ?? new EventBus()
    this.interceptors = opts.interceptors ?? new InterceptorRegistry()
    this.tools = opts.tools ?? new ToolRegistry()
    this.cwd = opts.cwd
    this.model = opts.model
    this.#sections = opts.sections ?? [{ name: "identity", text: opts.systemPrompt ?? "" }]
    this.#compaction = opts.compaction ?? {}
    this.#ai = opts.ai
    this.#maxSteps = opts.maxSteps ?? 200
    this.#maxTokens = opts.maxTokens
    this.#abortGraceMs = opts.abortGraceMs ?? 2000
    this.#noticeRetryMs = opts.noticeRetryMs ?? NOTICE_RETRY_MS
    this.#maxParallelTools = Math.max(1, opts.maxParallelTools ?? 8)
    this.depth = opts.depth ?? 0
    this.tree = opts.tree
    this.#approve = opts.approve
    this.#ask = opts.ask
    this.#onIdleNotice = opts.onIdleNotice
    this.#endTurn = opts.endTurn

    if (opts.messages || !opts.session) {
      this.messages = opts.messages ?? []
      // An interrupted reply may carry no usage counted; the one before it tells the context.
      const last = this.messages.findLast(
        (m) => m.role === "assistant" && m.usage && contextTokens(m.usage) > 0,
      ) as AssistantMessage | undefined
      if (last?.usage) this.#contextTokens = contextTokens(last.usage)
    } else {
      const restored = opts.session.restore()
      this.messages = restored.messages
      this.#entryIds = restored.entryIds
      for (const [m, info] of restored.compactions) this.#compactions.set(m, info)
      this.#contextTokens = restored.contextTokens
      for (const name of restored.loadedTools) this.#loadedTools.add(name)
      if (restored.loadedTools.length) this.#restoredTools = restored.loadedTools
    }
    const stored = opts.session?.model()
    // NO_MODEL is a placeholder until one is picked, not a model the session ran on.
    const changed = stored?.provider !== this.model.provider || stored.model !== this.model.id
    if (opts.session && changed && !isNoModel(this.model)) {
      this.#store({ type: "model_change", model: modelRef(this.model) })
    }
    const agent = this
    const tree = opts.tree
    const deferred = createToolSession(this.sessionId, this.tools, this.#loadedTools)
    this.#toolSession = {
      ...deferred,
      data: this.data,
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
      ...(this.depth === 0 || this.#onIdleNotice ? { expectNotice: () => agent.expectNotice() } : {}),
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
    this.#expected++
    let open = true
    const close = () => {
      if (!open) return false
      open = false
      this.#expected--
      return true
    }
    return {
      deliver: (message, opts) => {
        if (close()) this.#receive(message, opts?.wake !== false)
      },
      cancel: () => void close(),
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
    if (this.#abort || this.#holding || !this.#notices.length) return undefined
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
    if (this.#abort || !this.#notices.length) return
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
      tools: offeredTools(this.tools, this.#loadedTools),
    }
  }

  /** When and with which model this agent compacts. */
  get compaction(): Readonly<CompactionOptions> {
    return this.#compaction
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
    // A cleared session starts empty, whatever this agent held.
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

  /**
   * Adds a message to the running turn without interrupting it (D29): it joins the history
   * before the next model call, and a running tool finishes first. Queued messages the turn
   * never reached become the next prompt; with no turn running, the message starts one.
   * During a manual compaction it is queued (a turn.steer without a turn id) and promoted to
   * the turn that starts when the compaction ends.
   */
  steer(input: string | UserMessage): void {
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
    this.#steering.push(message)
    this.#emit(turn, "turn.steer", { message, state: "queued" })
  }

  /**
   * Runs one turn. Everything up to the turn.start event happens synchronously, so once this
   * returns the turn is running and `turnId` is set. During a manual compaction the turn
   * starts when the compaction ends, together with anything steered meanwhile.
   */
  prompt(input: string | UserMessage, opts: PromptOptions = {}): Promise<TurnResult> {
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
      while (true) {
        this.#noteWindowGuess(turn)
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
      else if (turn.unanswered || this.#notices.length) this.#scheduleRetry(result.error)
      if (nextTurnId) {
        this.prompt(joinMessages(leftover), { turnId: nextTurnId }).catch(() => {})
      }
    }
    return result
  }

  #injectSteering(turn: Turn) {
    const notices = this.#notices.splice(0)
    if (notices.length) turn.unanswered = true
    for (const message of [...this.#steering.splice(0), ...(notices.length ? [joinMessages(notices)] : [])]) {
      this.#push(message)
      this.#emit(turn, "turn.steer", { message, state: "injected" })
    }
  }

  /** The system prompt and history for a model call, through the system.build and context.build interceptors. */
  async #buildContext(signal: AbortSignal) {
    // The core owns the "deferred-tools" section: interceptors see it filled in, and it is
    // listed again afterwards so tools registered while they waited (e.g. MCP servers that
    // were still connecting) are included, unless an interceptor rewrote the section.
    const listed = deferredToolsSection(this.tools.deferred())
    const built = await this.interceptors.run(
      "system.build",
      { sections: setSection(this.#sections, "deferred-tools", listed).map((s) => ({ ...s })) },
      { sessionId: this.sessionId, signal },
    )
    let sections = built.value.sections
    if (sections.find((s) => s.name === "deferred-tools")?.text === listed) {
      sections = setSection(sections, "deferred-tools", deferredToolsSection(this.tools.deferred()))
    }
    return this.interceptors.run(
      "context.build",
      { systemPrompt: renderPrompt(sections), messages: [...this.messages] },
      { sessionId: this.sessionId, signal },
    )
  }

  async #callModel(turn: Turn): Promise<ModelReply> {
    const ctx = await this.#buildContext(turn.signal)
    this.#checkRestoredTools()
    if (turn.signal.aborted) return { kind: "aborted" }
    if (ctx.blocked) return { kind: "error", error: `context.build blocked the request: ${ctx.reason}` }

    const modelRef = { provider: this.model.provider, model: this.model.id }
    this.#emit(turn, "message.start", { model: modelRef, contextWindow: this.model.contextWindow })

    let final: AssistantMessage | undefined
    let error: string | undefined
    let modelError: ModelError | undefined
    let aborted = false
    let retrying = false
    try {
      const stream = this.#ai.stream(
        {
          model: this.model,
          systemPrompt: ctx.value.systemPrompt,
          messages: ctx.value.messages,
          tools: offeredTools(this.tools, this.#loadedTools),
          ...(this.#maxTokens ? { maxTokens: this.#maxTokens } : {}),
        },
        turn.signal,
      )
      for await (const ev of stream) {
        if (retrying && ev.type !== "retry") {
          retrying = false
          this.#emit(turn, "status.changed", { status: "working" })
        }
        switch (ev.type) {
          case "retry":
            retrying = true
            this.#emit(turn, "model.retry", {
              attempt: ev.attempt,
              maxRetries: ev.maxRetries,
              delayMs: ev.delayMs,
              error: ev.error.message,
              kind: ev.error.kind ?? "other",
              ...(ev.error.status !== undefined ? { status: ev.error.status } : {}),
            })
            this.#emit(turn, "status.changed", {
              status: "working",
              reason: `retrying (${ev.attempt}/${ev.maxRetries})`,
            })
            break
          case "text.delta":
            this.#emit(turn, "message.delta", { kind: "text", text: ev.text })
            break
          case "thinking.delta":
            this.#emit(turn, "message.delta", { kind: "thinking", text: ev.text })
            break
          case "toolCall.delta":
            this.#emit(turn, "message.delta", {
              kind: "toolCall",
              toolCallId: ev.id,
              argsDelta: ev.argsDelta,
              ...(ev.index !== undefined ? { index: ev.index } : {}),
              ...(ev.name ? { name: ev.name } : {}),
            })
            break
          case "done":
            final = ev.message
            // A reply that ends well after the turn was interrupted is still an interrupted
            // one: a dialect may finish what it had already read without looking at the signal.
            if (turn.signal.aborted) {
              aborted = true
              final = { ...ev.message, stopReason: "aborted" }
            }
            break
          case "error":
            final = ev.message
            if (ev.error.code === "aborted" || turn.signal.aborted) aborted = true
            else {
              error = ev.error.message
              modelError = ev.error
            }
            break
        }
      }
    } catch (err) {
      if (turn.signal.aborted) aborted = true
      else error = err instanceof Error ? err.message : String(err)
    }
    if (!final && !error && !aborted) error = "the model stream ended without a final message"

    const message: AssistantMessage = final ?? {
      role: "assistant",
      content: [],
      model: modelRef,
      stopReason: aborted ? "aborted" : "error",
    }
    // An interrupted reply keeps its text but drops tool calls, which were never executed.
    if (aborted || error) message.content = message.content.filter((b) => b.type !== "toolCall")
    else message.content = message.content.map((b) => (b.type === "toolCall" ? this.#fixToolName(b) : b))
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
          run.result = toolError(run.call, "Aborted by the user before this tool finished.")
          this.#emitToolStart(turn, run, run.call.args)
          this.#emitToolEnd(turn, run.call, { content: run.result.content, isError: true }, 0, "aborted")
        }
        run.finished = true
      }
      this.#push(...runs.map((run) => run.result!))
    }
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
      const result = await this.#afterTool(turn, run, batch, args, first, rejected)
      if (!run.finished) this.#emitToolEnd(turn, call, result, durationMs, rejected, run.approval)
      return {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: result.isError ?? false,
      }
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
      if (!tool) {
        const names = this.tools
          .active()
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
      if (gate.ask) {
        const request = { sessionId: this.sessionId, toolCallId: call.id, name: call.name, args }
        const verdict = await this.#askApproval(turn, { ...request, reason: gate.ask.join("; ") })
        // Dismissing the question stops the turn, like an interrupt.
        if (!verdict.approved && verdict.interrupt && this.#turn === turn) this.#abort?.abort()
        if (verdict.approved && verdict.by) run.approval = verdict.by
        if (turn.signal.aborted)
          return await reject("aborted", "Aborted by the user before this tool ran.", args)
        if (!verdict.approved) {
          return await reject(
            "blocked",
            `Tool call not approved${verdict.reason ? `: ${verdict.reason}` : "."}`,
            args,
          )
        }
      }
      const problem = checkArgs(tool.parameters, args)
      if (problem) return await reject("invalidArgs", `Invalid arguments for ${call.name}: ${problem}`, args)

      this.#emitToolStart(turn, run, args)
      // Let frontends draw "running <tool>" first: a tool may block the event loop for a while
      // (spawning a process can stall for seconds on some Windows machines).
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      let result: ToolResult
      try {
        result = normalizeResult(
          await tool.execute(args, {
            cwd: this.cwd,
            toolCallId: call.id,
            signal: turn.signal,
            session: this.#callSession(turn, call.id),
            update: (partial) => {
              if (run.finished) return
              this.#emit(turn, "tool.execute.update", { toolCallId: call.id, name: call.name, partial })
            },
          }),
        )
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
        this.#emitToolEnd(turn, call, { content: [{ type: "text", text }], isError: true }, 0, "blocked")
      }
      return toolError(call, text)
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
  async #askApproval(turn: Turn, request: ApprovalRequest): Promise<ApprovalDecision> {
    const approve = this.#approve
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
    this.#emit(turn, "tool.execute.start", { toolCallId: run.call.id, name: run.call.name, args })
  }

  #emitToolEnd(
    turn: Turn,
    call: ToolCallBlock,
    result: ToolResult,
    durationMs: number,
    rejected?: ToolRejection,
    approval?: ToolApproval,
  ) {
    this.#emit(turn, "tool.execute.end", {
      toolCallId: call.id,
      name: call.name,
      result,
      durationMs,
      ...(rejected ? { rejected } : {}),
      ...(approval ? { approval } : {}),
    })
  }

  /** Guarantees every tool call in history has a result, so the next request is valid. */
  #repairHistory() {
    const missing = [...unansweredCalls(this.messages)]
    this.#push(...missing.map((b) => toolError(b, "This tool call did not complete.")))
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
    if (this.#compactFloor !== undefined && this.#contextTokens <= this.#compactFloor) return false
    return this.#overThreshold(this.#contextTokens)
  }

  /**
   * Notes the context size of a reply. The first one after a compaction shows whether it
   * worked: still over the threshold means summarizing again right away would not help
   * either, so automatic compaction waits until the context has grown by a twentieth of the
   * window, which gives the next summary new steps to fold in.
   */
  #noteContext(tokens: number) {
    this.#contextTokens = tokens
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
      this.#emit(turn, "compact.start", {
        reason,
        replacing: split.older.length,
        kept: split.kept.length,
        ...(this.#contextTokens !== undefined ? { tokens: this.#contextTokens } : {}),
      })
      const supplied = gate.value.summary?.trim()
      const writer = this.#compaction.model ?? this.model
      const summary =
        supplied || (await summarize(this.#ai, writer, split.older, signal, instructions, split.prompt))
      if (signal.aborted) throw new Error("aborted")
      const replaces = [
        ...new Set(split.older.flatMap((m) => (this.#entryIds.has(m) ? [this.#entryIds.get(m)!] : []))),
      ]
      const replacement = summaryMessages(summary, modelRef(this.model))
      const before = this.#contextTokens
      const info: CompactionInfo = {
        reason,
        ...(before !== undefined
          ? {
              tokensBefore: before,
              tokensAfter: estimateAfter(before, split.older, split.kept, replacement),
            }
          : {}),
        ...(isNoModel(this.model) ? {} : { contextWindow: this.model.contextWindow }),
        ...(supplied ? {} : { model: modelRef(writer) }),
      }
      const entryId = this.#store({ type: "compaction", summary, replaces, ...info })
      this.#compactions.set(replacement[0]!, info)
      for (const m of replacement) if (entryId) this.#entryIds.set(m, entryId)
      for (const m of split.older) this.#entryIds.delete(m)
      // The summary goes first; everything it does not replace keeps its order after it (in a
      // long turn that is the turn's prompt and its latest steps).
      const replaced = new Set(split.older)
      const rest = this.messages.filter((m) => !replaced.has(m))
      this.messages.splice(0, this.messages.length, ...replacement, ...rest)
      this.#contextTokens = undefined
      this.#checkCompaction = true
      this.#emit(turn, "compact.end", {
        summary,
        replaced: split.older.length,
        kept: split.kept.length,
        ...info,
      })
      return true
    } catch (err) {
      this.#emit(turn, "compact.failed", { error: err instanceof Error ? err.message : String(err) })
      return false
    }
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

/**
 * Steering messages that start a turn together, as one prompt. When any has a display, the
 * prompt's display lists each message's display (or text) in order.
 */
function joinMessages(messages: UserMessage[]): UserMessage {
  if (messages.length === 1 && messages[0]) return messages[0]
  const joined: UserMessage = { role: "user", content: messages.flatMap((m) => m.content) }
  if (!messages.some((m) => m.display)) return joined
  const text = messages
    .map((m) => m.display?.text ?? m.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n"))
    .join("\n")
  const notes = messages.flatMap((m) => (m.display?.note ? [m.display.note] : []))
  // Notices of one kind stay notices; mixed with what the user wrote they read as the user's.
  const origins = new Set(messages.map((m) => m.display?.origin))
  const origin = origins.size === 1 ? [...origins][0] : undefined
  return {
    ...joined,
    display: { text, ...(notes.length ? { note: notes.join(" · ") } : {}), ...(origin ? { origin } : {}) },
  }
}

function modelRef(model: ModelInfo): ModelRef {
  return { provider: model.provider, model: model.id }
}

/** The tool's concurrency key for this call; a throwing key function means no key. */
function concurrencyKey(
  tool: ToolDefinition | undefined,
  call: ToolCallBlock,
  cwd: string,
): string | undefined {
  if (!tool?.concurrencyKey) return undefined
  try {
    return tool.concurrencyKey(call.args, { cwd })
  } catch {
    return undefined
  }
}

/** Coerces whatever a tool returned into a valid result. */
function normalizeResult(r: unknown): ToolResult {
  const content = (r as ToolResult | undefined)?.content
  if (!Array.isArray(content)) {
    return {
      content: [{ type: "text", text: "Tool returned an invalid result (missing content)." }],
      isError: true,
    }
  }
  const valid = content.filter(
    (b) =>
      (b?.type === "text" && typeof b.text === "string") ||
      (b?.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string"),
  )
  const out: ToolResult = { content: valid.length ? valid : [{ type: "text", text: "(no output)" }] }
  if ((r as ToolResult).isError) out.isError = true
  if ((r as ToolResult).details !== undefined) out.details = (r as ToolResult).details
  return out
}

function toolError(call: ToolCallBlock, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError: true,
  }
}
