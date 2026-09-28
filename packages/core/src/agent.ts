import {
  type Ai,
  type AssistantMessage,
  invalidArgs,
  type Message,
  type ModelInfo,
  type ModelRef,
  type ToolCallBlock,
  type ToolResultMessage,
  type ToolSpec,
  type UserMessage,
  unansweredCalls,
  userMessage,
} from "@amira/ai"
import type {
  ApprovalRequest,
  EventMap,
  SessionStatus,
  SpawnOptions,
  ToolDefinition,
  ToolRejection,
  ToolResult,
  ToolSession,
  TurnEndReason,
} from "@amira/api"
import {
  type CompactionOptions,
  contextTokens,
  splitHistory,
  summarize,
  summaryMessages,
} from "./compaction.ts"
import { createToolSession, deferredToolsSection, offeredTools } from "./deferred-tools.ts"
import { type EmitMeta, EventBus } from "./event-bus.ts"
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
}

/** Decides a tool call that a tool.call.before interceptor asked about (D13, D14). */
export type Approver = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>

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
}

export interface TurnResult {
  reason: TurnEndReason
  steps: number
  error?: string
}

export interface PromptOptions {
  /** Id for the new turn, so a caller can report it before the turn runs. Default: a fresh one. */
  turnId?: string
}

export class AgentBusyError extends Error {}

export function newTurnId(): string {
  return `t_${crypto.randomUUID().slice(0, 8)}`
}

