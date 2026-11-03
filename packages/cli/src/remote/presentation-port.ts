import { randomUUID } from "node:crypto"
import type { AnyEvent, CommandContext, CommandDefinition } from "@amira/api"
import {
  type AgentPort,
  CommandRegistry,
  type FrontendConnectionIssue,
  type FrontendExecuteOptions,
  type FrontendOperations,
  parseCommandLine,
  parseSkillLine,
  rankMatches,
  StatusRegistry,
} from "@amira/core"
import type { FrontendEffect, OverlayRequestBackend } from "@amira/tui"
import { localCommandContext } from "../../../core/src/frontend/operations.ts"
import type { ServerOperations } from "../server/operations.ts"
import type { RemoteAgentPort } from "./agent-port.ts"
import { waitForRemoteEffects } from "./effect-delivery.ts"
import { sendRemoteImages } from "./image-upload.ts"
import { remoteAttachment } from "./presence.ts"

/** Pure local commands and semantic presentation. No local Agent, tools, stores or extension loading. */
export function remotePresentationPort(remote: RemoteAgentPort) {
  const commands = new CommandRegistry()
  const status = new StatusRegistry()
  let metadata: ServerOperations["commands.describe"]["result"] = { commands: [], skills: [] }
  const refreshCommands = async () => {
    metadata = await remote.request("commands.describe", {})
  }
  const events = new Set<(event: AnyEvent, context?: { replay: boolean }) => void>()
  const effects = new Set<(effect: FrontendEffect) => void>()
  const connections = new Set<() => void>()
  let connectionIssue: FrontendConnectionIssue | undefined
  let attachmentNotice: string | undefined
  const announce = () => {
    for (const listener of connections) listener()
  }
  let seq = 0
  /** Dialogs this TUI asks itself, such as a binding approval after /take; never sent remotely. */
  const localDialogs = new Map<string, { event: AnyEvent; answer(value: boolean): void }>()
  let disposed = false
  const localIds = new Set<string>()
  let pending = new Set(remote.pendingRequests.map((request) => request.requestId))
  const restore = (listener: (event: AnyEvent, context?: { replay: boolean }) => void) => {
    for (const event of remote.workspaceSnapshot.activity.events)
      listener(event as AnyEvent, { replay: true })
    const owner = remote.workspaceSnapshot.owners[remote.identity.sessionId]
    for (const message of owner?.steering ?? [])
      listener(
        {
          seq: ++seq,
          ts: 0,
          sessionId: remote.identity.sessionId,
          turnId: owner?.turnId ?? undefined,
          type: "turn.steer",
          data: { message, state: "queued" },
        } as AnyEvent,
        { replay: true },
      )
    for (const request of remote.pendingRequests) {
      const data =
        request.kind === "select"
          ? {
              ...request,
              optionStatuses: request.optionStatuses?.map((value) => value ?? undefined),
              optionExtensionStatuses: request.optionExtensionStatuses?.map((value) => value ?? undefined),
            }
          : request
      listener(
        { seq: ++seq, ts: 0, sessionId: request.sessionId ?? "host", type: "ui.request", data } as AnyEvent,
        { replay: true },
      )
    }
    for (const dialog of localDialogs.values()) listener(dialog.event, { replay: true })
  }
  const broadcast = (event: AnyEvent) => {
    for (const listener of events) listener(event, { replay: false })
  }
  const settleLocal = (requestId: string, value: boolean | undefined) => {
    const dialog = localDialogs.get(requestId)
    if (!dialog) return false
    localDialogs.delete(requestId)
    dialog.answer(value === true)
    broadcast({
      seq: ++seq,
      ts: Date.now(),
      sessionId: "host",
      type: "ui.resolved",
      data: { requestId, cancelled: value === undefined, ...(value === undefined ? {} : { value }) },
    })
    return true
  }
  const emit = (command: string, text: string, level: "info" | "warning" | "error" = "info") => {
    const event: AnyEvent = {
      seq: ++seq,
      ts: Date.now(),
      sessionId: remote.identity.sessionId,
      type: "command.output",
      data: { command, text, level },
    }
    for (const listener of events) listener(event, { replay: false })
  }
  const executeRemote = async <K extends keyof FrontendOperations>(
    operation: K,
    params: FrontendOperations[K]["params"],
    options?: FrontendExecuteOptions,
  ) => {
    const epoch = remote.authority!.daemonEpoch
    const result = await remote.execute(operation, params, options)
    if ("effectWatermark" in result && typeof result.effectWatermark === "number")
      await waitForRemoteEffects(remote, epoch, result.effectWatermark, options?.signal)
    return result
  }
  const frontend: AgentPort = {
    get identity() {
      return remote.identity
    },
    quitBehavior: "detach",
    get snapshot() {
      return remote.snapshot
    },
    get connection() {
      return remote.connection
    },
    get connectionIssue() {
      return connectionIssue
    },
    get attachment() {
      return remoteAttachment(remote, attachmentNotice)
    },
    subscribe: (listener) => remote.subscribe(listener),
    subscribeConnection(listener) {
      connections.add(listener)
      const off = remote.subscribeConnection(listener)
      return () => {
        connections.delete(listener)
        off()
      }
    },
    subscribeEvents(listener) {
      events.add(listener)
      const off = remote.subscribeEvents(listener)
      queueMicrotask(() => {
        if (events.has(listener)) restore(listener)
      })
      return () => {
        events.delete(listener)
        off()
      }
    },
    async execute(operation, params, options) {
      if (operation === "turn.prompt" || operation === "turn.steer") {
        const input = params as import("@amira/core").FrontendOperations["turn.steer"]["params"]
        if (
          typeof input.message !== "string" &&
          input.message.content.some((block) => block.type === "image")
        )
          return sendRemoteImages(remote, { ...input, operation, message: input.message }, options) as never
      }
      if (operation !== "command.run") return executeRemote(operation, params, options)
      const input = params as { line: string; invocationId?: string }
      const parsed = parseCommandLine(input.line)
      const local = parsed && commands.get(parsed.name)
      if (!local) {
        const result = await executeRemote(operation, params, options)
        if (parsed?.name === "reload") await refreshCommands()
        return result
      }
      const context = localCommandContext(frontend, input.invocationId)
      const output: string[] = []
      const unsupported = (): never => {
        throw new Error("This local UI command cannot access the remote runtime")
      }
      const ctx: CommandContext = {
        cwd: process.cwd(),
        frontend: "tui",
        signal: options?.signal ?? new AbortController().signal,
        get session() {
          return unsupported()
        },
        get ui() {
          return unsupported()
        },
        print(text, level) {
          output.push(text)
          emit(parsed.name, text, level)
        },
        commands: () => commands.list(),
        skills: () => [],
        aliases: () => [],
        quit: () => context?.quit?.(),
        keys: context?.keys,
        glyphs: context?.glyphs,
        openView: context?.openView,
        openRewind: context?.openRewind,
      }
      try {
        await local.def.run(parsed.args, ctx)
        return { ok: true, command: parsed.name, output } as never
      } catch (error) {
        const message = error instanceof Error ? error.message : "Local UI command failed"
        emit(parsed.name, message, "error")
        return { ok: false, command: parsed.name, output, error: message } as never
      }
    },
    detach: () => remote.detach(),
  }
  let unregister: (() => void)[] = []
  const refreshStatus = () => {
    for (const off of unregister) off()
    unregister = remote.workspaceSnapshot.semantic.status.items.map((item, order) =>
      status.register({ ...item, order, text: () => item.text }),
    )
  }
  refreshStatus()
  const offWorkspace = remote.subscribeWorkspace((update, context) => {
    if ("kind" in update && update.kind === "semantic") refreshStatus()
    // Effects belong to the controller's commands: a viewer never acts on one, and replay never does.
    if (!("kind" in update) || update.kind !== "effect" || context.replay || remote.readOnly) return
    const effect = update.effect
    const ctx = localCommandContext(frontend, effect.invocationId)
    if (effect.invocationId && (!ctx || ctx.isFrontendCurrent?.() === false)) return
    for (const listener of effects) listener(effect)
  })
  const offPresence = remote.subscribePresence(announce)
  const offRequests = remote.subscribeEvents((event) => {
    if (event.type === "ui.request") pending.add(event.data.requestId)
    else if (event.type === "ui.resolved") pending.delete(event.data.requestId)
  })
  const offReset = remote.subscribeReset(() => {
    refreshStatus()
    const current = new Set(remote.pendingRequests.map((request) => request.requestId))
    for (const listener of events) {
      for (const requestId of pending)
        if (!current.has(requestId))
          listener(
            {
              seq: ++seq,
              ts: 0,
              sessionId: "host",
              type: "ui.resolved",
              data: { requestId, cancelled: false },
            },
            { replay: true },
          )
      restore(listener)
    }
    pending = current
  })
  return {
    frontend,
    status,
    refreshCommands,
    setConnectionIssue(issue?: FrontendConnectionIssue) {
      connectionIssue = issue && Object.freeze({ ...issue })
      announce()
    },
    /**
     * Asks a yes/no question in this TUI's own dialog; resolves false when declined, dismissed
     * or disposed. Answered locally only: nothing reaches the daemon.
     */
    confirm(title: string, message?: string): Promise<boolean> {
      if (disposed) return Promise.resolve(false)
      const requestId = `local-${randomUUID()}`
      const event: AnyEvent = {
        seq: ++seq,
        ts: Date.now(),
        sessionId: "host",
        type: "ui.request",
        data: { requestId, kind: "confirm", title, ...(message ? { message } : {}) },
      }
      const answer = Promise.withResolvers<boolean>()
      localIds.add(requestId)
      localDialogs.set(requestId, { event, answer: answer.resolve })
      broadcast(event)
      return answer.promise
    },
    /** The overlay backend, with this TUI's own dialogs answered here instead of remotely. */
    requests<B extends OverlayRequestBackend>(backend: B): B {
      return {
        ...backend,
        requestState: (id: string) =>
          localDialogs.has(id) ? "pending" : localIds.has(id) ? "settled" : backend.requestState(id),
        respond: (id: string, value: unknown) =>
          settleLocal(id, typeof value === "boolean" ? value : undefined)
            ? { status: typeof value === "boolean" ? "accepted" : "cancelled" }
            : backend.respond(id, value),
      }
    },
    /** A persistent attachment notice, such as who took control; undefined clears it. */
    setAttachmentNotice(notice?: string) {
      attachmentNotice = notice
      announce()
    },
    completions: {
      list: () => [...metadata.commands, ...commands.list()],
      skills: () => metadata.skills,
      skillLine: (line: string) => {
        const parsed = parseSkillLine(line)
        return parsed && metadata.skills.some((skill) => skill.name === parsed.name) ? parsed : undefined
      },
      inputLine: () => false,
      complete: async (line: string) => {
        const names = /^\/(\S*)$/.exec(line)
        if (names)
          return {
            candidates: rankMatches(
              names[1]!,
              [...metadata.commands, ...commands.list()].map((item) => ({
                value: item.name,
                description: item.description,
              })),
              (item) => item.value,
            ),
          }
        return remote.request("commands.complete", { line }, { sessionGeneration: remote.sessionGeneration })
      },
      completeSkill: (line: string) => {
        const names = /^\$(\S*)$/.exec(line)
        if (names)
          return {
            candidates: rankMatches(
              names[1]!,
              metadata.skills.map((skill) => ({ value: skill.name, description: skill.description })),
              (item) => item.value,
            ),
          }
        return { command: /^\$(\S+)\s/.exec(line)?.[1], candidates: [] }
      },
    },
    subscribeFrontendEffects(listener: (effect: FrontendEffect) => void) {
      effects.add(listener)
      return () => {
        effects.delete(listener)
      }
    },
    registerCommand: (command: CommandDefinition) => commands.register(command, "builtin:tui"),
    dispose() {
      disposed = true
      for (const requestId of [...localDialogs.keys()]) settleLocal(requestId, undefined)
      offWorkspace()
      offPresence()
      offReset()
      offRequests()
      for (const off of unregister) off()
      events.clear()
      effects.clear()
      connections.clear()
    },
  }
}
