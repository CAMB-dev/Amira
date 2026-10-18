export type RemoteErrorCode =
  | "invalid_frame"
  | "incompatible_protocol"
  | "limit_exceeded"
  | "disconnected"
  | "cancelled"
  | "operation_failed"
  | "unsupported_operation"

/** A validated operation failure keeps the host's stable code (e.g. agent_busy). */
export class RemoteReplyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "RemoteReplyError"
  }
}

/** Transport errors carry stable facts, never arbitrary exception objects or stacks. */
export class RemoteError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "RemoteError"
  }
}
