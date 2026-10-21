import type { ModelInfo } from "@amira/ai"
import type { ReasoningEffort, SessionControl } from "@amira/api"
import type { CommandHost, FrontendExecuteOptions } from "@amira/core"
import { FrontendOperationError } from "@amira/core"
import { frontendJson } from "../../../core/src/frontend/json.ts"
import { agentScopeRoot } from "../../../core/src/frontend/scope-root.ts"
import { agentSessionOwner } from "../../../core/src/session-routing.ts"
import type { ProxyAi, ProxyModelMetadata } from "../remote/proxy-ai.ts"
import type { ServerUploadSendOperations } from "../remote/schema/upload-send.ts"
import { validateRemoteParams, validateRemoteResult } from "../remote-schema.ts"
import type { Session } from "../session-factory.ts"
import { createServerConversations, type ServerConversationOperations } from "./conversations.ts"
import { createServerFileOperations, type ServerFileOperations } from "./files.ts"
import { createServerJobs, type ServerJobOperations } from "./jobs.ts"
import { createServerUiOperations, type ServerUiOperations } from "./ui.ts"
import { createUploadSender } from "./upload-send.ts"
import { createServerUploadOperations, type ServerUploadOperations } from "./uploads.ts"

type StoredSession = NonNullable<ReturnType<NonNullable<SessionControl["readSession"]>>>
export type ServerSessionHistory = Omit<StoredSession, "subagentMessages">
export type ServerModel = Pick<ModelInfo, "provider" | "id" | "contextWindow" | "maxOutput" | "caps"> & {
  ref: string
  available: boolean
}

