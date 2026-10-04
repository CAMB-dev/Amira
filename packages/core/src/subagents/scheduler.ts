import type { Child } from "./child.ts"

/** Queues children and gives them places to run within the tree's and their groups' limits (D63). */
export class Admission {
  /** Children waiting for a place to run, in order, with what starts them. */
  #queue: { child: Child; go: () => void }[] = []
  /** Children whose turn is running (or about to start). */
  #running = new Set<Child>()
  /** How many queued or running children each session has; sessions without any are left out. */
  #liveKids = new Map<string, number>()

  constructor(private deps: { maxConcurrent: number }) {}

  /** Counts the child under its parent and queues it with what starts it; then admits. */
  enqueue(child: Child, parentSessionId: string, go: () => void): void {
    this.#liveKids.set(parentSessionId, (this.#liveKids.get(parentSessionId) ?? 0) + 1)
    this.#queue.push({ child, go })
    // A parent with children is waiting for them, so it stops counting against the limit.
    this.admit()
  }

  /** Busy children: running a turn, and not just waiting for children of their own. */
  #busy(among: Iterable<Child>): number {
    let n = 0
    for (const c of among)
      if (this.#running.has(c) && (c.agent.execution.paused || !this.#liveKids.has(c.id))) n++
    return n
  }

  /**
   * Starts queued children, oldest first, while fewer than maxConcurrent are busy tree-wide
   * (D63) and in each of their groups. A running child that has children of its own is not
   * busy: it waits for them, and counting it could leave its children queued forever behind
   * it. A child whose group is full waits without holding up those behind it.
   */
  admit(): void {
    let busy = this.#busy(this.#running)
    for (let i = 0; i < this.#queue.length && busy < this.deps.maxConcurrent; ) {
      const entry = this.#queue[i]!
      const full = entry.child.groups.some(
        (g) => g.limits.maxConcurrent !== undefined && this.#busy(g.live) >= g.limits.maxConcurrent,
      )
      if (full) {
        i++
        continue
      }
      this.#queue.splice(i, 1)
      entry.child.admitted = true
      this.#running.add(entry.child)
      busy++
      // Started a microtask later, so the caller can subscribe to child.events first.
      queueMicrotask(entry.go)
    }
  }

  /** Waits for a place to run the child's next turn; a stop or an abort ends the wait too. */
  acquire(child: Child): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry = { child, go: resolve }
      child.waiting = () => {
        this.#queue = this.#queue.filter((e) => e !== entry)
        resolve()
      }
      this.#queue.push(entry)
      this.admit()
    }).finally(() => {
      child.waiting = undefined
    })
  }

  /** Its turn ended or it went idle: no longer running. Does not admit by itself. */
  release(child: Child): void {
    this.#running.delete(child)
  }

  /** Drops a not-yet-started child from the queue. */
  dequeue(child: Child): void {
    this.#queue = this.#queue.filter((e) => e.child !== child)
  }

  /** One fewer live child under its parent. */
  childEnded(child: Child): void {
    const kids = (this.#liveKids.get(child.parentSessionId) ?? 1) - 1
    if (kids > 0) this.#liveKids.set(child.parentSessionId, kids)
    else this.#liveKids.delete(child.parentSessionId)
  }
}
