import type { Ai } from "@amira/ai"
import type { AnyEvent, EventMap, OwnedConversation } from "@amira/api"
import {
  type AgentPort,
  bindLocalCommandContext,
  bindLocalConversation,
  createLocalAgentPort,
  type FrontendExecuteOptions,
  FrontendOperationError,
  type FrontendOperations,
  type FrontendUpdate,
} from "@amira/core"
import { freezeSnapshot, frontendJson } from "../../../core/src/frontend/json.ts"
import { nativeConversationActivity } from "../../../core/src/frontend/native-conversations.ts"
import { agentScopeRoot } from "../../../core/src/frontend/scope-root.ts"
import { agentSessionOwner } from "../../../core/src/session-routing.ts"
import { createCommandHost } from "../control.ts"
import type { RemoteJson } from "../remote/protocol.ts"
import type { ProxyAi } from "../remote/proxy-ai.ts"
import { publicUpdateError } from "../remote/public-errors.ts"
import {
  copyRemoteJson,
  validateRemoteDto,
  validateRemoteParams,
  validateRemoteResult,
} from "../remote-schema.ts"
import { createSession, type SessionOptions } from "../session-factory.ts"
import { ownerHasWork, trackRuntimeAi } from "./activity.ts"
import { createWorkspaceCapture } from "./capture.ts"
import type { ReplayJournal } from "./journal.ts"
import { validateMessageImages } from "./message-images.ts"
import { createServerOperations, type ServerOperations } from "./operations.ts"
import { serverBuiltins } from "./profile.ts"

export type ServerEffect =
  | { kind: "detach" }
  | { kind: "rewind" }
  | { kind: "view"; view: "background-job" | "subagent"; id: string }
  | { kind: "focus"; conversationId: string; incarnation: string }
  | { kind: "unfocus" }

type SelectRequest = Extract<EventMap["ui.request"], { kind: "select" }>
/** JSON uses null for an unbadged select option; the in-process UI API uses undefined. */
export type ServerUiRequest =
  | Exclude<EventMap["ui.request"], SelectRequest>
  | (Omit<SelectRequest, "optionStatuses" | "optionExtensionStatuses"> & {
      optionStatuses?: (Exclude<NonNullable<SelectRequest["optionStatuses"]>[number], undefined> | null)[]
      optionExtensionStatuses?: (Exclude<
        NonNullable<SelectRequest["optionExtensionStatuses"]>[number],
        undefined
      > | null)[]
    })
export type ServerEvent =
  | Exclude<AnyEvent, { type: "ui.request" }>
  | (Omit<Extract<AnyEvent, { type: "ui.request" }>, "data"> & { data: ServerUiRequest })

function requestDto(request: EventMap["ui.request"]): ServerUiRequest {
  const value =
    request.kind === "select"
      ? {
          ...request,
          ...(request.optionStatuses && {
            optionStatuses: Array.from(request.optionStatuses, (status) => status ?? null),
          }),
          ...(request.optionExtensionStatuses && {
            optionExtensionStatuses: Array.from(request.optionExtensionStatuses, (status) => status ?? null),
          }),
        }
      : request
  const dto = freezeSnapshot(frontendJson(value))
  validateRemoteDto("uiRequest", dto)
  return dto as unknown as ServerUiRequest
}

function eventDto(event: AnyEvent): ServerEvent {
  try {
    const value = event.type === "ui.request" ? { ...event, data: requestDto(event.data) } : event
    const dto = freezeSnapshot(frontendJson(value))
    validateRemoteDto("coreEvent", dto)
    return dto as unknown as ServerEvent
  } catch {
    // EventBus isolates subscriber exceptions. Replace failed projections explicitly instead
    // of throwing into that silent boundary, and never reflect invalid payloads or errors.
    const fault: ServerEvent = {
      seq: 0,
      ts: 0,
      sessionId: "host",
      type: "extension.error",
      data: {
        source: "remote:protocol",
        error: "An outgoing workspace event failed validation; an update is unavailable.",
      },
    }
    // Do not retry projection or read anything from the malformed event. The fixed
    // fallback has null prototypes and no dependency on accessors, payloads or diagnostics.
    return freezeSnapshot(
      Object.assign(Object.create(null), fault, {
        data: Object.assign(Object.create(null), fault.data),
      }),
    )
  }
}

