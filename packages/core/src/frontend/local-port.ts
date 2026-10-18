import type { AnyEvent } from "@amira/api"
import type { Agent } from "../agent.ts"
import type { CommandHost } from "../commands.ts"
import { localSnapshotProjector } from "./local-snapshot.ts"
import type { AgentPort, FrontendOperations, FrontendUpdate } from "./port.ts"

export interface LocalAgentPortOptions {
  agent: Agent
  commands?: Pick<CommandHost, "onSwitch">
}

/** Owns projection and identities, never the agent's lifetime or local presentation registries. */
export function createLocalAgentPort(options: LocalAgentPortOptions): AgentPort {
  let agent = options.agent
  let sessionGeneration = 1
  const listeners = new Set<(update: FrontendUpdate) => void>()
  let detached = false
  let project = localSnapshotProjector(agent)
  let snapshot = project(sessionGeneration)
  let failure: Error | undefined

  function publish(update: FrontendUpdate) {
    for (const listener of listeners) {
      try {
        listener(update)
      } catch {
        // Like EventBus subscribers, one frontend listener cannot block the others.
      }
    }
  }
  function refresh(invalidate: boolean | string = false) {
    if (detached) return
    try {
      const next = project(sessionGeneration, invalidate)
      const changed = failure !== undefined || next !== snapshot
      snapshot = next
      failure = undefined
      if (changed) publish({ kind: "snapshot", snapshot })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Frontend projection failed"
      const changed = failure?.message !== message
      failure = new Error(message)
      if (changed) publish({ kind: "error", error: { code: "invalid_snapshot", message } })
    }
  }
  function onEvent(event: AnyEvent) {
    // R1 projects settled history/state, not streaming partials (the capture seam is B07).
    if (event.type === "message.delta" || event.type === "tool.execute.update") return
    if (
      event.sessionId !== agent.sessionId &&
      event.sessionId !== "host" &&
      event.type !== "subagent.start" &&
      event.type !== "subagent.end"
    )
      return
    refresh(
      event.type === "tool.execute.start" || event.type === "tool.execute.end"
        ? event.data.toolCallId
        : event.type === "compact.end" || event.type === "model.changed",
    )
  }
  let offBus = agent.bus.subscribe(onEvent)
  const offSwitch = options.commands?.onSwitch((next) => {
    offBus()
    agent = next
    sessionGeneration++
    project = localSnapshotProjector(agent)
    offBus = agent.bus.subscribe(onEvent)
    refresh()
  })

  return {
    get snapshot() {
      return snapshot
    },
    subscribe(listener) {
      if (!detached) {
        listeners.add(listener)
        if (failure) {
          try {
            listener({ kind: "error", error: { code: "invalid_snapshot", message: failure.message } })
          } catch {
            // A newly attached listener is isolated just like existing subscribers.
          }
        }
      }
      return () => {
        listeners.delete(listener)
      }
    },
    async execute<K extends keyof FrontendOperations>(operation: K) {
      if (failure) throw failure
      // Both reads are from the same cached projection, not live stores or remote getters.
      const results = { "state.read": snapshot.state, "transcript.read": snapshot.transcript }
      if (!Object.hasOwn(results, operation)) throw new Error(`Unknown frontend operation: ${operation}`)
      return results[operation]
    },
    async detach() {
      if (detached) return
      detached = true
      offBus()
      offSwitch?.()
      listeners.clear()
    },
  }
}