/** State that belongs to one turn, so late callbacks never leak into the next turn. */
interface Turn {
  id: string
  signal: AbortSignal
}

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
  result?: ToolResultMessage
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
  | { kind: "error"; error: string }
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
  /** Tool calls waiting for approval right now. */
  #approvals = 0
  #status: SessionStatus = "idle"
  #abort: AbortController | undefined
  #maxSteps: number
  #maxTokens: number | undefined
  #abortGraceMs: number
  #sections: PromptSection[]
  #compaction: CompactionOptions
  /** The session entry each message was stored as. */
  #entryIds = new Map<Message, string>()
  /** Context size reported with the last reply; unknown right after a compaction. */
  #contextTokens: number | undefined
  /** The next reply's context size tells whether the last compaction shrank the context enough. */
  #checkCompaction = false
  /** Automatic compaction waits until the context passes this, after one that did not help. */
  #compactFloor: number | undefined
  #storeFailed = false
  #maxParallelTools: number
  /** Deferred tools this session loaded (via tool_search), in load order. */
  #loadedTools = new Set<string>()
  #toolSession: ToolSession
  #turn: Turn | undefined
  /** Steering messages waiting for the next model call of the running turn. */
  #steering: UserMessage[] = []
  /** A manual compaction is running (busy, but no turn). */
  #compacting = false
  /** Messages sent during a manual compaction; they start one turn when it ends. */
  #afterCompaction: AfterCompaction | undefined

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
    this.#maxParallelTools = Math.max(1, opts.maxParallelTools ?? 8)
    this.depth = opts.depth ?? 0
    this.tree = opts.tree
    this.#approve = opts.approve

    if (opts.messages || !opts.session) {
      this.messages = opts.messages ?? []
      const last = this.messages.findLast((m) => m.role === "assistant" && m.usage) as
        | AssistantMessage
        | undefined
      if (last?.usage) this.#contextTokens = contextTokens(last.usage)
    } else {
      const restored = opts.session.restore()
      this.messages = restored.messages
      this.#entryIds = restored.entryIds
      this.#contextTokens = restored.contextTokens
    }
    const stored = opts.session?.model()
    if (opts.session && (stored?.provider !== this.model.provider || stored.model !== this.model.id)) {
      this.#store({ type: "model_change", model: modelRef(this.model) })
    }
    const agent = this
    const tree = opts.tree
    this.#toolSession = {
      ...createToolSession(this.sessionId, this.tools, this.#loadedTools),
      depth: this.depth,
      get maxDepth() {
        return tree?.maxDepth ?? 0
      },
      get model() {
        return modelRef(agent.model)
      },
      ...(tree ? { spawn: (o: SpawnOptions) => tree.spawn(agent, o) } : {}),
    }
  }

  /** Notes a sub-agent in this session's file, so its branch points at the child's session. */
  recordSubagent(childSessionId: string, role: string | undefined): void {
    this.#store({ type: "subagent", childSessionId, role: role ?? "" })
  }

  /** Offers deferred tools to the model from its next call on, e.g. when restoring a session. */
  loadTools(names: string[]): string[] {
    return this.#toolSession.loadTools(names)
  }

  get loadedTools(): string[] {
    return [...this.#loadedTools]
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
    this.#store({ type: "model_change", model: modelRef(model) })
    this.#emit(undefined, "model.changed", { from, to: modelRef(model) })
  }

  /**
   * Summarizes older history now, keeping recent turns verbatim; `instructions` steer the
   * summary. Resolves false when there was nothing to compact or compaction failed (see
   * compact.failed). Messages sent meanwhile (prompt or steer) start a turn once it ends,
   * even when it failed or was aborted.
   */
  async compact(instructions?: string): Promise<boolean> {
    if (this.#abort) throw new AgentBusyError("a turn is already running")
    const abort = new AbortController()
    this.#abort = abort
    this.#compacting = true
    try {
      return await this.#compact("manual", abort.signal, undefined, instructions)
    } finally {
      this.#abort = undefined
      this.#compacting = false
      this.#startAfterCompaction()
    }
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
  #startAfterCompaction() {
    const next = this.#afterCompaction
    this.#afterCompaction = undefined
    if (!next) return
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
    return { ...built.value, tools: offeredTools(this.tools, this.#loadedTools) }
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
    extra: Omit<EventMap["session.start"], "reason" | "cwd" | "model"> = {},
  ): void {
    this.bus.emit(
      "session.start",
      { ...extra, reason, cwd: this.cwd, model: { provider: this.model.provider, model: this.model.id } },
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
    if (!turn && this.#compacting) {
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
    if (this.#compacting && !this.#afterCompaction?.prompted) {
      const user = typeof input === "string" ? userMessage(input) : input
      const next = this.#holdForCompaction(user, false, opts.turnId)
      next.prompted = true
      return new Promise((resolve, reject) => next.waiters.push({ resolve, reject }))
    }
    return this.#runTurn(input, opts)
  }

  async #runTurn(input: string | UserMessage, opts: PromptOptions): Promise<TurnResult> {
    if (this.#abort) throw new AgentBusyError("a turn is already running")
    const abort = new AbortController()
    this.#abort = abort
    const turn: Turn = {
      id: opts.turnId ?? newTurnId(),
      signal: abort.signal,
    }
    this.#turn = turn
    const user = typeof input === "string" ? userMessage(input) : input

    let steps = 0
    let result: TurnResult = { reason: "done", steps: 0 }
    this.#emit(turn, "turn.start", { prompt: user })
    this.#setStatus(turn, "working")
    try {
      this.#push(user)
      let compactFailed = false
      while (true) {
        if (!compactFailed && this.#needsCompaction()) {
          compactFailed = !(await this.#compact("threshold", abort.signal, turn))
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
          result = { reason: "error", steps, error: reply.error }
          break
        }
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
      }
    } catch (err) {
      result = { reason: "error", steps, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.#repairHistory()
      this.#abort = undefined
      this.#turn = undefined
      const leftover = this.#steering.splice(0)
      const nextTurnId = result.reason === "done" && leftover.length ? newTurnId() : undefined
      for (const message of leftover) {
        this.#emit(
          turn,
          "turn.steer",
          nextTurnId ? { message, state: "promoted", nextTurnId } : { message, state: "dropped" },
        )
      }
      if (result.reason === "error") this.#setStatus(turn, "error", result.error)
      this.#emit(turn, "turn.end", {
        reason: result.reason,
        steps,
        ...(result.error !== undefined ? { error: result.error } : {}),
      })
      this.#setStatus(turn, "idle")
      if (nextTurnId) {
        const prompt: UserMessage = { role: "user", content: leftover.flatMap((m) => m.content) }
        this.prompt(prompt, { turnId: nextTurnId }).catch(() => {})
      }
    }
    return result
  }

  #injectSteering(turn: Turn) {
    for (const message of this.#steering.splice(0)) {
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
    if (turn.signal.aborted) return { kind: "aborted" }
    if (ctx.blocked) return { kind: "error", error: `context.build blocked the request: ${ctx.reason}` }

    const modelRef = { provider: this.model.provider, model: this.model.id }
    this.#emit(turn, "message.start", { model: modelRef, contextWindow: this.model.contextWindow })

    let final: AssistantMessage | undefined
    let error: string | undefined
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
            break
          case "error":
            final = ev.message
            if (ev.error.code === "aborted" || turn.signal.aborted) aborted = true
            else error = ev.error.message
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
    if (message.usage) this.#noteContext(contextTokens(message.usage))
    this.#emit(turn, "message.end", { message })
    if (message.usage) this.tree?.recordUsage(this, message.usage)

    if (aborted) return { kind: "aborted" }
    if (error) return { kind: "error", error }
    return { kind: "ok", message }
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
          const r = await this.#runTool(turn, run)
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
  async #runTool(turn: Turn, run: CallRun): Promise<ToolResultMessage> {
    const call = run.call
    const started = performance.now()
    const reject = (rejected: ToolRejection, text: string) => {
      this.#emitToolStart(turn, run, call.args)
      this.#emitToolEnd(turn, call, { content: [{ type: "text", text }], isError: true }, 0, rejected)
      return toolError(call, text)
    }
    try {
      const bad = invalidArgs(call.args)
      if (bad !== undefined) {
        return reject(
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
        return reject("unknownTool", `Unknown tool "${call.name}". Available tools: ${names}`)
      }
      const gate = await this.interceptors.run(
        "tool.call.before",
        { toolCallId: call.id, name: call.name, args: call.args },
        { sessionId: this.sessionId, signal: turn.signal },
      )
      if (gate.blocked) {
        return turn.signal.aborted
          ? reject("aborted", "Aborted by the user before this tool ran.")
          : reject("blocked", `Tool call blocked: ${gate.reason}`)
      }
      const args = gate.value.args
      if (gate.ask) {
        const request = { sessionId: this.sessionId, toolCallId: call.id, name: call.name, args }
        const verdict = await this.#askApproval(turn, { ...request, reason: gate.ask.join("; ") })
        if (turn.signal.aborted) return reject("aborted", "Aborted by the user before this tool ran.")
        if (!verdict.approved) {
          return reject("blocked", `Tool call not approved${verdict.reason ? `: ${verdict.reason}` : "."}`)
        }
      }
      const problem = checkArgs(tool.parameters, args)
      if (problem) return reject("invalidArgs", `Invalid arguments for ${call.name}: ${problem}`)

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
            session: this.#toolSession,
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
      if (!run.finished) {
        this.#emitToolEnd(turn, call, result, Math.round(performance.now() - started))
      }
      return {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: result.isError ?? false,
      }
    } catch (err) {
      return reject(
        "blocked",
        `Tool call failed before running: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * Waits for the approver while the session shows as blocked (D44: with the number of calls
   * waiting). A missing or failing approver denies.
   */
  async #askApproval(turn: Turn, request: ApprovalRequest): Promise<ApprovalDecision> {
    if (!this.#approve) return { approved: false, reason: "it needs approval and nobody can approve it here" }
    this.#approvals++
    this.#status = "blocked"
    this.#emit(turn, "status.changed", {
      status: "blocked",
      reason: `approval for ${request.name}`,
      pending: this.#approvals,
    })
    try {
      return await this.#approve(request, turn.signal)
    } catch (err) {
      return {
        approved: false,
        reason: `approval failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    } finally {
      this.#approvals--
      if (this.#approvals === 0) this.#setStatus(turn, "working")
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
  ) {
    this.#emit(turn, "tool.execute.end", {
      toolCallId: call.id,
      name: call.name,
      result,
      durationMs,
      ...(rejected ? { rejected } : {}),
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
   */
  async #compact(
    reason: "threshold" | "manual",
    signal: AbortSignal,
    turn: Turn | undefined,
    instructions?: string,
  ) {
    const split = splitHistory(
      this.messages,
      this.#compaction.keepTurns ?? 2,
      this.#compaction.keepSteps ?? 2,
    )
    if (!split) {
      if (reason === "manual") this.#emit(turn, "compact.failed", { error: "nothing to compact yet" })
      return false
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
      const summary =
        gate.value.summary?.trim() ||
        (await summarize(this.#ai, this.#compaction.model ?? this.model, split.older, signal, instructions))
      if (signal.aborted) throw new Error("aborted")
      const replaces = [
        ...new Set(split.older.flatMap((m) => (this.#entryIds.has(m) ? [this.#entryIds.get(m)!] : []))),
      ]
      const entryId = this.#store({ type: "compaction", summary, replaces })
      const replacement = summaryMessages(summary, modelRef(this.model))
      for (const m of replacement) if (entryId) this.#entryIds.set(m, entryId)
      for (const m of split.older) this.#entryIds.delete(m)
      // The summary goes first; everything it does not replace keeps its order after it (in a
      // long turn that is the turn's prompt and its latest steps).
      const replaced = new Set(split.older)
      const rest = this.messages.filter((m) => !replaced.has(m))
      this.messages.splice(0, this.messages.length, ...replacement, ...rest)
      this.#contextTokens = undefined
      this.#checkCompaction = true
      this.#emit(turn, "compact.end", { summary, replaced: split.older.length, kept: split.kept.length })
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
