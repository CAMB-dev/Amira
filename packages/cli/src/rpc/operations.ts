import { type Ai, type Message, type UserContent, type UserMessage, userMessage } from "@amira/ai"
import { type EventMap, modelLabel, type TurnEndReason } from "@amira/api"
import type { Agent, CommandHost, UiRequests } from "@amira/core"
import type { COMMAND_PARAMS } from "../rpc-schema.ts"
import {
  attachments,
  display,
  type ErrorCode,
  type Id,
  type Params,
  parseRequest,
  RpcError,
  text,
} from "./validation.ts"

export type Handler = (p: Params) => Record<string, unknown> | Promise<Record<string, unknown>>
export type RpcHandlers = Record<keyof typeof COMMAND_PARAMS, Handler>

/** What the client needs to read back the most recent turn. */
export interface LastTurn {
  turnId: string
  prompt: UserMessage
  /** Where the prompt sat in the history when the turn started. */
  start: number
  reason?: TurnEndReason
  error?: string
}

/** Host authority is injected; operations do not own IO, subscriptions or runtime lifetime. */
export interface RpcOperationDeps {
  agent(): Agent
  ai: Pick<Ai, "model">
  ui: UiRequests
  commands?: CommandHost
  lastTurn(): LastTurn | undefined
  newTurnId(): string
  resume?: (sessionId: string) => Promise<Agent | undefined>
  replaceAgent(next: Agent): Promise<void>
}

