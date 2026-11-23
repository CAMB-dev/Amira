import type { Usage } from "@amira/ai"
import type { BackgroundJobSession, SpawnGroup } from "@amira/api"
import type { Agent } from "../agent.ts"
import type { AgentTreeHost, AgentTreeScope } from "./types.ts"

/**
 * Runtime integration seams registered by `@amira/host`. When `@amira/core` is used
 * standalone without `@amira/host`, every hook falls back to a safe no-op.
 */
export interface AgentHostHooks {
  registerSession(agent: Agent): void
  unregisterSession(agent: Agent): void
  holdsSession(agent: Agent): boolean
  recordStandaloneUsage(agent: Agent, usage: Usage): void
  scopeBackgroundJobs(
    jobs: BackgroundJobSession | undefined,
    agent: Agent,
    disposed: () => boolean,
  ): BackgroundJobSession | undefined
  treeScope(tree: AgentTreeHost): AgentTreeScope | undefined
  bindGroupSignal(group: SpawnGroup, signal: AbortSignal): SpawnGroup
}

const hooks: AgentHostHooks = {
  registerSession: () => {},
  unregisterSession: () => {},
  holdsSession: () => false,
  recordStandaloneUsage: () => {},
  scopeBackgroundJobs: (jobs) => jobs,
  treeScope: (tree) => tree.scope?.(),
  bindGroupSignal: (group) => group,
}

export function registerAgentHostHooks(partial: Partial<AgentHostHooks>): void {
  Object.assign(hooks, partial)
}

export const agentHostHooks: Readonly<AgentHostHooks> = hooks
