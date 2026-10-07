// Owns complete turn execution, including model preparation and ordered finalization.
import {
  type Ai,
  type AssistantMessage,
  describeModelError,
  isContextOverflow,
  type ModelError,
  type ModelInfo,
  type ToolCallBlock,
  type ToolSpec,
  type Usage,
  type UserMessage,
  userMessage,
} from "@amira/ai"
import type { EventMap, SessionStatus } from "@amira/api"
import { type CompactionOptions, contextTokens } from "../compaction.ts"
import type { PauseGate } from "../subagents/pause.ts"
import { resolveToolName } from "../tool-names.ts"
import type { ToolRegistry } from "../tool-registry.ts"
import type { Compactor } from "./compactor.ts"
import type { buildContext } from "./context-builder.ts"
import type { ContextManager } from "./context-manager.ts"
import type { History } from "./history.ts"
import { joinMessages, modelRef } from "./messages.ts"
import { modelCall, type Thinking } from "./model-call.ts"
import type { NoticeInbox } from "./notices.ts"
import type { ToolRunner } from "./tool-runner.ts"
import {
  AgentBusyError,
  type Emit,
  newTurnId,
  type PromptOptions,
  type Turn,
  type TurnResult,
} from "./types.ts"

/** Shared ownership: the abort controller guards both turns and between-turn holds. */
export interface TurnState {
  abort: AbortController | undefined
  turn: Turn | undefined
  /** Steering messages waiting for the next model call of the running turn. */
  steering: UserMessage[]
  /** Aborts waits that can return partial output as soon as steering arrives. */
  steerAbort: AbortController | undefined
}

interface TurnRunnerDeps {
  ai: Ai
  history: History
  compactor: Compactor
  contextManager: ContextManager
  toolRunner: ToolRunner
  inbox: NoticeInbox
  execution: PauseGate
  tools: ToolRegistry
  thinking: Thinking
  model: () => ModelInfo
  maxSteps: number
  maxTokens: number | undefined
  depth: number
  compaction: CompactionOptions
  buildContext: (signal: AbortSignal) => ReturnType<typeof buildContext>
  offeredTools: () => ToolSpec[]
  checkRestoredTools: () => void
  emit: Emit
  setStatus: (turn: Turn, status: SessionStatus, reason?: string) => void
  prompt: (input: UserMessage, opts: PromptOptions) => Promise<TurnResult>
  disposed: () => boolean
  ownsIdleNotices: () => boolean
  endTurn: () => boolean | undefined
  recordTreeUsage: (usage: Usage) => void
}

type ModelReply =
  | { kind: "ok"; message: AssistantMessage }
  | { kind: "error"; error: string; model?: ModelError }
  | { kind: "aborted" }

/** One async driver: delegation adds no await between admission and finalization. */
export class TurnRunner {
  #state: TurnState
  #deps: TurnRunnerDeps

  constructor(state: TurnState, deps: TurnRunnerDeps) {
    this.#state = state
    this.#deps = deps
  }