export interface WorkspaceAttachment extends AgentPort {
  request<K extends keyof ServerOperations>(
    operation: K,
    params: ServerOperations[K]["params"],
    options?: FrontendExecuteOptions,
  ): Promise<ServerOperations[K]["result"]>
  readonly pendingRequests: readonly ServerUiRequest[]
  /** Initial host diagnostics, not a replay journal; attachments must not re-run their effects. */
  readonly startupEvents: readonly ServerEvent[]
  subscribeEvents(listener: (event: ServerEvent) => void): () => void
}

export interface WorkspaceRuntime {
  readonly modelProxy?: Pick<ProxyAi, "attach" | "receive" | "close">
  /** Host-only replay authority; transport subscribers must use bounded queues. */
  readonly journal: ReplayJournal
  readonly signal: AbortSignal
  workspaceSnapshot(): RemoteJson
  /** True only with no controller, pending work, dialogs, jobs or model side calls. */
  quiescent(): boolean
  /** Includes short model/operation activity between daemon clock samples. */
  readonly activityVersion: number
  attach(options?: { onEffect?: (effect: ServerEffect) => void }): WorkspaceAttachment
  /** Explicit owner shutdown, never called by attachment EOF/detach. */
  stop(): Promise<void>
}

export type WorkspaceRuntimeOptions = Omit<
  SessionOptions,
  "ai" | "executionOnly" | "loadThemes" | "noBuiltins" | "extensions"
> & {
  ai: Ai
  modelProxy?: Pick<ProxyAi, "attach" | "receive" | "close">
  extensions?: string[]
  noBuiltins?: boolean
}

