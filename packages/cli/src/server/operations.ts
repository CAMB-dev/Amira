import type { ModelInfo } from "@amira/ai"
import type { ReasoningEffort, SessionControl } from "@amira/api"
import type { FrontendExecuteOptions } from "@amira/core"
import { FrontendOperationError } from "@amira/core"
import { frontendJson } from "../../../core/src/frontend/json.ts"
import { validateRemoteParams, validateRemoteResult } from "../remote-schema.ts"
import type { Session } from "../session-factory.ts"
import { createServerUiOperations, type ServerUiOperations } from "./ui.ts"

type StoredSession = NonNullable<ReturnType<NonNullable<SessionControl["readSession"]>>>
export type ServerSessionHistory = Omit<StoredSession, "subagentMessages">
export type ServerModel = Pick<ModelInfo, "provider" | "id" | "contextWindow" | "maxOutput" | "caps"> & {
  ref: string
  available: boolean
}

/** Host-only DTO operations. Never return Ai.providers(), executable controls or view definitions. */
export interface ServerOperations extends ServerUiOperations {
  "sessions.list": {
    params: { offset?: number; limit?: number }
    result: { sessions: ReturnType<SessionControl["sessions"]>; nextOffset?: number }
  }
  "sessions.read": { params: { id: string }; result: ServerSessionHistory | null }
  "models.list": { params: Record<string, never>; result: ServerModel[] }
  "model.set": { params: { model: string }; result: { sessionGeneration: number } }
  "thinking.set": { params: { level: ReasoningEffort | "default" }; result: { sessionGeneration: number } }
  "fastMode.set": { params: { enabled: boolean }; result: { sessionGeneration: number } }
  "status.read": {
    params: Record<string, never>
    result: {
      info: ReturnType<SessionControl["info"]>
      items: ReturnType<Session["host"]["status"]["snapshot"]>
      usage: Session["tree"]["usage"]
      budget?: Session["tree"]["budget"]
    }
  }
}

export function createServerOperations(deps: {
  control: SessionControl
  session: Session
  generation: () => number
}) {
  const ack = () => ({ sessionGeneration: deps.generation() })
  const handlers: {
    [K in keyof ServerOperations]: (
      params: ServerOperations[K]["params"],
      signal?: AbortSignal,
    ) => ServerOperations[K]["result"] | Promise<ServerOperations[K]["result"]>
  } = {
    ...createServerUiOperations(deps.session.host.ui),
    "sessions.list": ({ offset = 0, limit = 50 }) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Session page requires a nonnegative offset and a limit from 1 to 100")
      const all = deps.control.sessions()
      const next = offset + limit
      return { sessions: all.slice(offset, next), ...(next < all.length ? { nextOffset: next } : {}) }
    },
    "sessions.read": ({ id }) => {
      const stored = deps.control.readSession?.(id)
      if (!stored) return null
      const { subagentMessages: _readChild, ...history } = stored
      return history
    },
    "models.list": () =>
      deps.control.models().map((ref) => {
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
    "model.set": ({ model }) => {
      deps.control.setModel(model)
      return ack()
    },
    "thinking.set": ({ level }) => {
      deps.control.setThinking(level === "default" ? undefined : level)
      return ack()
    },
    "fastMode.set": ({ enabled }) => {
      deps.control.setFastMode?.(enabled)
      return ack()
    },
    "status.read": () => ({
      info: deps.control.info(),
      items: deps.session.host.status.snapshot(),
      usage: deps.session.tree.usage,
      budget: deps.session.tree.budget,
    }),
  }
  return async <K extends keyof ServerOperations>(
    operation: K,
    params: ServerOperations[K]["params"],
    options?: FrontendExecuteOptions,
  ): Promise<ServerOperations[K]["result"]> => {
    if (options?.signal?.aborted) throw new FrontendOperationError("cancelled", "Operation cancelled")
    if (options?.sessionGeneration !== undefined && options.sessionGeneration !== ack().sessionGeneration)
      throw new FrontendOperationError("stale_session", "The active session changed")
    if (!Object.hasOwn(handlers, operation))
      throw new FrontendOperationError("unsupported_operation", "Unknown server operation")
    validateRemoteParams(operation, params)
    const result = frontendJson(await handlers[operation](params, options?.signal))
    validateRemoteResult(operation, result)
    // Copy rather than returning live history references.
    return result as ServerOperations[K]["result"]
  }
}
