import type { Agent } from "@amira/core"
import { heldInputSnapshot, holdStateSnapshot } from "../../../core/src/agent/held-input.ts"
import {
  noticeInputAgents,
  noticeInputSnapshot,
  steeringInputSnapshot,
} from "../../../core/src/agent/notice-input.ts"
import { freezeSnapshot, frontendJson } from "../../../core/src/frontend/json.ts"
import { type RemoteJobInfo, type RemoteOwnerState, validateRemoteDto } from "../remote-schema.ts"
import type { Session } from "../session-factory.ts"
import type { ServerUiRequest } from "./runtime.ts"

/** One reset authority for queued/pending state. No event projection or replay cache is read.
 * Every call samples live host owners and registries synchronously at the journal cut.
 */
export function createPendingStateReader(deps: {
  root: () => Agent
  host: Session["host"]
  pending: () => readonly ServerUiRequest[]
}) {
  const bus = deps.root().bus
  const liveOwners = () => noticeInputAgents(bus)

  function jobs(agents = liveOwners()): RemoteJobInfo[] {
    const root = deps.root()
    const visible = new Set([root.sessionId, ...agents.map((owner) => owner.sessionId)])
    const publicOwner = (id: string): boolean => {
      const seen = new Set<string>()
      while (!visible.has(id)) {
        if (seen.has(id)) return false
        seen.add(id)
        // The public tree retains finished children too, but excludes private-bus children.
        const parent = root.tree?.subagent(id)?.info.parentSessionId
        if (!parent) return false
        id = parent
      }
      return true
    }
    return deps.host.backgroundJobs
      .list()
      .filter((job) => !job.owner || publicOwner(job.owner))
      .map((job) => {
        const { meta: _meta, error: _error, logPath: _path, logError: _logError, ...publicJob } = job
        const dto = frontendJson(publicJob)
        validateRemoteDto("backgroundJob", dto)
        return freezeSnapshot(dto) as unknown as RemoteJobInfo
      })
  }

  return {
    liveOwners,
    jobs,
    read() {
      const agents = liveOwners()
      const owners: Record<string, RemoteOwnerState> = Object.create(null)
      for (const agent of agents) {
        const dto = frontendJson({
          ...(agent.parentSessionId !== undefined ? { parentSessionId: agent.parentSessionId } : {}),
          status: agent.status,
          busy: agent.busy,
          turnId: agent.turnId ?? null,
          hold: holdStateSnapshot(agent),
          inputQueue: heldInputSnapshot(agent),
          steering: steeringInputSnapshot(agent),
          noticeInbox: noticeInputSnapshot(agent),
          noticeRetry: agent.noticeRetry ?? null,
        })
        validateRemoteDto("ownerState", dto)
        owners[agent.sessionId] = freezeSnapshot(dto) as unknown as RemoteOwnerState
      }
      // Host-facing asks/forms can intentionally be forwarded from private work; do not
      // hide them by filtering their display sessionId through the live owner registry.
      return { owners: freezeSnapshot(owners), pendingRequests: deps.pending(), jobs: jobs(agents) }
    },
  }
}