export function createRpcOperations(deps: RpcOperationDeps): RpcHandlers {
  const { agent, ai, ui, commands } = deps
  let focused: boolean | undefined
  /** What keeps the agent busy, for the busy errors: "a turn", "a compaction", "a reload". */
  const running = () => (agent().turnId ? "a turn" : `a ${agent().holdingFor ?? "compaction"}`)

  const handlers: Record<keyof typeof COMMAND_PARAMS, Handler> = {
    prompt: (p) => {
      const content: UserContent[] = [{ type: "text", text: text(p) }, ...attachments(p.attachments)]
      const shown = display(p.display)
      if (agent().turnId) throw new RpcError("busy", "a turn is running; steer it or wait for turn.end")
      if (agent().busy) throw new RpcError("busy", `${running()} is running; steer to queue the message`)
      const turnId = deps.newTurnId()
      agent()
        .prompt({ role: "user", content, ...(shown ? { display: shown } : {}) }, { turnId })
        .catch(() => {})
      return { turnId }
    },
    steer: (p) => {
      const message = userMessage(text(p), display(p.display))
      const queued = agent().busy
      agent().steer(message)
      return { ...(agent().turnId ? { turnId: agent().turnId } : {}), queued }
    },
    abort: () => {
      const aborted = agent().busy
      agent().abort()
      return { aborted }
    },
    "subagent.message": (p) => ({
      delivered: needCommands().control.messageSubagent(text(p, "sessionId"), text(p)),
    }),
    "subagent.pause": (p) => ({ paused: needCommands().control.pauseSubagent(text(p, "sessionId")) }),
    "subagent.resume": (p) => ({ resumed: needCommands().control.resumeSubagent(text(p, "sessionId")) }),
    "ui.respond": (p) => {
      const requestId = text(p, "requestId")
      // A misspelt key must not cancel the dialog; only an explicit null does.
      if (!Object.hasOwn(p, "value"))
        throw new RpcError("invalid_params", '"value" is required (null cancels)')
      const problem = ui.respond(requestId, p.value)
      if (problem)
        throw new RpcError(problem.startsWith("no pending") ? "not_found" : "invalid_params", problem)
      return {}
    },
    "ui.action": async (p) => {
      const requestId = text(p, "requestId")
      const action = text(p, "action")
      const values = p.values ?? {}
      if (typeof values !== "object" || values === null || Array.isArray(values)) {
        throw new RpcError("invalid_params", '"values" must be an object')
      }
      if (ui.validateForm(requestId, {}) === undefined) {
        throw new RpcError("not_found", `no pending form "${requestId}"`)
      }
      return { result: await ui.runFormAction(requestId, action, values as Record<string, unknown>) }
    },
    "ui.configure": (p) => {
      if (p.forms !== "native" && p.forms !== "dialogs") {
        throw new RpcError("invalid_params", '"forms" must be "native" or "dialogs"')
      }
      ui.formMode = p.forms
      return {}
    },
    "ui.focus": (p) => {
      if (typeof p.focused !== "boolean") throw new RpcError("invalid_params", '"focused" must be a boolean')
      if (p.focused !== focused) {
        focused = p.focused
        agent().bus.emit("ui.focus", { focused }, { sessionId: "host" })
      }
      return {}
    },
    "session.read": (p) => {
      const lastTurn = deps.lastTurn()
      if (p.what === "messages") return { messages: agent().messages }
      if (p.what !== "lastTurn")
        throw new RpcError("invalid_params", '"what" must be "lastTurn" or "messages"')
      if (!lastTurn) return { messages: [] }
      const messages = agent().messages.slice(turnStart(agent().messages, lastTurn))
      return {
        turnId: lastTurn.turnId,
        ...(lastTurn.reason ? { reason: lastTurn.reason } : {}),
        ...(lastTurn.error !== undefined ? { error: lastTurn.error } : {}),
        text: lastAssistantText(messages) ?? "",
        messages,
      }
    },
    "model.set": (p) => {
      const ref = text(p, "model")
      // The running turn's history may carry state only its model understands.
      if (agent().busy) throw new RpcError("busy", `${running()} is running; set the model after it ends`)
      try {
        agent().setModel(ai.model(ref))
      } catch (err) {
        throw new RpcError("invalid_params", err instanceof Error ? err.message : String(err))
      }
      return { model: modelLabel({ provider: agent().model.provider, model: agent().model.id }) }
    },
    "thinking.set": (p) => {
      const level = text(p, "level")
      if (
        level !== "default" &&
        level !== "low" &&
        level !== "medium" &&
        level !== "high" &&
        level !== "xhigh" &&
        level !== "max"
      ) {
        throw new RpcError("invalid_params", '"level" must be low, medium, high, xhigh, max or default')
      }
      if (agent().busy) throw new RpcError("busy", `${running()} is running; set thinking after it ends`)
      agent().thinking.set(level === "default" ? undefined : level, agent().model)
      return agent().thinking.state(agent().model)
    },
    state: () => {
      const last = lastAssistantText(agent().messages)
      return {
        status: agent().status,
        model: modelLabel({ provider: agent().model.provider, model: agent().model.id }),
        sessionId: agent().sessionId,
        ...(agent().turnId ? { turnId: agent().turnId } : {}),
        messages: agent().messages.length,
        ...(last !== undefined ? { lastAssistantText: last } : {}),
        busy: agent().busy,
        ...agent().thinking.state(agent().model),
        uiRequests: ui.pending.map(rpcUiRequest),
      }
    },
    "session.rename": (p) => {
      const rename = needCommands().control.rename
      if (!rename) throw new RpcError("not_supported", "this host cannot rename sessions")
      const title = text(p, "title")
      if (!title.trim()) throw new RpcError("invalid_params", "title must not be empty")
      rename(title)
      return { sessionId: agent().sessionId, title: agent().session?.title }
    },
    "session.fork": async (p) => {
      if (agent().busy) throw new RpcError("busy", `${running()} is running`)
      const fork = needCommands().control.fork
      if (!fork) throw new RpcError("not_supported", "this host cannot fork sessions")
      const index = p.index
      if (index !== undefined && (typeof index !== "number" || !Number.isInteger(index) || index < 0))
        throw new RpcError("invalid_params", "index must be a non-negative integer")
      await fork(index as number | undefined)
      return { sessionId: agent().sessionId }
    },
    "session.resume": async (p) => {
      const sessionId = text(p, "sessionId")
      if (agent().busy) throw new RpcError("busy", `${running()} is running`)
      if (commands) {
        if (sessionId === agent().sessionId) return { sessionId }
        try {
          await commands.control.resume(sessionId)
        } catch (err) {
          throw new RpcError("not_found", err instanceof Error ? err.message : String(err))
        }
        return { sessionId: agent().sessionId }
      }
      if (!deps.resume) throw new RpcError("not_supported", "this host cannot resume sessions")
      const next = await deps.resume(sessionId)
      if (!next) throw new RpcError("not_found", `no session ${sessionId}`)
      await deps.replaceAgent(next)
      return { sessionId: agent().sessionId }
    },
    "command.list": () => ({ commands: needCommands().list(), aliases: needCommands().aliases() }),
    "command.complete": async (p) => await needCommands().complete(text(p)),
    "command.run": async (p) => {
      const r = await needCommands().run(text(p), { frontend: "rpc" })
      if (!r.ok) {
        const unknown =
          !r.command ||
          !needCommands()
            .list()
            .some((c) => c.name === r.command)
        throw new RpcError(unknown ? "not_found" : "command_failed", r.error ?? "command failed")
      }
      return { command: r.command, output: r.output }
    },
    "skill.list": () => ({ skills: needCommands().skills() }),
    "skill.run": async (p) => {
      const name = typeof p.name === "string" ? p.name.trim() : ""
      if (!name || /[\s$]/.test(name)) throw new RpcError("invalid_params", '"name" must be a skill name')
      const args = p.args === undefined ? "" : p.args
      if (typeof args !== "string") throw new RpcError("invalid_params", '"args" must be a string')
      const line = `$${name}${args.trim() ? ` ${args.trim()}` : ""}`
      const known = needCommands().skillLine(line) !== undefined
      const r = await needCommands().runSkill(line, { frontend: "rpc" })
      if (!r.ok) throw new RpcError(known ? "command_failed" : "not_found", r.error ?? "skill failed")
      return { skill: name, output: r.output }
    },
  }

  const needCommands = (): CommandHost => {
    if (!commands) throw new RpcError("not_supported", "this host has no slash commands or skills")
    return commands
  }

  return handlers
}