  async run(input: string | UserMessage, opts: PromptOptions): Promise<TurnResult> {
    if (this.#state.abort) throw new AgentBusyError("a turn or compaction is already running")
    const abort = new AbortController()
    this.#state.abort = abort
    this.#state.steerAbort = new AbortController()
    const turn: Turn = {
      id: opts.turnId ?? newTurnId(),
      signal: abort.signal,
    }
    this.#state.turn = turn
    const user = typeof input === "string" ? userMessage(input) : input
    // Whatever starts now takes the held notices along: no retry is needed any more.
    this.#deps.inbox.cancelRetry()
    if (user.display?.origin) turn.unanswered = true

    let steps = 0
    let result: TurnResult = { reason: "done", steps: 0 }
    this.#deps.emit(turn, "turn.start", { prompt: user })
    this.#deps.setStatus(turn, "working")
    try {
      this.#deps.history.push(user)
      let compactFailed = false
      /** A request over the context window is compacted and sent again, once a turn. */
      let overflowRetried = false
      let overflowCompacted: boolean | undefined
      /** A request over the window first gets one aging round (A3), once a turn. */
      let overflowAged = false
      while (true) {
        this.#deps.compactor.noteWindowGuess(turn)
        // Planned synchronously: a turn with nothing to age goes on without waiting.
        const aging = this.#deps.contextManager.age(turn)
        if (aging) await aging
        if (!compactFailed && this.#deps.compactor.needsCompaction()) {
          compactFailed = (await this.#deps.compactor.compact("threshold", abort.signal, turn)) === false
        }
        if (abort.signal.aborted) {
          result = { reason: "aborted", steps }
          break
        }
        if (steps >= this.#deps.maxSteps) {
          result = { reason: "error", steps, error: `stopped after ${this.#deps.maxSteps} model calls` }
          break
        }
        steps++
        this.#injectSteering(turn)
        const reply = await this.#callModel(turn)
        if (this.#deps.execution.paused) await this.#deps.execution.wait(abort.signal)
        if (reply.kind === "aborted" || (this.#deps.execution.paused && abort.signal.aborted)) {
          result = { reason: "aborted", steps }
          break
        }
        if (reply.kind === "error") {
          const overflow = reply.model && isContextOverflow(reply.model)
          if (overflow && !overflowAged) {
            overflowAged = true
            const aging = this.#deps.contextManager.age(turn, true)
            if (aging && (await aging)) continue
          }
          if (overflow && !overflowRetried && this.#deps.compaction.auto !== false) {
            overflowRetried = true
            this.#deps.compactor.noteWindowGuess(turn, true)
            overflowCompacted = await this.#deps.compactor.compact("overflow", abort.signal, turn)
            if (overflowCompacted === true) continue
          }
          const failure = reply.model
            ? describeModelError(reply.model, { provider: this.#deps.model().provider })
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
        await this.#deps.toolRunner.run(turn, calls, (results) => {
          const views = this.#deps.contextManager.dedupe(results)
          this.#deps.history.push(...results)
          this.#deps.history.storeViews(views)
        })
        if (this.#deps.execution.paused) await this.#deps.execution.wait(abort.signal)
        if (abort.signal.aborted) {
          result = { reason: "aborted", steps }
          break
        }
        if (this.#deps.endTurn()) {
          result = { reason: "done", steps }
          break
        }
      }
    } catch (err) {
      result = { reason: "error", steps, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.#deps.history.repair()
      this.#state.abort = undefined
      this.#state.turn = undefined
      this.#state.steerAbort = undefined
      const leftover = this.#state.steering.splice(0)
      // Notices are never dropped: after an interrupted or failed turn they wait for the next.
      // An owner that decides when turns run (onIdleNotice) starts the next one itself.
      const notices = result.reason === "done" && !this.#deps.ownsIdleNotices() ? this.#deps.inbox.take() : []
      const nextTurnId =
        result.reason === "done" && (leftover.length || notices.length) ? newTurnId() : undefined
      for (const message of leftover) {
        this.#deps.emit(
          turn,
          "turn.steer",
          nextTurnId ? { message, state: "promoted", nextTurnId } : { message, state: "dropped" },
        )
      }
      if (notices.length && nextTurnId) {
        const message = joinMessages(notices)
        this.#deps.emit(turn, "turn.steer", { message, state: "promoted", nextTurnId })
        leftover.push(message)
      }
      if (result.reason === "error") this.#deps.setStatus(turn, "error", result.error)
      this.#deps.emit(turn, "turn.end", {
        reason: result.reason,
        steps,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.failure ? { failure: result.failure } : {}),
      })
      this.#deps.setStatus(turn, "idle")
      // A success resets the notice retries; after an interrupt the user decides when to go on.
      if (result.reason !== "error") this.#deps.inbox.resetRetries()
      else if (!this.#deps.disposed() && (turn.unanswered || this.#deps.inbox.waiting))
        this.#deps.inbox.scheduleRetry(result.error)
      if (nextTurnId && !this.#deps.disposed()) {
        this.#deps.prompt(joinMessages(leftover), { turnId: nextTurnId }).catch(() => {})
      }
    }
    return result
  }

  #injectSteering(turn: Turn) {
    const notices = this.#deps.inbox.take()
    if (notices.length) turn.unanswered = true
    // The steers reach the model now: later waits in this turn wait again.
    if (this.#state.steerAbort?.signal.aborted) this.#state.steerAbort = new AbortController()
    for (const message of [
      ...this.#state.steering.splice(0),
      ...(notices.length ? [joinMessages(notices)] : []),
    ]) {
      this.#deps.history.push(message)
      this.#deps.emit(turn, "turn.steer", { message, state: "injected" })
    }
  }

  /** Rebuilt for a sub-agent's user messages, a few times at most: a stream of them cannot starve the model. */
  async #callModel(turn: Turn): Promise<ModelReply> {
    const unreadable = await this.#deps.compactor.fillSummaries(turn, turn.signal)
    if (turn.signal.aborted) return { kind: "aborted" }
    if (unreadable) return { kind: "error", error: unreadable }
    let ctx = await this.#deps.buildContext(turn.signal)
    for (let rebuilds = 0; ; rebuilds++) {
      if (await this.#deps.execution.wait(turn.signal)) return { kind: "aborted" }
      if (
        this.#deps.depth === 0 ||
        rebuilds >= 3 ||
        !(this.#state.steering.length || this.#deps.inbox.waiting)
      )
        break
      this.#injectSteering(turn)
      ctx = await this.#deps.buildContext(turn.signal)
    }
    this.#deps.checkRestoredTools()
    if (turn.signal.aborted) return { kind: "aborted" }
    if (ctx.blocked) return { kind: "error", error: `context.build blocked the request: ${ctx.reason}` }

    const requestModelRef = modelRef(this.#deps.model())
    this.#deps.emit(turn, "message.start", {
      model: requestModelRef,
      contextWindow: this.#deps.model().contextWindow,
    })
    const call = await modelCall({
      ai: this.#deps.ai,
      model: this.#deps.model(),
      modelRef: requestModelRef,
      systemPrompt: ctx.value.systemPrompt,
      messages: ctx.value.messages,
      tools: () => this.#deps.offeredTools(),
      maxTokens: this.#deps.maxTokens,
      thinking: this.#deps.thinking.for(this.#deps.model()),
      signal: turn.signal,
      emit: <K extends keyof EventMap>(type: K, data: EventMap[K]) => this.#deps.emit(turn, type, data),
    })
    const { message, aborted, error, modelError } = call
    if (!aborted && !error)
      message.content = message.content.map((b) => (b.type === "toolCall" ? this.#fixToolName(b) : b))
    if (message.content.length) this.#deps.history.push(message)
    // An interrupted reply may end with no usage counted: the context is still what it was.
    if (message.usage && contextTokens(message.usage) > 0)
      this.#deps.compactor.noteContext(contextTokens(message.usage))
    this.#deps.emit(turn, "message.end", { message })
    if (message.usage) this.#deps.recordTreeUsage(message.usage)

    if (aborted) return { kind: "aborted" }
    if (error) return { kind: "error", error, ...(modelError ? { model: modelError } : {}) }
    return { kind: "ok", message }
  }

  /** Renames a call to a tool the model misspelled, so history, events and results agree. */
  #fixToolName(call: ToolCallBlock): ToolCallBlock {
    if (this.#deps.tools.get(call.name)) return call
    const name = resolveToolName(
      call.name,
      this.#deps.tools.active().map((t) => t.name),
    )
    return name ? { ...call, name } : call
  }
}
