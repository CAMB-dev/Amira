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
  #holds = new Set<symbol>()
  #closedParents = new Set<string>()

  constructor(private readonly tree: AgentTree) {}

  check(parent: string): void {
    if (this.#released) throw new SpawnError("the agent tree scope has been released")
    if (this.#holds.size) throw new SpawnError("the agent tree scope is stopping")
    for (let id: string | undefined = parent; id; id = this.tree.subagent(id)?.info.parentSessionId) {
      if (this.#closedParents.has(id)) throw new SpawnError("the spawning parent has ended or stopped")
    }
  }

  /** Close before cancellation takes its snapshot; reopening never revives old parents. */
  suspend(): () => void {
    const hold = Symbol()
    this.#holds.add(hold)
    return () => {
      this.#holds.delete(hold)
    }
  }

  /** Permanently revoke a parent only when the session itself is ending, not its children. */
  closeParent(id: string): void {
    this.#closedParents.add(id)
  }

  release(): void {
    this.#released = true
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
