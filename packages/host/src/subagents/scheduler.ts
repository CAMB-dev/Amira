import type { Child } from "./child.ts"

/** A scheduled child or an independently owned root turn; lifecycle stays with its owner. */
export type AdmissionWork = Pick<
  Child,
  "id" | "parentSessionId" | "agent" | "groups" | "ephemeral" | "admitted" | "waiting"
>

/** Queues children and gives them places to run within the tree's and their groups' limits (D63). */
export class Admission {
  /** Children waiting for a place to run, in order, with what starts them. */
  #queue: { child: AdmissionWork; go: () => void; consultation?: boolean }[] = []
  /** Children whose turn is running (or about to start). */
  #running = new Set<AdmissionWork>()
  /** Physical consultation streams, retained even after their requester's turn ends. */
  #consulting = new Set<AdmissionWork>()
  /** Children executing a tool batch, which may wait for descendants. */
  #toolWaits = new Set<AdmissionWork>()
  /** Tool-waiting children that yielded their place; they must reacquire before another call. */
  #yielded = new Set<AdmissionWork>()
  /** Live children's parents, including idle ones, for tracing queued/running descendants. */
  #parents = new Map<string, string>()

  constructor(private deps: { maxConcurrent: number }) {}

  /** Tracks the child and queues it with what starts it; then admits. */
  enqueue(child: AdmissionWork, parentSessionId: string, go: () => void): void {
    this.#parents.set(child.id, parentSessionId)
    this.#queue.push({ child, go })
    this.#yieldToolParents(child)
    this.admit()
  }

  #under(child: AdmissionWork, ancestor: AdmissionWork): boolean {
    for (let id: string | undefined = child.parentSessionId; id; ) {
      if (id === ancestor.id) return true
      id = this.#parents.get(id)
    }
    return false
  }

  /** New spawns and existing descendants' follow-ups both let tool-waiting ancestors yield. */
  #yieldToolParents(child: AdmissionWork): void {
    for (const parent of this.#toolWaits) if (this.#under(child, parent)) this.#yielded.add(parent)
  }

  /** Consultations cannot yield their physical stream; turn reservations count only once. */
  #busy(among: Iterable<AdmissionWork>): number {
    let n = 0
    for (const c of among)
      if (
        this.#consulting.has(c) ||
        (this.#running.has(c) && (c.agent.execution.paused || !this.#yielded.has(c)))
      )
        n++
    return n
  }

  /**
   * Starts queued children, oldest first, while fewer than maxConcurrent are busy tree-wide
   * (D63) and in each of their groups. A child waiting inside tools can yield to its own
   * children, avoiding deadlock; it reacquires before returning to model work. Paused
   * children retain their places. At limits of two or more, ordinary work leaves one place
   * for private interactive turns, inside the total limit. A child whose group or ordinary
   * capacity is full waits without holding up those behind it; private turns can also use
   * otherwise free places.
   */
  admit(): void {
    const occupants = new Set([...this.#running, ...this.#consulting])
    let busy = this.#busy(occupants)
    let ordinary = this.#busy([...occupants].filter((c) => !c.ephemeral))
    const ordinaryLimit = Math.max(1, this.deps.maxConcurrent - 1)
    for (let i = 0; i < this.#queue.length && busy < this.deps.maxConcurrent; ) {
      const entry = this.#queue[i]!
      const full =
        this.#consulting.has(entry.child) ||
        (!entry.child.ephemeral && ordinary >= ordinaryLimit) ||
        entry.child.groups.some(
          (g) =>
            g.limits.maxConcurrent !== undefined &&
            this.#busy(new Set([...g.live, ...[...this.#consulting].filter((c) => c.groups.includes(g))])) >=
              g.limits.maxConcurrent,
        )
      if (full) {
        i++
        continue
      }
      this.#queue.splice(i, 1)
      if (entry.consultation) this.#consulting.add(entry.child)
      else {
        entry.child.admitted = true
        this.#running.add(entry.child)
      }
      busy++
      if (!entry.child.ephemeral) ordinary++
      // Grant consultations atomically; an abort before a later microtask must not lose the permit.
      // Turns start a microtask later, so the caller can subscribe to child.events first.
      if (entry.consultation) entry.go()
      else queueMicrotask(entry.go)
    }
  }

  /** A tool batch may wait for descendants; only then can those descendants use its place. */
  beginTools(child: AdmissionWork): void {
    this.#toolWaits.add(child)
    if (
      [...this.#running].some((c) => this.#under(c, child)) ||
      this.#queue.some((entry) => this.#under(entry.child, child))
    )
      this.#yielded.add(child)
    this.admit()
  }

  /** Tools returned: no longer able to yield to new spawns, but not yet doing model work. */
  endTools(child: AdmissionWork): void {
    this.#toolWaits.delete(child)
  }

  /** Return to model work through the same FIFO and group limits as any other admission. */
  reenter(child: AdmissionWork, signal: AbortSignal): Promise<void> | undefined {
    if (!this.#yielded.delete(child)) return
    this.release(child)
    if (!signal.aborted) return this.acquire(child, signal)
  }

  /** Waits for a next turn, or a model re-entry. Clean stops cancel only between-turn waits. */
  acquire(child: AdmissionWork, signal?: AbortSignal): Promise<void> {
    let cancel: () => void
    return new Promise<void>((resolve) => {
      const entry = { child, go: resolve }
      cancel = () => {
        this.#queue = this.#queue.filter((e) => e !== entry)
        resolve()
      }
      if (signal) signal.addEventListener("abort", cancel, { once: true })
      else child.waiting = cancel
      if (signal?.aborted) return cancel()
      this.#queue.push(entry)
      this.#yieldToolParents(child)
      this.admit()
    }).finally(() => {
      if (signal) signal.removeEventListener("abort", cancel)
      else child.waiting = undefined
    })
  }

  /** A requester's consultation uses its held turn place, or waits through the same admission. */
  acquireConsultation(child: AdmissionWork, signal: AbortSignal): Promise<() => void> {
    const release = () => {
      this.#consulting.delete(child)
      // A live turn keeps its reservation, including a user pause, until model re-entry.
      if (this.#parents.has(child.id)) this.#running.add(child)
      this.admit()
    }
    if (signal.aborted) return Promise.resolve(() => {})
    if (this.#running.has(child) && !this.#yielded.has(child)) {
      this.#consulting.add(child)
      return Promise.resolve(release)
    }
    // Preserve tool-wait/yield state: after the consultation, its own model must reacquire.
    this.#running.delete(child)
    let cancel: () => void
    return new Promise<() => void>((resolve) => {
      const entry = { child, consultation: true, go: () => resolve(release) }
      cancel = () => {
        this.#queue = this.#queue.filter((e) => e !== entry)
        resolve(() => {})
      }
      signal.addEventListener("abort", cancel, { once: true })
      this.#queue.push(entry)
      this.#yieldToolParents(child)
      this.admit()
    }).finally(() => signal.removeEventListener("abort", cancel))
  }

  /** Its turn ended or it went idle: no longer running. Does not admit by itself. */
  release(child: AdmissionWork): void {
    this.#running.delete(child)
    this.#toolWaits.delete(child)
    this.#yielded.delete(child)
  }

  /** Drops a not-yet-started child from the queue. */
  dequeue(child: AdmissionWork): void {
    this.#queue = this.#queue.filter((e) => e.child !== child)
  }

  /** No longer needed when tracing live descendants. */
  childEnded(child: AdmissionWork): void {
    this.#parents.delete(child.id)
  }
}