/** One workspace/session authority, independent of any connection's lifetime. */
export async function createWorkspaceRuntime(opts: WorkspaceRuntimeOptions): Promise<WorkspaceRuntime> {
  let activityVersion = 0
  const tracked = trackRuntimeAi(opts.ai, () => activityVersion++)
  const session = await createSession({
    ...opts,
    ai: tracked.ai,
    extensions: opts.extensions ?? [],
    noBuiltins: opts.noBuiltins ?? false,
    executionOnly: true,
    catalog: false,
    builtins: opts.builtins ?? serverBuiltins,
  })
  const commands = createCommandHost({
    session,
    cwd: opts.cwd,
    shell: opts.shell,
    disabled: opts.disabledTools,
    aliases: opts.settings?.commandAliases,
    announce: (agent, reason) => agent.start(reason),
  })
  const port = createLocalAgentPort({ agent: session.agent, commands })
  const bindings = new Map<string, { conversation: OwnedConversation; incarnation: string; unbind(): void }>()
  let frontendEffect: ((effect: ServerEffect) => void) | undefined
  const request = createServerOperations({
    control: commands.control,
    session,
    generation: () => port.identity!.sessionGeneration,
    historyCut: (ref, read) => capture.conversationCut((id) => request.conversations.includes(ref, id), read),
    send: (operation, params, options) => execute(operation, params, options),
    onFocus: (ref) =>
      frontendEffect?.(
        ref
          ? ref.incarnation
            ? { kind: "focus", conversationId: ref.conversationId, incarnation: ref.incarnation }
            : { kind: "view", view: "subagent", id: ref.conversationId }
          : { kind: "unfocus" },
      ),
  })
  const clearBindings = () => {
    for (const binding of bindings.values()) binding.unbind()
    bindings.clear()
    request.conversations.clear()
    request.files.dispose()
    request.uploads.dispose()
  }
  const offResources = commands.onSwitch(clearBindings)
  let active: WorkspaceAttachment | undefined
  let stopping: Promise<void> | undefined
  const lifetime = new AbortController()
  const inflight = new Set<Promise<unknown>>()
  const startupEvents = freezeSnapshot(session.startupEvents.map(eventDto))
  validateRemoteDto("startup", startupEvents)
  const capture = createWorkspaceCapture({
    session,
    commands,
    port,
    startupEvents,
    eventDto,
    pending: () => freezeSnapshot(session.host.ui.pending.map(requestDto)),
    extraOwners: () =>
      [...bindings.keys()].flatMap((id) => {
        const owner = request.conversations.ownedScope(id) && agentSessionOwner(id)
        return owner ? [owner] : []
      }),
  })
  session.agent.start("startup")
  await session.agent.bus.flush()
  const execute = async <K extends keyof FrontendOperations>(
    operation: K,
    params: FrontendOperations[K]["params"],
    options?: FrontendExecuteOptions,
  ): Promise<FrontendOperations[K]["result"]> => {
    validateRemoteParams(operation, params)
    if (
      (operation === "turn.prompt" || operation === "turn.steer" || operation === "conversation.send") &&
      "message" in params
    )
      validateMessageImages(params.message)
    const result = frontendJson(await port.execute(operation, params, options))
    validateRemoteResult(operation, result)
    return result as unknown as FrontendOperations[K]["result"]
  }
  const guarded = (options?: FrontendExecuteOptions): FrontendExecuteOptions => ({
    ...options,
    signal: options?.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal,
  })
  function track<T>(run: () => Promise<T>): Promise<T> {
    activityVersion++
    const result = run()
    inflight.add(result)
    void result
      .finally(() => {
        inflight.delete(result)
        activityVersion++
      })
      .catch(() => {})
    return result
  }

  return {
    modelProxy: opts.modelProxy,
    journal: capture.journal,
    signal: lifetime.signal,
    get activityVersion() {
      return activityVersion + capture.journal.watermark
    },
    workspaceSnapshot: () => capture.snapshot(),
    quiescent: () =>
      !active &&
      !inflight.size &&
      !tracked.pending() &&
      !session.host.ui.pending.length &&
      !ownerHasWork(commands.agent) &&
      ![...bindings.values()].some(({ conversation }) => {
        const owner = agentSessionOwner(conversation.id)
        return owner && ownerHasWork(owner)
      }) &&
      !commands.control.subagents().some((child) => ["queued", "running", "paused"].includes(child.status)) &&
      !session.host.backgroundJobs.list().some((job) => ["starting", "running"].includes(job.status)),
    attach(options = {}) {
      if (lifetime.signal.aborted) throw new FrontendOperationError("disconnected", "The runtime is stopped")
      if (active) throw new FrontendOperationError("agent_busy", "A workspace frontend is already attached")
      let detached = false
      const subscriptions = new Set<() => void>()
      const connected = () => {
        if (detached || lifetime.signal.aborted)
          throw new FrontendOperationError("disconnected", "This frontend is detached")
      }
      const effect = (value: ServerEffect) => {
        validateRemoteDto("effect", value)
        if (!detached) options.onEffect?.(value)
      }
      frontendEffect = effect
      const attachment: WorkspaceAttachment = {
        get identity() {
          return port.identity
        },
        quitBehavior: "detach",
        supportedOperations: port.supportedOperations,
        get snapshot() {
          validateRemoteDto("snapshot", port.snapshot)
          return port.snapshot
        },
        startupEvents,
        get pendingRequests() {
          return freezeSnapshot(session.host.ui.pending.map(requestDto))
        },
        subscribe(listener) {
          connected()
          const off = port.subscribe((update) => {
            let dto: FrontendUpdate
            try {
              const copy = copyRemoteJson(update)
              validateRemoteDto("update", copy)
              dto = copy as unknown as FrontendUpdate
              if (dto.kind === "error") dto = publicUpdateError(dto.error.code)
            } catch {
              dto = publicUpdateError()
            }
            listener(freezeSnapshot(dto))
          })
          subscriptions.add(off)
          return () => {
            subscriptions.delete(off)
            off()
          }
        },
        subscribeEvents(listener) {
          connected()
          const off = session.agent.bus.subscribe((event) => {
            listener(eventDto(event))
          })
          subscriptions.add(off)
          return () => {
            subscriptions.delete(off)
            off()
          }
        },
        async execute<K extends keyof FrontendOperations>(
          operation: K,
          params: FrontendOperations[K]["params"],
          executeOptions?: FrontendExecuteOptions,
        ) {
          connected()
          validateRemoteParams(operation, params)
          if (operation !== "command.run" && operation !== "skill.run" && operation !== "input.run")
            return track(() => execute(operation, params, guarded(executeOptions)))
          const invocationId = crypto.randomUUID()
          const unbind = bindLocalCommandContext(port, invocationId, {
            frontend: "tui",
            isFrontendCurrent: () => !detached,
            quit: () => effect({ kind: "detach" }),
            openRewind: () => {
              effect({ kind: "rewind" })
              return !detached
            },
            openView: (view) => {
              if (detached || !options.onEffect) return false
              const data = "data" in view ? view.data : undefined
              const key = view.kind === "subagent" ? "sessionId" : "id"
              const id =
                view.kind === "subagent" && "sessionId" in view
                  ? view.sessionId
                  : typeof data === "object" && data !== null && key in data
                    ? Reflect.get(data, key)
                    : undefined
              if ((view.kind !== "background-job" && view.kind !== "subagent") || typeof id !== "string")
                return false
              effect({ kind: "view", view: view.kind, id })
              return true
            },
            focusConversation: (conversation) => {
              if (detached || (!bindings.has(conversation.id) && bindings.size >= 128)) return false
              const owner = agentSessionOwner(conversation.id)
              if (!owner) return false
              request.files.establishScope(conversation.cwd, conversation.id, agentScopeRoot(owner))
              const previous = bindings.get(conversation.id)
              if (
                previous?.conversation === conversation &&
                request.conversations.ownedScope(conversation.id) === conversation
              ) {
                effect({ kind: "focus", conversationId: conversation.id, incarnation: previous.incarnation })
                return true
              }
              previous?.unbind()
              bindings.delete(conversation.id)
              const offCapture = capture.watch(
                owner.bus,
                () => nativeConversationActivity(conversation),
                () => request.conversations.ownedScope(conversation.id) === conversation,
              )
              try {
                const ownedBinding = request.conversations.bind(conversation)
                const binding = bindLocalConversation(port, conversation)
                bindings.set(conversation.id, {
                  conversation,
                  incarnation: binding.incarnation,
                  unbind() {
                    offCapture()
                    binding()
                    ownedBinding()
                  },
                })
                effect({ kind: "focus", conversationId: conversation.id, incarnation: binding.incarnation })
                return true
              } catch (error) {
                offCapture()
                throw error
              }
            },
            unfocusConversation: () => {
              effect({ kind: "unfocus" })
              return !detached
            },
          })
          try {
            return await track(() => execute(operation, { ...params, invocationId }, guarded(executeOptions)))
          } finally {
            unbind()
          }
        },
        async request(operation, params, executeOptions) {
          connected()
          return track(() => request(operation, params, guarded(executeOptions)))
        },
        async detach() {
          if (detached) return
          detached = true
          activityVersion++
          for (const off of subscriptions) off()
          subscriptions.clear()
          if (active === attachment) {
            frontendEffect = undefined
            active = undefined
          }
        },
      }
      active = attachment
      activityVersion++
      return attachment
    },
    stop() {
      if (!stopping)
        stopping = (async () => {
          lifetime.abort()
          capture.close()
          offResources()
          clearBindings()
          await active?.detach()
          session.host.ui.cancelAll()
          commands.agent.abort()
          opts.modelProxy?.close()
          // Selection commit detaches its cancellation listener; drain before disposing the winner.
          await Promise.allSettled([...inflight])
          await port.detach()
          try {
            await commands.agent.dispose("exit")
            await session.host.runExitHandlers(3500, 1000)
          } finally {
            session.host.unloadAll()
            await session.host.drain()
            await session.agent.bus.flush()
            await session.traceRecorder?.close()
          }
        })()
      return stopping
    },
  }
}
