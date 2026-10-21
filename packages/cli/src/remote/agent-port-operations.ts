import { createHash, randomUUID } from "node:crypto"
import type { FrontendExecuteOptions, FrontendOperations } from "@amira/core"
import { frontendJson } from "../../../core/src/frontend/json.ts"
import { copyRemoteJson } from "../remote-schema.ts"
import type { ServerOperations } from "../server/operations.ts"
import type { RemoteConnection } from "./connection.ts"
import { RemoteError, RemoteReplyError } from "./errors.ts"
import type { RemoteJson, RemoteWelcome } from "./protocol.ts"

type Operations = FrontendOperations & ServerOperations
interface Operation {
  fingerprint: string
  epoch: string
  generation: number
  connection: RemoteConnection
  promise: Promise<unknown>
  uncertain: boolean
}

/** Retain explicit caller identities, including their original epoch and session scope. */
export class RemoteAgentOperations {
  private operations = new Map<string, Operation>()

  async run<K extends keyof Operations>(
    connection: RemoteConnection,
    welcome: RemoteWelcome,
    generation: number,
    operation: K,
    params: Operations[K]["params"],
    options: FrontendExecuteOptions = {},
  ): Promise<Operations[K]["result"]> {
    if (options.signal?.aborted)
      return Promise.reject(new RemoteError("cancelled", "Remote request cancelled"))
    const id = options.operationId ?? randomUUID()
    const previous = this.operations.get(id)
    const dto = copyRemoteJson(frontendJson(params)) as { [key: string]: RemoteJson }
    const fingerprint = createHash("sha256")
      .update(canonical([operation, dto, options.sessionGeneration ?? previous?.generation ?? generation]))
      .digest("hex")
    if (previous && previous.fingerprint !== fingerprint)
      return Promise.reject(
        new RemoteReplyError("operation_conflict", "Remote operation identity was reused"),
      )
    if (previous && (!previous.uncertain || previous.connection === connection))
      return previous.promise as Promise<Operations[K]["result"]>
    if (options.operationId && !previous && this.operations.size >= 4_096)
      return Promise.reject(new RemoteError("limit_exceeded", "Remote operation identity capacity exhausted"))
    const record: Operation = {
      fingerprint,
      epoch: previous?.epoch ?? welcome.daemonEpoch,
      generation: previous?.generation ?? options.sessionGeneration ?? generation,
      connection,
      uncertain: false,
      promise: Promise.resolve(),
    }
    record.promise = connection
      .request(operation, dto, {
        ...options,
        operationId: id,
        daemonEpoch: record.epoch,
        sessionGeneration: record.generation,
      })
      .catch((error) => {
        // Connection failures (including replay gaps) are not authoritative operation replies.
        // Retain their original epoch/identity for ledger-safe retry after reconnect.
        record.uncertain =
          (!(error instanceof RemoteReplyError) || error === connection.failureReason) &&
          !(error instanceof RemoteError && error.code === "cancelled")
        throw error
      })
    if (options.operationId) this.operations.set(id, record)
    return record.promise as Promise<Operations[K]["result"]>
  }

  clear(): void {
    this.operations.clear()
  }
}

function canonical(value: RemoteJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
    .join(",")}}`
}
