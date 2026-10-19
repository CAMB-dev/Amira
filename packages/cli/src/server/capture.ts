import type { AnyEvent } from "@amira/api"
import type { Agent, AgentPort, CommandHost } from "@amira/core"
import {
  type HeldInput,
  type HoldState,
  heldInputSnapshot,
  holdStateSnapshot,
  subscribeHeldInputs,
  subscribeHolds,
} from "../../../core/src/agent/held-input.ts"
import {
  type NoticeInputSnapshot,
  noticeInputSnapshot,
  steeringInputSnapshot,
  subscribeNoticeInputs,
} from "../../../core/src/agent/notice-input.ts"
import { type NoticeRetry, subscribeNoticeRetries } from "../../../core/src/agent/notice-retry.ts"
import { freezeSnapshot, frontendJson } from "../../../core/src/frontend/json.ts"
import { localSnapshotProjector } from "../../../core/src/frontend/local-snapshot.ts"
import { FrontendProjection } from "../../../core/src/frontend/projection.ts"
import { agentSessionOwner } from "../../../core/src/session-routing.ts"
import type { RemoteJson } from "../remote/protocol.ts"
import { publicUpdateError } from "../remote/public-errors.ts"
import { copyRemoteJson, validateRemoteDto } from "../remote-schema.ts"
import type { Session } from "../session-factory.ts"
import { ReplayJournal } from "./journal.ts"
import { createPendingStateReader } from "./pending-state.ts"
import type { ServerEvent, ServerUiRequest } from "./runtime.ts"

