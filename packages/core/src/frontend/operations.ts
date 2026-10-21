import type { FileRewindPlan, KeyHelp, OwnedConversation, PermissionMode, UserMessage } from "@amira/api"
import type { CommandOutcome, CommandRunOptions } from "../commands.ts"
import { conversationIncarnation, isConversationIncarnation } from "../session-routing.ts"
import type { AgentPort } from "./port.ts"

export interface FrontendAcknowledgement {
  readonly sessionGeneration: number
}

export interface FrontendCommandParams {
  line: string
  invocationId?: string
  keys?: KeyHelp[]
  glyphs?: { separator: string; more: string }
}

/** Finite, JSON-compatible mutations. Executable presentation callbacks stay local. */
export interface FrontendMutations {
  "permissions.cycle": {
    params: Record<string, never>
    result: FrontendAcknowledgement & { mode: PermissionMode }
  }
  "turn.prompt": {
    params: { message: string | UserMessage; turnId?: string; expectedHoldId?: string }
    result: FrontendAcknowledgement
  }
  "turn.steer": {
    params: {
      message: string | UserMessage
      turnId?: string
      expectedTurnId?: string
      expectedHoldId?: string
      expectedIdle?: boolean
    }
    result: FrontendAcknowledgement
  }
  "turn.abort": { params: { turnId?: string; holdId?: string }; result: FrontendAcknowledgement }
  "command.run": { params: FrontendCommandParams; result: CommandOutcome }
  "skill.run": { params: FrontendCommandParams; result: CommandOutcome }
  "input.run": { params: FrontendCommandParams; result: CommandOutcome }
  "session.resume": { params: { id: string }; result: FrontendAcknowledgement }
  "session.clear": { params: Record<string, never>; result: FrontendAcknowledgement }
  "session.fork": { params: { index: number }; result: FrontendAcknowledgement }
  "session.rewind": {
    params: { index: number; restoreFiles?: boolean }
    result: FrontendAcknowledgement
  }
  "session.planRewind": { params: { index: number }; result: FileRewindPlan }
  "conversation.send": {
    params: { conversationId: string; incarnation: string; message: string | UserMessage; turnId?: string }
    result: FrontendAcknowledgement
  }
  "conversation.stop": {
    params: {
      conversationId: string
      incarnation: string
      reason?: string
      expectedTurnId?: string
      expectedHoldId?: string
    }
    result: FrontendAcknowledgement
  }
}

export interface FrontendExecuteOptions {
  signal?: AbortSignal
  /** Captured at submission, never silently retarget an operation after a switch. */
  sessionGeneration?: number
  operationId?: string
}

export type FrontendErrorCode =
  | "agent_busy"
  | "stale_session"
  | "stale_operation"
  | "cancelled"
  | "disconnected"
  | "unsupported_operation"
  | "operation_failed"

export class FrontendOperationError extends Error {
  constructor(
    readonly code: FrontendErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Error facts survive JSON transport; frontends must not use instanceof for admission failures. */
export function isFrontendError(error: unknown, code: FrontendErrorCode): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

// Local extension presentation is deliberately outside the operation DTOs. A remote adapter
// implements explicit frontend effects instead of serializing these callbacks/owned handles.
interface LocalCommandBinding {
  context: CommandRunOptions
  settled?: () => void
}
const localContexts = new WeakMap<AgentPort, Map<string, LocalCommandBinding>>()
export function bindLocalCommandContext(
  port: AgentPort,
  invocationId: string,
  context: CommandRunOptions,
  settled?: () => void,
): () => void {
  let contexts = localContexts.get(port)
  if (!contexts) {
    contexts = new Map()
    localContexts.set(port, contexts)
  }
  const binding = { context, settled }
  contexts.set(invocationId, binding)
  return () => {
    if (contexts.get(invocationId) === binding) contexts.delete(invocationId)
  }
}

export function localCommandContext(port: AgentPort, invocationId?: string): CommandRunOptions | undefined {
  return invocationId ? localContexts.get(port)?.get(invocationId)?.context : undefined
}

/** Local command activity ends at host settlement, before the port validates its acknowledgement. */
export function settleLocalCommand(port: AgentPort, invocationId?: string): void {
  if (invocationId) localContexts.get(port)?.get(invocationId)?.settled?.()
}

const localConversations = new WeakMap<AgentPort, Map<string, { conversation: OwnedConversation }>>()
export interface LocalConversationBinding {
  (): void
  readonly incarnation: string
}

/** Compatibility for local native focus; the remote runtime issues the same opaque metadata. */
export function bindLocalConversation(
  port: AgentPort,
  conversation: OwnedConversation,
): LocalConversationBinding {
  let conversations = localConversations.get(port)
  if (!conversations) {
    conversations = new Map()
    localConversations.set(port, conversations)
  }
  const incarnation = conversationIncarnation(conversation)
  if (!isConversationIncarnation(conversation, incarnation))
    throw new FrontendOperationError("stale_operation", "The conversation has been released")
  const binding = { conversation }
  conversations.set(conversation.id, binding)
  return Object.assign(
    () => {
      if (conversations.get(conversation.id) === binding) conversations.delete(conversation.id)
    },
    { incarnation },
  )
}

export function localConversation(port: AgentPort, id: string, incarnation: string): OwnedConversation {
  const conversation = localConversations.get(port)?.get(id)?.conversation
  if (!conversation || !isConversationIncarnation(conversation, incarnation))
    throw new FrontendOperationError("stale_operation", "The conversation incarnation has changed")
  return conversation
}
