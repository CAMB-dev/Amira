import type { OwnedConversation, UserMessage } from "@amira/api"
import type { Agent } from "../agent.ts"
import type { CommandHost, CommandRunOptions } from "../commands.ts"
import { conversationHoldId, conversationTurnId, sendConversation } from "../session-routing.ts"
import { frontendJson } from "./json.ts"
import {
  type FrontendExecuteOptions,
  type FrontendMutations,
  FrontendOperationError,
  localCommandContext,
  settleLocalCommand,
} from "./operations.ts"
import type { AgentPort } from "./port.ts"

type Handlers = {
  [K in keyof FrontendMutations]: (
    params: FrontendMutations[K]["params"],
    options?: FrontendExecuteOptions,
  ) => FrontendMutations[K]["result"] | Promise<FrontendMutations[K]["result"]>
}

export function localMutationHandlers(deps: {
  agent: () => Agent
  generation: () => number
  port: () => AgentPort
  commands?: Partial<Pick<CommandHost, "run" | "runSkill" | "runInput" | "control">>
  conversation?: (id: string, incarnation: string) => OwnedConversation | undefined
}): Handlers {
  const ack = () => ({ sessionGeneration: deps.generation() })
  const unsupported = (): never => {
    throw new FrontendOperationError("unsupported_operation", "This frontend operation is unavailable")
  }
  const control = () => deps.commands?.control ?? unsupported()
  const context = (
    params: FrontendMutations["command.run"]["params"],
    options?: FrontendExecuteOptions,
  ): CommandRunOptions => ({
    frontend: "tui",
    ...(params.keys ? { keys: () => params.keys! } : {}),
    ...(params.glyphs ? { glyphs: () => params.glyphs! } : {}),
    ...localCommandContext(deps.port(), params.invocationId),
    ...(options?.signal ? { signal: options.signal } : {}),
  })
  function command(
    method: "run" | "runSkill" | "runInput",
    params: FrontendMutations["command.run"]["params"],
    options?: FrontendExecuteOptions,
  ) {
    const result = deps.commands?.[method]?.(params.line, context(params, options)) ?? unsupported()
    return result.finally(() => settleLocalCommand(deps.port(), params.invocationId))
  }
  const stale = (): never => {
    throw new FrontendOperationError("stale_operation", "The target operation has changed")
  }
  async function prompt(message: string | UserMessage, turnId?: string, expectedHoldId?: string) {
    const agent = deps.agent()
    if (expectedHoldId !== undefined && agent.holdId !== expectedHoldId) stale()
    // Acknowledgement means admission, not turn completion. Preserve held-compaction input.
    if (agent.busy && !agent.holdingFor)
      throw new FrontendOperationError("agent_busy", "a turn or compaction is already running")
    const accepted = ack()
    const turn = agent.prompt(message, { turnId })
    let rejected: { error: unknown } | undefined
    void turn.catch((error: unknown) => {
      rejected = { error }
    })
    // Reject synchronous admission failures without waiting for the paid model/tool work.
    await Promise.resolve()
    if (rejected) throw rejected.error
    return accepted
  }
  const conversation = (id: string, incarnation: string) =>
    deps.conversation?.(id, incarnation) ?? unsupported()
  return {
    "turn.prompt": ({ message, turnId, expectedHoldId }) => prompt(message, turnId, expectedHoldId),
    "turn.steer": ({ message, turnId, expectedTurnId, expectedHoldId, expectedIdle }) => {
      const agent = deps.agent()
      if (expectedTurnId !== undefined && agent.turnId !== expectedTurnId) stale()
      if (expectedHoldId !== undefined && agent.holdId !== expectedHoldId) stale()
      if (expectedIdle && agent.busy) stale()
      if (!agent.busy) return prompt(message, turnId)
      agent.steer(message)
      return ack()
    },
    "turn.abort": ({ turnId, holdId }) => {
      const agent = deps.agent()
      if (
        turnId !== undefined ? agent.turnId === turnId : holdId !== undefined ? agent.holdId === holdId : true
      )
        agent.abort()
      return ack()
    },
    "command.run": (params, options) => command("run", params, options),
    "skill.run": (params, options) => command("runSkill", params, options),
    "input.run": (params, options) => command("runInput", params, options),
    "session.resume": async ({ id }, options) => {
      await control().resume(id, { signal: options?.signal })
      return ack()
    },
    "session.clear": async (_, options) => {
      await control().newSession({ signal: options?.signal })
      return ack()
    },
    "session.fork": async ({ index }, options) => {
      const fork = control().fork ?? unsupported()
      await fork(index, { signal: options?.signal })
      return ack()
    },
    "session.rewind": async ({ index, restoreFiles }, options) => {
      const rewind = control().rewind ?? unsupported()
      await rewind(index, { restoreFiles, signal: options?.signal })
      return ack()
    },
    "session.planRewind": ({ index }) => {
      const plan = control().planRewind ?? unsupported()
      const result = plan(index)
      frontendJson(result)
      return result
    },
    "conversation.send": async ({ conversationId, incarnation, message, turnId }) => {
      const accepted = ack()
      const handle = conversation(conversationId, incarnation)
      const input =
        typeof message === "string"
          ? { role: "user" as const, content: [{ type: "text" as const, text: message }] }
          : message
      const text = input.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
      const images = input.content.flatMap((block) => (block.type === "image" ? [block] : []))
      await sendConversation(
        handle,
        text,
        {
          ...(images.length ? { images } : {}),
          ...(input.display ? { display: input.display } : {}),
        },
        turnId,
      )
      return accepted
    },
    "conversation.stop": async ({ conversationId, incarnation, reason, expectedTurnId, expectedHoldId }) => {
      const accepted = ack()
      const handle = conversation(conversationId, incarnation)
      // The comparison and stop admission share one synchronous host continuation.
      if (
        expectedTurnId !== undefined
          ? conversationTurnId(handle) === expectedTurnId
          : expectedHoldId !== undefined
            ? conversationHoldId(handle) === expectedHoldId
            : true
      )
        await handle.stop(reason)
      return accepted
    },
  }
}
