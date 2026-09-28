import type { Ai, Message, UserContent, UserMessage } from "@amira/ai"
import type { AnyEvent, TurnEndReason } from "@amira/api"
import { type Agent, type CommandHost, newTurnId, type UiRequests } from "@amira/core"
import { safeJson } from "./print.ts"
import type { COMMAND_PARAMS } from "./rpc-schema.ts"
import { stdoutWriter } from "./stdout-writer.ts"

export interface RpcIO {
  /** Command lines from the client; ends when the client closes stdin. */
  lines: AsyncIterable<string>
  /** Writes one line. Resolves once the output can take more, which paces event delivery. */
  write(line: string): void | Promise<void>
  /** Resolves once everything written has left the process. */
  flush?(): Promise<void>
  close?(): void
}

export interface RpcOptions {
  io?: RpcIO
  /** Events emitted before this frontend subscribed (e.g. extension load errors). */
  pending?: AnyEvent[]
  /** Called once this frontend is subscribed, e.g. to announce the session. */
  onReady?: () => void
  /** Events queued for a slow client before streaming deltas are dropped. Default 2000. */
  maxQueue?: number
  /** How long to wait for queued events at exit. Default 2000 ms. */
  flushTimeoutMs?: number
  /**
   * Loads a stored session into a new agent on the same bus; undefined when there is no such
   * session. Without it, session.resume answers not_supported.
   */
  resume?: (sessionId: string) => Promise<Agent | undefined>
}

export interface RpcSession {
  agent: Agent
  ai: Ai
  ui: UiRequests
  /**
   * Slash commands, for command.list, command.complete and command.run. When given, it owns
   * the active agent: session.resume goes through it, and this frontend follows its switches.
   */
  commands?: CommandHost
}

type ErrorCode =
  | "parse_error"
  | "invalid_request"
  | "unknown_command"
  | "invalid_params"
  | "busy"
  | "not_found"
  | "not_supported"
  | "command_failed"
  | "internal"

class RpcError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

type Id = string | number | null
type Params = Record<string, unknown>
type Handler = (p: Params) => Record<string, unknown> | Promise<Record<string, unknown>>

/** What the client needs to read back the most recent turn. */
interface LastTurn {
  turnId: string
  prompt: UserMessage
  /** Where the prompt sat in the history when the turn started. */
  start: number
  reason?: TurnEndReason
  error?: string
}

/**
 * Headless mode (D18): JSONL commands on stdin, JSONL responses and core events on stdout.
 * Resolves with the exit code once stdin closes and the running turn has finished.
 */