/** Host-only DTO operations. Never return Ai.providers(), executable controls or view definitions. */
export interface ServerOperations
  extends ServerUiOperations,
    ServerJobOperations,
    ServerConversationOperations,
    ServerFileOperations,
    ServerUploadOperations,
    ServerUploadSendOperations {
  "sessions.list": {
    params: { offset?: number; limit?: number }
    result: { sessions: ReturnType<SessionControl["sessions"]>; nextOffset?: number }
  }
  "sessions.read": { params: { id: string }; result: ServerSessionHistory | null }
  "commands.describe": {
    params: Record<string, never>
    result: { commands: ReturnType<CommandHost["list"]>; skills: ReturnType<CommandHost["skills"]> }
  }
  "commands.complete": {
    params: { line: string; skill?: boolean }
    result: Awaited<ReturnType<CommandHost["complete"]>>
  }
  "proxy.describe": {
    params: Record<string, never>
    result: { enabled: boolean; models: ModelInfo[]; origins: { provider: string; origin: string }[] }
  }
  "proxy.bind": {
    params: { metadata: ProxyModelMetadata[] }
    result: { sessionGeneration: number }
  }
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
  commands?: Pick<CommandHost, "list" | "skills" | "complete" | "completeSkill">
  modelProxy?: Pick<ProxyAi, "describeBindings" | "bindMetadata">
  generation: () => number
  historyCut: Parameters<typeof createServerConversations>[0]["historyCut"]
  onFocus?: Parameters<typeof createServerConversations>[0]["onFocus"]
  send?: Parameters<typeof createUploadSender>[0]["send"]
}) {
  const ack = () => ({ sessionGeneration: deps.generation() })
  const conversations = createServerConversations(deps)
  const uploads = createServerUploadOperations({ generation: deps.generation })
  const uploadSender = createUploadSender({ uploads, send: deps.send })
  const uploadHandlers = Object.fromEntries(
    Object.entries(uploads.handlers).map(([key, handler]) => [
      key,
      (params: never, signal?: AbortSignal) => handler(params, { signal }),
    ]),
  ) as {
    [K in keyof ServerUploadOperations]: (
      params: ServerUploadOperations[K]["params"],
      signal?: AbortSignal,
    ) => Promise<ServerUploadOperations[K]["result"]>
  }
  const scopedAgent = (scope?: string) => {
    const root = agentSessionOwner(deps.control.info().id)
    if (root?.bus !== deps.session.agent.bus) return undefined
    if (scope === undefined) return root
    if (conversations.ownedScope(scope)) return agentSessionOwner(scope)
    if (!deps.control.subagents().some((child) => child.id === scope)) return undefined
    const child = agentSessionOwner(scope)
    return child?.bus === root.bus ? child : undefined
  }
  const files = createServerFileOperations({
    generation: deps.generation,
    resolveScope: (scope) => {
      const agent = scopedAgent(scope)
      if (agent) return { cwd: agent.cwd, root: agentScopeRoot(agent) }
      const owned = scope ? conversations.ownedScope(scope) : undefined
      return owned ? { cwd: owned.cwd } : undefined
    },
    resolveArtifact: (id, scope) => scopedAgent(scope)?.artifacts.resolveOwned(id),
  })
  files.establishScope(deps.session.agent.cwd, undefined, agentScopeRoot(deps.session.agent))
  const { dispose: _disposeFiles, establishScope: _establishScope, ...fileOperations } = files
  const fileHandlers = Object.fromEntries(
    Object.entries(fileOperations).map(([key, handler]) => [
      key,
      (params: never, signal?: AbortSignal) => handler(params, { signal }),
    ]),
  ) as {
    [K in keyof ServerFileOperations]: (
      params: ServerFileOperations[K]["params"],
      signal?: AbortSignal,
    ) => Promise<ServerFileOperations[K]["result"]>
  }
  const jobs = createServerJobs({
    generation: deps.generation,
    jobs: (scope) => {
      const native = scope.conversationId && conversations.ownedScope(scope.conversationId)
      if (native) return agentSessionOwner(native.id)?.backgroundJobs
      const root = agentSessionOwner(deps.control.info().id)
      // A durable id alone cannot authorize a different workspace's live agent.
      return root?.bus === deps.session.agent.bus ? root.backgroundJobs : undefined
    },
    visible: (job, scope) => {
      const native = scope.conversationId && conversations.ownedScope(scope.conversationId)
      if (native) return !job.owner || !!agentSessionOwner(native.id)?.tree?.subagent(job.owner)
      const children = deps.control.subagents()
      const known = (id: string) =>
        children.some((child) => child.id === id) || !!conversations.ownedScope(id)
      if (scope.conversationId !== undefined)
        return known(scope.conversationId) && job.owner === scope.conversationId
      return !job.owner || known(job.owner)
    },
  })
  const handlers: {
    [K in keyof ServerOperations]: (
      params: ServerOperations[K]["params"],
      signal?: AbortSignal,
    ) => ServerOperations[K]["result"] | Promise<ServerOperations[K]["result"]>
  } = {
    ...createServerUiOperations(deps.session.host.ui),
    ...jobs.handlers,
    ...conversations.handlers,
    ...fileHandlers,
    ...uploadHandlers,
    "uploads.send": (params, signal) => uploadSender(params, { signal }),
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
    "commands.describe": () => ({
      commands: deps.commands?.list() ?? [],
      skills: deps.commands?.skills() ?? [],
    }),
    "commands.complete": ({ line, skill }) =>
      (skill ? deps.commands?.completeSkill(line) : deps.commands?.complete(line)) ?? { candidates: [] },
    "proxy.describe": () =>
      deps.modelProxy?.describeBindings() ?? { enabled: false, models: [], origins: [] },
    "proxy.bind": ({ metadata }) => {
      if (!deps.modelProxy)
        throw new FrontendOperationError("unsupported_operation", "This workspace uses remote credentials")
      deps.modelProxy.bindMetadata(metadata)
      return ack()
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
  const execute = async <K extends keyof ServerOperations>(
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
    const generation = deps.generation()
    const result = frontendJson(await handlers[operation](params, options?.signal))
    validateRemoteResult(operation, result)
    // Fence slow reads/waits after a switch, not merely their initial submission.
    if (generation !== deps.generation())
      throw new FrontendOperationError("stale_session", "The active session changed")
    // Copy rather than returning live history references.
    return result as ServerOperations[K]["result"]
  }
  return Object.assign(execute, { jobs, conversations, files, uploads })
}
