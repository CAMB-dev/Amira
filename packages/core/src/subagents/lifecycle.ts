import type { AgentTree } from "../subagents.ts"

/** spawn refused: too deep, budget spent, a group's limit reached or an unknown model. */
export class SpawnError extends Error {}

const scopes = new WeakMap<AgentTree, ScopeAdmission>()

/** Internal lifecycle ownership, independent of the host's shared concurrency scheduler. */
export function scopeAdmission(tree: AgentTree): ScopeAdmission {
  let scope = scopes.get(tree)
  if (!scope) {
    scope = new ScopeAdmission(tree)
    scopes.set(tree, scope)
  }
  return scope
}

class ScopeAdmission {
  #released = false
  #abort = new AbortController()
  #pending = new Set<Promise<unknown>>()
  #holds = new Set<symbol>()
  #closedParents = new Set<string>()

  constructor(private readonly tree: AgentTree) {}

  check(parent: string): void {
    this.checkExecution()
    for (let id: string | undefined = parent; id; id = this.tree.subagent(id)?.info.parentSessionId) {
      if (this.#closedParents.has(id)) throw new SpawnError("the spawning parent has ended or stopped")
    }
  }

  /** Graceful parent stop revokes spawning, not the tool operations of its current turn. */
  checkExecution(): void {
    if (this.#released) throw new SpawnError("the agent tree scope has been released")
    if (this.#holds.size) throw new SpawnError("the agent tree scope is stopping")
  }

  get signal(): AbortSignal {
    return this.#abort.signal
  }

  /** Tool-session questions and artifact writes can outlive their originating tool call. */
  async track<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation()
    this.#pending.add(pending)
    try {
      return await pending
    } finally {
      this.#pending.delete(pending)
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#pending])
  }

  /** Close admission without invoking cancellation callbacks; the owner may persist first. */
  fence(): () => void {
    const hold = Symbol()
    this.#holds.add(hold)
    return () => {
      this.#holds.delete(hold)
      if (!this.#holds.size && !this.#released) this.#abort = new AbortController()
    }
  }

  cancel(): void {
    this.#abort.abort(new Error("the agent tree scope is stopping"))
  }

  /** Close before cancellation takes its snapshot; reopening never revives old parents. */
  suspend(): () => void {
    const resume = this.fence()
    this.cancel()
    return resume
  }

  /** Permanently revoke a parent only when the session itself is ending, not its children. */
  closeParent(id: string): void {
    this.#closedParents.add(id)
  }

  /** A new Agent for a durable session id (resume, rewind, reopened conversation) may spawn. */
  reopenParent(id: string): void {
    this.#closedParents.delete(id)
  }

  release(): void {
    this.#released = true
    this.#abort.abort(new Error("the agent tree scope has been released"))
  }

  /** Caller cancellation closes admission until the owned root's execution has drained. */
  runRoot<T>(parent: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    try {
      this.check(parent)
    } catch (error) {
      return Promise.reject(error)
    }
    let resume: (() => void) | undefined
    const abort = () => {
      resume ??= this.suspend()
    }
    signal.addEventListener("abort", abort, { once: true })
    return task().finally(() => {
      signal.removeEventListener("abort", abort)
      resume?.()
    })
  }
}
