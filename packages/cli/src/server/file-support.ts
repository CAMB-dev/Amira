import { type FrontendExecuteOptions, FrontendOperationError } from "@amira/core"
import { matches, type Schema } from "../remote/schema/base.ts"
import { copyRemoteJson } from "../remote/schema/json.ts"

export type OperationHandlers<O extends Record<string, { params: unknown; result: unknown }>> = {
  [K in keyof O]: (params: O[K]["params"], options?: FrontendExecuteOptions) => Promise<O[K]["result"]>
}

export function failure(message: string): never {
  throw new FrontendOperationError("operation_failed", message)
}

/** Capture even when the caller omits its generation, then check again after every await. */
export function operationGuard(generation: () => number, options?: FrontendExecuteOptions) {
  const expected = options?.sessionGeneration ?? generation()
  const check = () => {
    if (options?.signal?.aborted) throw new FrontendOperationError("cancelled", "Operation cancelled")
    if (expected !== generation())
      throw new FrontendOperationError("stale_session", "The active session changed")
  }
  check()
  return check
}

export function validate(schema: Schema, value: unknown) {
  if (!matches(copyRemoteJson(value), schema)) failure("Invalid file operation parameters")
}
