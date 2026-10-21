import { realpathSync, statSync } from "node:fs"
import type { Agent } from "../agent.ts"

export interface FrontendScopeRoot {
  readonly cwd: string
  readonly ino: number
  readonly dev: number
}
const roots = new WeakMap<Agent, FrontendScopeRoot | undefined>()

/** Establish once at actor construction, before execution/discovery can replace its pathname. */
export function registerAgentScopeRoot(agent: Agent): void {
  if (roots.has(agent)) return
  try {
    // Native spelling agrees with async realpath on Windows (case and 8.3 aliases).
    const cwd = realpathSync.native(agent.cwd)
    const info = statSync(cwd)
    roots.set(agent, info.isDirectory() ? Object.freeze({ cwd, ino: info.ino, dev: info.dev }) : undefined)
  } catch {
    // Local in-memory agents may deliberately use an absent cwd; remote reads must fail closed.
    roots.set(agent, undefined)
  }
}

export function agentScopeRoot(agent: Agent): FrontendScopeRoot {
  const root = roots.get(agent)
  if (!root) throw new Error("The actor has no established filesystem scope")
  return root
}
