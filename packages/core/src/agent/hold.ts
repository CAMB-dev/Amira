// Owns between-turn work and the prompts/steers queued behind it.
import type { UserMessage } from "@amira/ai"
import type { NoticeInbox } from "./notices.ts"
import type { TurnState } from "./turn-runner.ts"
import {
  type AfterCompaction,
  AgentAbortedError,
  AgentBusyError,
  type Emit,
  newTurnId,
  type PromptOptions,
  type TurnResult,
} from "./types.ts"

interface SessionHoldDeps {
  state: Pick<TurnState, "abort">
  inbox: NoticeInbox
  prompt: (message: UserMessage, options: PromptOptions) => Promise<TurnResult>
  emit: Emit
}

/** A work hold shares the turn's abort slot; queued input starts only after that slot is released. */
export class SessionHold {
  readonly #deps: SessionHoldDeps
  #what: string | undefined
  #next: AfterCompaction | undefined

  constructor(deps: SessionHoldDeps) {
    this.#deps = deps
  }

  get what(): string | undefined {
    return this.#what
  }

  get prompted(): boolean {
    return this.#next?.prompted ?? false
  }

  async run<T>(what: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#deps.state.abort) throw new AgentBusyError("a turn or compaction is already running")
    const abort = new AbortController()
    this.#deps.state.abort = abort
    this.#what = what
    try {
      return await work(abort.signal)
    } finally {
      this.#deps.state.abort = undefined
      this.#what = undefined
      const noticed = this.#deps.inbox.takeNoticedDuringHold()
      // Held input starts one turn; notices join it, or wake their own turn unless aborted.
      this.#start(abort.signal.aborted, what)
      if (noticed && !abort.signal.aborted) this.#deps.inbox.wakeQuietly()
    }
  }

  steer(message: UserMessage): void {
    this.#enqueue(message, true)
    this.#deps.emit(undefined, "turn.steer", { message, state: "queued" })
  }

  prompt(message: UserMessage, turnId?: string): Promise<TurnResult> {
    const next = this.#enqueue(message, false, turnId)
    next.prompted = true
    return new Promise((resolve, reject) => next.waiters.push({ resolve, reject }))
  }

  /** Disposal drops held input just as aborting the work does, without dropping notices. */
  cancel(): void {
    this.#start(true, this.#what ?? "session")
  }

  #enqueue(message: UserMessage, steered: boolean, turnId?: string): AfterCompaction {
    this.#next ??= { messages: [], prompted: false, waiters: [], sentAt: Date.now() }
    const next = this.#next
    next.messages.push({ message, steered })
    if (turnId !== undefined) next.turnId = turnId
    return next
  }

  #start(aborted: boolean, what: string): void {
    const next = this.#next
    this.#next = undefined
    if (!next) return
    if (aborted) {
      for (const { message } of next.messages)
        this.#deps.emit(undefined, "turn.steer", { message, state: "dropped" })
      const err = new AgentAbortedError(`the ${what} was aborted before the message was sent`)
      for (const w of next.waiters) w.reject(err)
      return
    }
    const turnId = next.turnId ?? newTurnId()
    for (const { message, steered } of next.messages) {
      if (steered)
        this.#deps.emit(undefined, "turn.steer", { message, state: "promoted", nextTurnId: turnId })
    }
    const [only, ...more] = next.messages
    const prompt: UserMessage =
      only && !more.length
        ? only.message
        : { role: "user", content: next.messages.flatMap((m) => m.message.content) }
    this.#deps.prompt(prompt, { turnId, sentAt: next.sentAt }).then(
      (r) => {
        for (const w of next.waiters) w.resolve(r)
      },
      (err) => {
        for (const w of next.waiters) w.reject(err)
      },
    )
  }
}
