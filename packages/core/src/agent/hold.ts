// Owns between-turn work and the prompts/steers queued behind it.
import type { UserMessage } from "@amira/ai"
import { freezeSnapshot } from "../frontend/json.ts"
import { addHeldInput, clearHeldInput, type HeldInput, publishHoldState } from "./held-input.ts"
import type { NoticeInbox } from "./notices.ts"
import { transportFailure } from "./transport-failure.ts"
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
  #id: string | undefined
  #next: AfterCompaction | undefined

  constructor(deps: SessionHoldDeps) {
    this.#deps = deps
  }

  get what(): string | undefined {
    return this.#what
  }

  get id(): string | undefined {
    return this.#id
  }

  get prompted(): boolean {
    return this.#next?.prompted ?? false
  }

  /** Reset state is sampled from the actual execution queue, preserving admission identities. */
  recoveryState(): readonly HeldInput[] {
    return freezeSnapshot(structuredClone(this.#next?.messages ?? []))
  }

  async run<T>(what: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#deps.state.abort) throw new AgentBusyError("a turn or compaction is already running")
    const abort = new AbortController()
    this.#deps.state.abort = abort
    this.#what = what
    this.#id = `hold_${crypto.randomUUID()}`
    publishHoldState(this)
    try {
      return await work(abort.signal)
    } finally {
      this.#deps.state.abort = undefined
      this.#what = undefined
      this.#id = undefined
      publishHoldState(this)
      const noticed = this.#deps.inbox.takeNoticedDuringHold()
      if (transportFailure(abort.signal)) this.#deps.inbox.suspend()
      // Held input starts one turn; notices join it, or wake their own turn unless aborted.
      this.#start(abort.signal.aborted, what)
      if (noticed && !abort.signal.aborted) this.#deps.inbox.wakeQuietly()
    }
  }

  steer(message: UserMessage): void {
    const next = this.#enqueue(message, true)
    const owned = next.messages[next.messages.length - 1]!.message
    addHeldInput(this, { message: owned, kind: "steer", holdId: this.#id! })
    this.#deps.emit(undefined, "turn.steer", { message: owned, state: "queued" })
  }

  prompt(message: UserMessage, turnId = newTurnId()): Promise<TurnResult> {
    const next = this.#enqueue(message, false, turnId)
    next.prompted = true
    return new Promise((resolve, reject) => {
      next.waiters.push({ resolve, reject })
      addHeldInput(this, { message, kind: "prompt", holdId: this.#id!, turnId })
    })
  }

  /** Disposal drops held input just as aborting the work does, without dropping notices. */
  cancel(): void {
    this.#start(true, this.#what ?? "session")
  }

  #enqueue(message: UserMessage, steered: boolean, turnId?: string): AfterCompaction {
    const owned = structuredClone(message)
    this.#next ??= { messages: [], prompted: false, waiters: [], sentAt: Date.now() }
    const next = this.#next
    next.messages.push({
      id: `input_${crypto.randomUUID()}`,
      holdId: this.#id!,
      kind: steered ? "steer" : "prompt",
      message: owned,
      ...(turnId === undefined ? {} : { turnId }),
    })
    if (turnId !== undefined) next.turnId = turnId
    return next
  }

  #start(aborted: boolean, what: string): void {
    const next = this.#next
    this.#next = undefined
    if (!next) return
    clearHeldInput(this)
    if (aborted) {
      for (const { message } of next.messages)
        this.#deps.emit(undefined, "turn.steer", { message, state: "dropped" })
      const err = new AgentAbortedError(`the ${what} was aborted before the message was sent`)
      for (const w of next.waiters) w.reject(err)
      return
    }
    const turnId = next.turnId ?? newTurnId()
    for (const { message, kind } of next.messages) {
      if (kind === "steer")
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
