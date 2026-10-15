import type { Agent } from "../agent.ts"
import { writeRootPolicy } from "../permissions/write-roots.ts"
import { ToolRunner } from "./tool-runner.ts"

type SessionCapabilities = Pick<
  Agent,
  | "tools"
  | "interceptors"
  | "permissions"
  | "cwd"
  | "sessionId"
  | "maxParallelTools"
  | "fileRewind"
  | "backgroundJobs"
  | "callableTools"
>

/** One session's execution capabilities, shared by model batches and owned tool operations. */
export function setupToolRunner(
  agent: Agent,
  callbacks: Omit<
    ConstructorParameters<typeof ToolRunner>[0],
    keyof SessionCapabilities | "writePolicy" | "isSubAgent"
  >,
): ToolRunner {
  return new ToolRunner({
    tools: agent.tools,
    interceptors: agent.interceptors,
    permissions: agent.permissions,
    cwd: agent.cwd,
    sessionId: agent.sessionId,
    maxParallelTools: agent.maxParallelTools,
    fileRewind: agent.fileRewind,
    backgroundJobs: agent.backgroundJobs,
    callableTools: agent.callableTools,
    writePolicy: agent.writeRoots === undefined ? undefined : writeRootPolicy(agent.writeRoots),
    isSubAgent: agent.depth > 0,
    ...callbacks,
  })
}

/** Drop declarations no longer present, retaining host-disabled deferred tools for later. */
export function checkRestoredTools(agent: Agent, loaded: Set<string>, restored: string[] | undefined): void {
  if (!restored) return
  const unavailable = restored.filter((name) => !agent.tools.has(name))
  for (const name of restored) {
    const tool = agent.tools.get(name)
    if (!agent.tools.has(name) || (tool && tool.exposure !== "deferred")) loaded.delete(name)
  }
  if (!unavailable.length) return
  const error = `tools loaded earlier in this session are no longer available: ${unavailable.join(", ")}`
  agent.bus.emit("extension.error", { source: "session", error }, { sessionId: agent.sessionId })
}