export async function runRpc(session: RpcSession, opts: RpcOptions = {}): Promise<number> {
  const io = opts.io ?? stdio()
  const { ai, ui, commands } = session
  let agent = session.agent
  let closed = false
  let lastTurn: LastTurn | undefined
  const offSwitch = commands?.onSwitch((next) => {
    agent = next
    lastTurn = undefined
  })
  /** command.run calls still going; they may wait on dialogs answered by later lines. */
  const runningCommands = new Set<Promise<void>>()

  const send = (value: unknown) => io.write(`${safeJson(value)}\n`)
  const reply = (id: Id, result: Record<string, unknown>) => void send({ id, ok: true, ...result })
  const fail = (id: Id, code: ErrorCode, message: string) =>
    void send({ id, ok: false, error: { code, message } })

  // Tracks turns on its own unbounded queue, so a slow client never loses them.
  const offTurns = agent.bus.subscribe(
    (e) => {
      const last = lastTurn
      if (e.type === "ui.request") {
        // Nobody is left to answer.
        if (closed) ui.cancel(e.data.requestId)
      } else if (e.sessionId !== agent.sessionId) {
        return
      } else if (e.type === "turn.start") {
        const start = agent.messages.lastIndexOf(e.data.prompt)
        lastTurn = {
          turnId: e.turnId!,
          prompt: e.data.prompt,
          start: start === -1 ? agent.messages.length : start,
        }
      } else if (e.type === "turn.end" && last && last.turnId === e.turnId) {
        last.reason = e.data.reason
        if (e.data.error !== undefined) last.error = e.data.error
      }
    },
    { types: ["turn.start", "turn.end", "ui.request"] },
  )
  for (const e of opts.pending ?? []) await send(e)
  // Streaming deltas are dropped (and events.lost sent) once this queue fills up.
  const offEvents = agent.bus.subscribe((e) => send(e), { maxQueue: opts.maxQueue ?? 2000 })
  opts.onReady?.()

  const text = (p: Params, key = "text"): string => {
    const v = p[key]
    if (typeof v !== "string") throw new RpcError("invalid_params", `"${key}" must be a string`)
    return v
  }

  const handlers: Record<keyof typeof COMMAND_PARAMS, Handler> = {
    prompt: (p) => {
      const content: UserContent[] = [{ type: "text", text: text(p) }, ...attachments(p.attachments)]
      if (agent.turnId) throw new RpcError("busy", "a turn is running; steer it or wait for turn.end")
      const turnId = newTurnId()
      agent.prompt({ role: "user", content }, { turnId }).catch(() => {})
      return { turnId }
    },
    steer: (p) => {
      const queued = agent.turnId !== undefined
      agent.steer(text(p))
      return { ...(agent.turnId ? { turnId: agent.turnId } : {}), queued }
    },
    abort: () => {
      const aborted = agent.turnId !== undefined
      agent.abort()
      return { aborted }
    },
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
    "session.read": (p) => {
      if (p.what === "messages") return { messages: agent.messages }
      if (p.what !== "lastTurn")
        throw new RpcError("invalid_params", '"what" must be "lastTurn" or "messages"')
      if (!lastTurn) return { messages: [] }
      const messages = agent.messages.slice(turnStart(agent.messages, lastTurn))
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
      if (agent.turnId) throw new RpcError("busy", "a turn is running; set the model after turn.end")
      try {
        agent.setModel(ai.model(ref))
      } catch (err) {
        throw new RpcError("invalid_params", err instanceof Error ? err.message : String(err))
      }
      return { model: `${agent.model.provider}/${agent.model.id}` }
    },
    state: () => {
      const last = lastAssistantText(agent.messages)
      return {
        status: agent.status,
        model: `${agent.model.provider}/${agent.model.id}`,
        sessionId: agent.sessionId,
        ...(agent.turnId ? { turnId: agent.turnId } : {}),
        messages: agent.messages.length,
        ...(last !== undefined ? { lastAssistantText: last } : {}),
        uiRequests: ui.pending,
      }
    },
    "session.resume": async (p) => {
      const sessionId = text(p, "sessionId")
      if (agent.turnId) throw new RpcError("busy", "a turn is running")
      if (commands) {
        if (sessionId === agent.sessionId) return { sessionId }
        try {
          await commands.control.resume(sessionId)
        } catch (err) {
          throw new RpcError("not_found", err instanceof Error ? err.message : String(err))
        }
        return { sessionId: agent.sessionId }
      }
      if (!opts.resume) throw new RpcError("not_supported", "this host cannot resume sessions")
      const next = await opts.resume(sessionId)
      if (!next) throw new RpcError("not_found", `no session ${sessionId}`)
      agent = next
      lastTurn = undefined
      return { sessionId: agent.sessionId }
    },
    "command.list": () => ({ commands: needCommands().list() }),
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
  }

  const needCommands = (): CommandHost => {
    if (!commands) throw new RpcError("not_supported", "this host has no slash commands")
    return commands
  }

  const handle = async (line: string) => {
    if (!line.trim()) return
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch (err) {
      return fail(null, "parse_error", err instanceof Error ? err.message : String(err))
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return fail(null, "invalid_request", "a command must be a JSON object")
    }
    const p = msg as Params
    const id: Id = typeof p.id === "string" || typeof p.id === "number" ? p.id : null
    if (typeof p.cmd !== "string") return fail(id, "invalid_request", 'missing "cmd"')
    const handler = Object.hasOwn(handlers, p.cmd) ? handlers[p.cmd as keyof typeof handlers] : undefined
    if (!handler) return fail(id, "unknown_command", `unknown command "${p.cmd}"`)
    const report = (err: unknown) => {
      if (err instanceof RpcError) fail(id, err.code, err.message)
      else fail(id, "internal", err instanceof Error ? err.message : String(err))
    }
    if (p.cmd === "command.run") {
      // Not awaited: a command may ask a question that a later line (ui.respond) answers.
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

  // First Ctrl+C aborts the turn; a second one exits.
  let interrupted = false
  const onSigint = () => {
    if (interrupted) process.exit(130)
    interrupted = true
    agent.abort()
  }
  process.on("SIGINT", onSigint)
  try {
    for await (const line of io.lines) await handle(line)
    closed = true
    ui.cancelAll()
    await Promise.all(runningCommands)
    while (agent.turnId) await Bun.sleep(10)
    await Promise.race([agent.bus.flush(), Bun.sleep(opts.flushTimeoutMs ?? 2000)])
    await io.flush?.()
    return 0
  } finally {
    process.off("SIGINT", onSigint)
    offEvents()
    offTurns()
    offSwitch?.()
    io.close?.()
  }
}

function attachments(value: unknown): UserContent[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new RpcError("invalid_params", '"attachments" must be an array')
  return value.map((a, i) => {
    if (a?.type === "text" && typeof a.text === "string") return { type: "text", text: a.text }
    if (a?.type === "image" && typeof a.mimeType === "string" && typeof a.data === "string") {
      return { type: "image", mimeType: a.mimeType, data: a.data }
    }
    throw new RpcError(
      "invalid_params",
      `attachments[${i}] must be {type:"text",text} or {type:"image",mimeType,data}`,
    )
  })
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

/** stdin split into lines, and stdout with backpressure. */
function stdio(): RpcIO {
  // The client went away; nobody is left to report to.
  const out = stdoutWriter({ onClosed: () => process.exit(0) })
  return {
    lines: readLines(process.stdin),
    write: (line) => out.write(line),
    flush: () => out.flush(),
    close: () => out.close(),
  }
}

async function* readLines(input: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    let nl = buffer.indexOf("\n")
    while (nl !== -1) {
      yield buffer.slice(0, nl).replace(/\r$/, "")
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf("\n")
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) yield buffer
}
