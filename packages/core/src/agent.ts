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
  userMessage,
} from "@amira/ai"
import type {
  EventMap,
  SessionStatus,
  ToolDefinition,
  ToolRejection,
  ToolResult,
  ToolSession,
  TurnEndReason,
} from "@amira/api"
import { type CompactionOptions, contextTokens, splitHistory, summarize } from "./compaction.ts"
import { createToolSession, deferredToolsSection, offeredTools } from "./deferred-tools.ts"
import { type EmitMeta, EventBus } from "./event-bus.ts"
import { InterceptorRegistry } from "./interceptors.ts"
import { type PromptSection, renderPrompt, setSection } from "./prompt.ts"
import { newSessionId, type SessionEntryData, type SessionStore, summaryMessages } from "./session-store.ts"
import { resolveToolName } from "./tool-names.ts"
import { ToolRegistry } from "./tool-registry.ts"
import { checkArgs } from "./validate-args.ts"

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
  /** Tool calls that emitted tool.execute.start. */
  started: Set<string>
  /** Tool calls whose result has been recorded; later updates from them are dropped. */
  finished: Set<string>
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
  model: ModelInfo

  #ai: Ai
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
  #storeFailed = false
  #maxParallelTools: number
  /** Deferred tools this session loaded (via tool_search), in load order. */
  #loadedTools = new Set<string>()
  #toolSession: ToolSession
  #turn: Turn | undefined
  /** Steering messages waiting for the next model call of the running turn. */
  #steering: UserMessage[] = []

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
    this.#toolSession = createToolSession(this.sessionId, this.tools, this.#loadedTools)
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
   * compact.failed).
   */
  async compact(instructions?: string): Promise<boolean> {
    if (this.#abort) throw new AgentBusyError("a turn is already running")
    const abort = new AbortController()
    this.#abort = abort
    try {
      return await this.#compact("manual", abort.signal, undefined, instructions)
    } finally {
      this.#abort = undefined
    }
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
   */
  steer(input: string | UserMessage): void {
    const message = typeof input === "string" ? userMessage(input) : input
    const turn = this.#turn
    if (!turn) {
      this.prompt(message).catch(() => {})
      return
    }
    this.#steering.push(message)
    this.#emit(turn, "turn.steer", { message, state: "queued" })
  }

  /**
   * Runs one turn. Everything up to the turn.start event happens synchronously, so once this
   * returns the turn is running and `turnId` is set.
   */
  async prompt(input: string | UserMessage, opts: PromptOptions = {}): Promise<TurnResult> {
    if (this.#abort) throw new AgentBusyError("a turn is already running")
    const abort = new AbortController()
    this.#abort = abort
    const turn: Turn = {
      id: opts.turnId ?? newTurnId(),
      signal: abort.signal,
      started: new Set(),
      finished: new Set(),
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
    if (message.usage) this.#contextTokens = contextTokens(message.usage)
    this.#emit(turn, "message.end", { message })

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
    const results = new Map<string, ToolResultMessage>()
    try {
      const running = new Set<Promise<void>>()
      const started: Promise<void>[] = []
      const lastByKey = new Map<string, Promise<void>>()
      for (const call of calls) {
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
          const r = await this.#runTool(turn, call)
          if (!turn.finished.has(call.id)) results.set(call.id, r)
        })().finally(() => running.delete(task))
        running.add(task)
        started.push(task)
        if (key !== undefined) lastByKey.set(key, task)
        if (serial) await this.#untilDoneOrAbandoned(turn.signal, task)
      }
      await this.#untilDoneOrAbandoned(turn.signal, Promise.all(started))
    } finally {
      for (const c of calls) {
        if (!results.has(c.id)) {
          const r = toolError(c, "Aborted by the user before this tool finished.")
          results.set(c.id, r)
          this.#emitToolStart(turn, c, c.args)
          this.#emitToolEnd(turn, c, { content: r.content, isError: true }, 0, "aborted")
        }
        turn.finished.add(c.id)
      }
      this.#push(...calls.map((c) => results.get(c.id)!))
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
  async #runTool(turn: Turn, call: ToolCallBlock): Promise<ToolResultMessage> {
    const started = performance.now()
    const reject = (rejected: ToolRejection, text: string) => {
      this.#emitToolStart(turn, call, call.args)
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
      const problem = checkArgs(tool.parameters, args)
      if (problem) return reject("invalidArgs", `Invalid arguments for ${call.name}: ${problem}`)

      this.#emitToolStart(turn, call, args)
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
              if (turn.finished.has(call.id)) return
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
      if (!turn.finished.has(call.id)) {
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

  #emitToolStart(turn: Turn, call: ToolCallBlock, args: Record<string, unknown>) {
    if (turn.started.has(call.id)) return
    turn.started.add(call.id)
    this.#emit(turn, "tool.execute.start", { toolCallId: call.id, name: call.name, args })
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
    const answered = new Set<string>()
    for (const m of this.messages) if (m.role === "toolResult") answered.add(m.toolCallId)
    const missing: ToolResultMessage[] = []
    for (const m of this.messages) {
      if (m.role !== "assistant") continue
      for (const b of m.content) {
        if (b.type === "toolCall" && !answered.has(b.id))
          missing.push(toolError(b, "This tool call did not complete."))
      }
    }
    this.#push(...missing)
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

  #needsCompaction(): boolean {
    if (this.#compaction.auto === false || this.#contextTokens === undefined) return false
    return this.#contextTokens > (this.#compaction.threshold ?? 0.8) * this.model.contextWindow
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
    const split = splitHistory(this.messages, this.#compaction.keepTurns ?? 2)
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
      this.messages.splice(0, split.older.length, ...replacement)
      this.#contextTokens = undefined
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
