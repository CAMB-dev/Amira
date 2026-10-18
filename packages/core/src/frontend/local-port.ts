import type { AnyEvent } from "@amira/api"
import { type Agent, AgentBusyError } from "../agent.ts"
import type { CommandHost } from "../commands.ts"
import { frontendJson } from "./json.ts"
import { localMutationHandlers } from "./local-operations.ts"
import { localSnapshotProjector } from "./local-snapshot.ts"
import { type FrontendExecuteOptions, FrontendOperationError, localConversation } from "./operations.ts"
import type { AgentPort, FrontendOperations, FrontendUpdate } from "./port.ts"

export interface LocalAgentPortOptions {
  agent: Agent
  commands?: Pick<CommandHost, "onSwitch"> &
    Partial<Pick<CommandHost, "run" | "runSkill" | "runInput" | "control">>
}

/** Owns projection and identities, never the agent's lifetime or local presentation registries. */
export function createLocalAgentPort(options: LocalAgentPortOptions): AgentPort {
  let agent = options.agent
  let sessionGeneration = 1
  let identity = Object.freeze({ sessionId: agent.sessionId, sessionGeneration })
  const listeners = new Set<(update: FrontendUpdate) => void>()
  let detached = false
  const selections = new Set<AbortController>()
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
  let offSwitch = options.commands?.onSwitch((next) => {
    offBus()
    agent = next
    sessionGeneration++
    identity = Object.freeze({ sessionId: agent.sessionId, sessionGeneration })
    // Queued frontend selections must revalidate after a committed handover's await.
    // A committed winner already detached its caller's cancellation listener.
    for (const selection of selections) selection.abort()
    if (detached) return
    project = localSnapshotProjector(agent)
    offBus = agent.bus.subscribe(onEvent)
    refresh()
  })

  function releaseSwitch() {
    offSwitch?.()
    offSwitch = undefined
  }

  const mutations = localMutationHandlers({
    agent: () => agent,
    generation: () => sessionGeneration,
    port: () => port,
    commands: options.commands,
    conversation: (id, incarnation) => localConversation(port, id, incarnation),
  })
  const port: AgentPort = {
    get identity() {
      return identity
    },
    quitBehavior: "stop",
    supportedOperations: [
      "state.read",
      "transcript.read",
      "turn.prompt",
      "turn.steer",
      "turn.abort",
      "conversation.send",
      "conversation.stop",
      ...(options.commands?.run ? ["command.run" as const] : []),
      ...(options.commands?.runSkill ? ["skill.run" as const] : []),
      ...(options.commands?.runInput ? ["input.run" as const] : []),
      ...(options.commands?.control ? ["session.resume" as const, "session.clear" as const] : []),
      ...(options.commands?.control?.fork ? ["session.fork" as const] : []),
      ...(options.commands?.control?.rewind ? ["session.rewind" as const] : []),
      ...(options.commands?.control?.planRewind ? ["session.planRewind" as const] : []),
    ],
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
    async execute<K extends keyof FrontendOperations>(
      operation: K,
      params: FrontendOperations[K]["params"],
      executeOptions?: FrontendExecuteOptions,
    ) {
      if (detached) throw new FrontendOperationError("disconnected", "This frontend is detached")
      if (executeOptions?.signal?.aborted)
        throw new FrontendOperationError("cancelled", "Frontend operation cancelled")
      if (
        executeOptions?.sessionGeneration !== undefined &&
        executeOptions.sessionGeneration !== sessionGeneration
      )
        throw new FrontendOperationError("stale_session", "The active session changed")
      if (failure && (operation === "state.read" || operation === "transcript.read")) throw failure
      frontendJson(params)
      const admittedGeneration = sessionGeneration
      const selection =
        operation === "session.clear" ||
        operation === "session.resume" ||
        operation === "session.fork" ||
        operation === "session.rewind"
          ? new AbortController()
          : undefined
      if (selection) selections.add(selection)
      const guardedOptions = selection
        ? {
            ...executeOptions,
            signal: AbortSignal.any([
              selection.signal,
              ...(executeOptions?.signal ? [executeOptions.signal] : []),
            ]),
          }
        : executeOptions
      try {
        // The handler table preserves the operation/params/result correlation at this seam.
        const handlers = {
          ...mutations,
          "state.read": () => snapshot.state,
          "transcript.read": () => snapshot.transcript,
        }
        if (!Object.hasOwn(handlers, operation))
          throw new FrontendOperationError(
            "unsupported_operation",
            `Unknown frontend operation: ${operation}`,
          )
        const handler = handlers[operation] as (
          params: FrontendOperations[K]["params"],
          options?: FrontendExecuteOptions,
        ) => FrontendOperations[K]["result"] | Promise<FrontendOperations[K]["result"]>
        const result = await handler(params, guardedOptions)
        frontendJson(result)
        return result
      } catch (error) {
        if (selection?.signal.aborted && admittedGeneration !== sessionGeneration)
          throw new FrontendOperationError("stale_session", "The active session changed during selection")
        if (error instanceof FrontendOperationError) throw error
        throw new FrontendOperationError(
          executeOptions?.signal?.aborted
            ? "cancelled"
            : error instanceof AgentBusyError
              ? "agent_busy"
              : "operation_failed",
          error instanceof Error ? error.message : String(error),
        )
      } finally {
        if (selection) selections.delete(selection)
        if (detached && !selections.size) releaseSwitch()
      }
    },
    async detach() {
      if (detached) return
      detached = true
      offBus()
      if (!selections.size) releaseSwitch()
      listeners.clear()
    },
  }
  return port
}
