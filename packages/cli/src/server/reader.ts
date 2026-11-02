import { type FrontendExecuteOptions, FrontendOperationError, type FrontendOperations } from "@amira/core"
import { RemoteReplyError } from "../remote/errors.ts"
import { REMOTE_OPERATION_ACCESS, type RemoteOperation } from "../remote/protocol.ts"
import type { ServerOperationOptions, ServerOperations } from "./operations.ts"
import type { WorkspaceAttachment } from "./runtime.ts"

/** Viewer reads that may wait or stream large output; at most this many run per reader. */
export const VIEWER_LONG_READS: ReadonlySet<RemoteOperation> = new Set([
  "jobs.wait",
  "jobs.output",
  "conversations.history",
])
export const VIEWER_LONG_READ_LIMIT = 8

/**
 * A non-exclusive, read-only handle on the workspace. It has no effects, subscriptions or lease,
 * and its reads are not runtime activity: a reader never keeps the workspace from going idle.
 */
export interface WorkspaceReader
  extends Pick<
    WorkspaceAttachment,
    "identity" | "snapshot" | "pendingRequests" | "supportedOperations" | "execute" | "request"
  > {
  /** Aborts this reader's in-flight reads; later calls are disconnected. */
  close(): void
}

export function createWorkspaceReader(deps: {
  view: Pick<WorkspaceAttachment, "identity" | "snapshot" | "pendingRequests" | "supportedOperations">
  lifetime: AbortSignal
  execute<K extends keyof FrontendOperations>(
    operation: K,
    params: FrontendOperations[K]["params"],
    options: FrontendExecuteOptions,
  ): Promise<FrontendOperations[K]["result"]>
  request<K extends keyof ServerOperations>(
    operation: K,
    params: ServerOperations[K]["params"],
    options: ServerOperationOptions,
  ): Promise<ServerOperations[K]["result"]>
  /** Receives every read so the owner can drain it on stop. */
  track(read: Promise<unknown>): void
}): WorkspaceReader {
  const closed = new AbortController()
  // History cuts are scoped to this reader, so other connections' paging never evicts them.
  const owner = {}
  let longReads = 0
  async function guarded<T>(
    operation: RemoteOperation,
    signal: AbortSignal | undefined,
    read: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (closed.signal.aborted || deps.lifetime.aborted)
      throw new FrontendOperationError("disconnected", "This reader is closed")
    if (!REMOTE_OPERATION_ACCESS[operation]?.viewer)
      throw new RemoteReplyError("not_controller", "Only the controller may run this operation")
    const long = VIEWER_LONG_READS.has(operation)
    if (long && longReads >= VIEWER_LONG_READ_LIMIT)
      throw new RemoteReplyError("limit_exceeded", "Too many concurrent long reads on this viewer")
    if (long) longReads++
    try {
      const result = read(AbortSignal.any([deps.lifetime, closed.signal, ...(signal ? [signal] : [])]))
      deps.track(result)
      return await result
    } finally {
      if (long) longReads--
    }
  }
  return {
    get identity() {
      return deps.view.identity
    },
    get snapshot() {
      return deps.view.snapshot
    },
    get pendingRequests() {
      return deps.view.pendingRequests
    },
    supportedOperations: deps.view.supportedOperations,
    execute(operation, params, options) {
      return guarded(operation, options?.signal, (signal) =>
        deps.execute(operation, params, { ...options, signal }),
      )
    },
    request(operation, params, options) {
      return guarded(operation, options?.signal, (signal) =>
        deps.request(operation, params, { ...options, signal, owner }),
      )
    },
    close() {
      closed.abort()
    },
  }
}
