import type { WorkspaceFacts } from "@amira/api"
import type { EventBus } from "./event-bus.ts"
import { probeWorkspace, type WorkspaceOptions, workspaceFor } from "./workspace.ts"

export type GitInfo = Omit<WorkspaceFacts, "cwd">

/** @deprecated Use a registered workspace provider. Returns no facts without one for cwd. */
export async function gitInfo(
  cwd: string,
  timeoutMs = 15_000,
  opts: { dirty?: boolean } = {},
): Promise<GitInfo> {
  const { cwd: _, dirty, ...info } = (await probeWorkspace(cwd, timeoutMs)) ?? { cwd }
  return opts.dirty && dirty !== undefined ? { ...info, dirty } : info
}

/** @deprecated The extension host tracks workspace providers automatically on session.start. */
export function trackWorkspace(
  bus: EventBus,
  sessionId: string,
  cwd: string,
  opts: WorkspaceOptions = {},
): () => void {
  return workspaceFor(bus).start(sessionId, cwd, opts)
}