/** Runtime-owned incremental capture. Resets sample queued state from the host, never replay it. */
export function createWorkspaceCapture(deps: {
  session: Session
  commands: CommandHost
  port: AgentPort
  startupEvents: readonly ServerEvent[]
  eventDto: (event: AnyEvent) => ServerEvent
  pending: () => readonly ServerUiRequest[]
}) {
  const journal = new ReplayJournal()
  const activity = new FrontendProjection()
  const pending = createPendingStateReader({
    root: () => deps.commands.agent,
    host: deps.session.host,
    pending: deps.pending,
  })
  let project = localSnapshotProjector(deps.commands.agent)
  let closed = false
  let scheduled = false
  const scope = (sessionId: string) => ({
    sessionId,
    sessionGeneration: deps.port.identity!.sessionGeneration,
  })
  const semantic = () => {
    const value = frontendJson({
      status: {
        info: deps.commands.control.info(),
        items: deps.session.host.status.snapshot(),
        usage: deps.session.tree.usage,
        budget: deps.session.tree.budget,
      },
      models: deps.commands.control.models().map((ref) => {
        const { provider, id, contextWindow, maxOutput, caps } = deps.session.ai.model(ref)
        return {
          ref,
          provider,
          id,
          contextWindow,
          maxOutput,
          caps,
          available: deps.session.ai.hasKey(provider),
        }
      }),
      subagents: deps.commands.control.subagents(),
      groups: deps.commands.control.groups?.() ?? [],
    })
    validateRemoteDto("workspaceSemantic", value)
    return value
  }
  const scheduleState = () => {
    if (scheduled || closed) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (closed) return
      try {
        journal.append({ kind: "semantic", semantic: semantic() })
      } catch {
        journal.invalidate()
      }
    })
  }
  // null means replaced: never let a retired incarnation publish under its successor's
  // generation. undefined means genuinely removed, for which explicit empty cleanup remains.
  const notificationOwner = (agent: Agent): Agent | null | undefined => {
    const owner = agentSessionOwner(agent.sessionId)
    return owner && owner !== agent ? null : owner
  }
  const publishSteering = (sessionId: string) => {
    const owner = agentSessionOwner(sessionId)
    if (owner && owner.bus !== deps.session.agent.bus) return
    journal.append({
      kind: "steering",
      ...scope(sessionId),
      steering: frontendJson(owner ? steeringInputSnapshot(owner) : []),
    })
  }
  const fail = () => {
    activity.fail()
    journal.invalidate()
  }
  const offBus = deps.session.agent.bus.capture((event) => {
    const dto = deps.eventDto(event)
    if (dto.type === "extension.error" && dto.data.source === "remote:protocol") fail()
    // These describe pending runtime state, not in-flight display content. In particular,
    // a projection budget must not prevent resetting a perfectly readable host inbox.
    else if (event.type !== "turn.steer" && event.type !== "notice.retry")
      activity.capture(dto as typeof event)
    journal.append(frontendJson(dto))
    if (
      event.type === "turn.steer" ||
      event.type === "turn.start" ||
      event.type === "turn.end" ||
      event.type === "session.end"
    )
      publishSteering(event.sessionId)
    if (
      event.type !== "message.delta" &&
      event.type !== "message.stream" &&
      event.type !== "tool.execute.update"
    )
      scheduleState()
  }, fail)
  const offPort = deps.port.subscribe((update) => {
    try {
      const dto = copyRemoteJson(update)
      validateRemoteDto("update", dto)
      const normalized = dto as unknown as { kind: string; error?: { code: string } }
      journal.append(
        normalized.kind === "error" ? copyRemoteJson(publicUpdateError(normalized.error?.code)) : dto,
      )
    } catch {
      journal.invalidate()
      journal.append(copyRemoteJson(publicUpdateError()))
    }
  })
  const offJobs = deps.session.host.backgroundJobs.subscribe(() => {
    try {
      journal.append({ kind: "jobs", jobs: frontendJson(pending.jobs()) })
    } catch {
      journal.invalidate()
    }
  })
  const publishInputQueue = (agent: Agent, _queue: readonly HeldInput[]) => {
    const owner = notificationOwner(agent)
    if (owner === null) return
    const inputQueue = frontendJson(owner ? heldInputSnapshot(owner) : [])
    validateRemoteDto("inputQueue", inputQueue)
    journal.append({ kind: "inputQueue", ...scope(agent.sessionId), inputQueue })
    scheduleState()
  }
  const publishHold = (agent: Agent, _value: HoldState) => {
    const owner = notificationOwner(agent)
    if (owner === null) return
    const hold = frontendJson(owner ? holdStateSnapshot(owner) : null)
    validateRemoteDto("holdState", hold)
    journal.append({ kind: "hold", ...scope(agent.sessionId), hold })
    scheduleState()
  }
  const publishNotices = (agent: Agent, _snapshot: NoticeInputSnapshot) => {
    const owner = notificationOwner(agent)
    if (owner === null) return
    const noticeInbox = frontendJson(owner ? noticeInputSnapshot(owner) : { queue: [], expected: 0 })
    validateRemoteDto("noticeInbox", noticeInbox)
    journal.append({ kind: "noticeInbox", ...scope(agent.sessionId), noticeInbox })
    scheduleState()
  }
  const publishRetry = (agent: Agent, _value: NoticeRetry | undefined) => {
    const owner = notificationOwner(agent)
    if (owner === null) return
    const value = owner?.noticeRetry
    activity.reconcileNoticeRetry(agent.sessionId, value)
    const noticeRetry = frontendJson(value ?? null)
    validateRemoteDto("noticeRetry", noticeRetry)
    journal.append({ kind: "noticeRetry", ...scope(agent.sessionId), noticeRetry })
    scheduleState()
  }
  const bus = deps.session.agent.bus
  const offInputQueue = subscribeHeldInputs(bus, publishInputQueue, () => journal.invalidate())
  const offHolds = subscribeHolds(bus, publishHold, () => journal.invalidate())
  const offNotices = subscribeNoticeInputs(bus, publishNotices, () => journal.invalidate())
  const offRetries = subscribeNoticeRetries(bus, publishRetry, () => journal.invalidate())
  for (const agent of pending.liveOwners()) {
    try {
      const notices = noticeInputSnapshot(agent)
      if (notices.queue.length || notices.expected) publishNotices(agent, notices)
      const inputs = heldInputSnapshot(agent)
      if (inputs.length) publishInputQueue(agent, inputs)
      if (agent.holdId) publishHold(agent, holdStateSnapshot(agent))
      if (agent.noticeRetry) publishRetry(agent, agent.noticeRetry)
    } catch {
      journal.invalidate()
    }
  }
  const offSwitch = deps.commands.onSwitch((agent) => {
    const owners = pending.liveOwners()
    for (const owner of owners) activity.reconcileNoticeRetry(owner.sessionId, owner.noticeRetry)
    activity.reconcileTurns(new Map(owners.map((owner) => [owner.sessionId, owner.turnId])))
    project = localSnapshotProjector(agent)
    try {
      const snapshot = frontendJson(project(deps.port.identity!.sessionGeneration))
      validateRemoteDto("snapshot", snapshot)
      journal.append({ kind: "snapshot", snapshot })
      journal.append({ kind: "jobs", jobs: frontendJson(pending.jobs()) })
      publishInputQueue(agent, heldInputSnapshot(agent))
      publishHold(agent, holdStateSnapshot(agent))
      publishNotices(agent, noticeInputSnapshot(agent))
      publishRetry(agent, agent.noticeRetry)
    } catch {
      journal.invalidate()
    }
    scheduleState()
  })
  return {
    journal,
    snapshot(): RemoteJson {
      const state = pending.read()
      for (const [id, owner] of Object.entries(state.owners))
        activity.reconcileNoticeRetry(id, owner.noticeRetry ?? undefined)
      const frontend = project(deps.port.identity!.sessionGeneration, true)
      validateRemoteDto("snapshot", frontend)
      const snapshot = frontendJson({
        frontend,
        ...state,
        startupEvents: deps.startupEvents,
        activity: activity.inFlightSnapshot(),
        semantic: semantic(),
      })
      validateRemoteDto("workspaceSnapshot", snapshot)
      return freezeSnapshot(snapshot)
    },
    close() {
      closed = true
      offBus()
      offPort()
      offJobs()
      offInputQueue()
      offHolds()
      offNotices()
      offRetries()
      offSwitch()
    },
  }
}
