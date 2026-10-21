import type { AnyEvent } from "@amira/api"
import type { FrontendUpdate } from "@amira/core"
import { freezeSnapshot } from "../../../core/src/frontend/json.ts"
import { FrontendProjection } from "../../../core/src/frontend/projection.ts"
import type { RemoteWorkspaceSnapshot } from "../remote-schema.ts"
import type { ServerEvent } from "../server/runtime.ts"
import type { RemoteJson } from "./protocol.ts"

/** The wire decoder has validated these discriminated payloads before they reach the port. */
export type RemoteWorkspaceUpdate =
  | FrontendUpdate
  | { kind: "effect"; effect: import("../server/runtime.ts").ServerEffect }
  | { kind: "startup"; events: RemoteWorkspaceSnapshot["startupEvents"] }
  | { kind: "semantic"; semantic: RemoteWorkspaceSnapshot["semantic"] }
  | { kind: "jobs"; jobs: RemoteWorkspaceSnapshot["jobs"] }
  | ({
      kind: "inputQueue" | "noticeInbox" | "noticeRetry" | "steering" | "hold"
      sessionId: string
      sessionGeneration: number
    } & Partial<RemoteWorkspaceSnapshot["owners"][string]>)
  | ServerEvent

/** Only authoritative payloads update caches; events are never executed as local commands. */
export class RemoteAgentState {
  workspace?: RemoteWorkspaceSnapshot
  private activity = new FrontendProjection()
  error?: Extract<FrontendUpdate, { kind: "error" }>

  reset(value: RemoteJson): void {
    this.workspace = freezeSnapshot(value) as unknown as RemoteWorkspaceSnapshot
    this.error = undefined
    this.activity.clear()
    for (const event of this.workspace.activity.events) this.activity.capture(event as AnyEvent)
  }

  apply(value: RemoteJson): RemoteWorkspaceUpdate {
    const update = freezeSnapshot(value) as unknown as RemoteWorkspaceUpdate
    const workspace = this.workspace!
    if ("kind" in update) {
      switch (update.kind) {
        case "snapshot":
          this.error = undefined
          this.workspace = {
            ...workspace,
            frontend: update.snapshot as unknown as RemoteWorkspaceSnapshot["frontend"],
          }
          break
        case "error":
          this.error = update
          break
        case "semantic":
          this.workspace = { ...workspace, semantic: update.semantic }
          break
        case "jobs":
          this.workspace = { ...workspace, jobs: update.jobs }
          break
        case "startup":
          this.workspace = { ...workspace, startupEvents: update.events }
          break
        case "inputQueue":
        case "noticeInbox":
        case "noticeRetry":
        case "steering":
        case "hold": {
          if (update.sessionGeneration !== workspace.frontend.sessionGeneration) break
          const owner = workspace.owners[update.sessionId]
          if (owner)
            this.workspace = {
              ...workspace,
              owners: {
                ...workspace.owners,
                [update.sessionId]: { ...owner, [update.kind]: update[update.kind] },
              },
            }
          break
        }
      }
    } else if (update.type === "ui.request") {
      this.workspace = {
        ...workspace,
        pendingRequests: [
          ...workspace.pendingRequests.filter((request) => request.requestId !== update.data.requestId),
          update.data as RemoteWorkspaceSnapshot["pendingRequests"][number],
        ],
      }
    } else if (update.type === "ui.resolved") {
      this.workspace = {
        ...workspace,
        pendingRequests: workspace.pendingRequests.filter(
          (request) => request.requestId !== update.data.requestId,
        ),
      }
    }
    if (!("kind" in update)) {
      if (update.type !== "turn.steer" && update.type !== "notice.retry")
        this.activity.capture(update as AnyEvent)
      const owner = this.workspace!.owners[update.sessionId]
      if (owner) {
        const patch =
          update.type === "status.changed"
            ? {
                status: update.data.status,
                busy: update.data.status === "working" || update.data.status === "blocked",
              }
            : update.type === "turn.start"
              ? { busy: true, turnId: update.turnId ?? owner.turnId }
              : update.type === "turn.end" || update.type === "session.end"
                ? { busy: false, turnId: null }
                : {}
        this.workspace = {
          ...this.workspace!,
          owners: { ...this.workspace!.owners, [update.sessionId]: { ...owner, ...patch } },
        }
      }
      this.workspace = {
        ...this.workspace!,
        activity: this.activity.inFlightSnapshot() as unknown as RemoteWorkspaceSnapshot["activity"],
      }
    }
    this.workspace = freezeSnapshot(this.workspace)
    return update
  }
}