export interface RpcDispatcherDeps {
  handlers: RpcHandlers
  reply(id: Id, result: Record<string, unknown>): void
  fail(id: Id, code: ErrorCode, message: string): void
}

/** Legacy admission policy: only dialog-capable commands run outside the input reader. */
export function createRpcDispatcher({ handlers, reply, fail }: RpcDispatcherDeps) {
  const runningCommands = new Set<Promise<void>>()
  const handle = async (line: string) => {
    let p: Params | undefined
    try {
      p = parseRequest(line)
    } catch (err) {
      if (err instanceof RpcError) fail(null, err.code, err.message)
      else fail(null, "internal", err instanceof Error ? err.message : String(err))
      return
    }
    if (!p) return
    const id: Id = typeof p.id === "string" || typeof p.id === "number" ? p.id : null
    if (typeof p.cmd !== "string") return fail(id, "invalid_request", 'missing "cmd"')
    const handler = Object.hasOwn(handlers, p.cmd) ? handlers[p.cmd as keyof typeof handlers] : undefined
    if (!handler) return fail(id, "unknown_command", `unknown command "${p.cmd}"`)
    const report = (err: unknown) => {
      if (err instanceof RpcError) fail(id, err.code, err.message)
      else fail(id, "internal", err instanceof Error ? err.message : String(err))
    }
    if (p.cmd === "command.run" || p.cmd === "skill.run" || p.cmd === "ui.action") {
      // Not awaited: a command may ask a question that a later line (ui.respond) answers, and
      // an action may take a while; later lines must still be handled meanwhile.
      const run = (async () => {
        try {
          reply(id, await handler(p))
        } catch (err) {
          report(err)
        }
      })()
      runningCommands.add(run)
      void run.finally(() => runningCommands.delete(run))
      return
    }
    try {
      // Synchronous answers go out before any event the command caused (prompt's turn.start).
      const result = handler(p)
      reply(id, result instanceof Promise ? await result : result)
    } catch (err) {
      report(err)
    }
  }

  return { handle, settle: () => Promise.all(runningCommands) }
}

/** Automatic actions belong to the TUI; RPC clients can still invoke them with ui.action. */
export function rpcUiRequest(request: EventMap["ui.request"]): EventMap["ui.request"] {
  if (request.kind !== "form") return request
  return {
    ...request,
    fields: request.fields.map((field) => {
      if (field.type !== "action") return { ...field }
      const { auto: _auto, ...manual } = field
      return manual
    }),
  }
}

/**
 * Index of the turn's prompt in the history. When entries were replaced (a reload or
 * compaction), falls back to where it started, and to the whole history if that is gone.
 */
function turnStart(messages: Message[], turn: LastTurn): number {
  const i = messages.lastIndexOf(turn.prompt)
  if (i !== -1) return i
  return turn.start < messages.length ? turn.start : 0
}

function lastAssistantText(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== "assistant") continue
    const t = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
    if (t) return t
  }
  return undefined
}
