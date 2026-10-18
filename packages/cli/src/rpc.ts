import type { Ai } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { type Agent, type CommandHost, newTurnId, UiRequests } from "@amira/core"
import { safeJson } from "./json-output.ts"
import { createRpcDispatcher, createRpcOperations, type LastTurn, rpcUiRequest } from "./rpc/operations.ts"
import type { ErrorCode, Id } from "./rpc/validation.ts"
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
  /** Host override for a second Ctrl+C or a closed output; may briefly drain observability first. */
  forceExit?: (code: number) => void
  /**
   * Loads a stored session into a new agent on the same bus; undefined when there is no such
   * session. Without it, session.resume answers not_supported.
   */
  resume?: (sessionId: string) => Promise<Agent | undefined>
}

export interface RpcSession {
  agent: Agent
  ai: Ai
  /** UI request transport; absent means this RPC client cannot answer dialogs. */
  ui?: UiRequests
  /** Explicitly mark an RPC session non-interactive even when a transport object is present. */
  nonInteractive?: boolean
  /**
   * Slash commands and skills, for command.list, command.complete, command.run, skill.list and
   * skill.run. When given, it owns
   * the active agent: session.resume goes through it, and this frontend follows its switches.
   */
  commands?: CommandHost
}

/**
 * Headless mode (D18): JSONL commands on stdin, JSONL responses and core events on stdout.
 * Resolves with the exit code once stdin closes and the running turn has finished.
 */
export async function runRpc(session: RpcSession, opts: RpcOptions = {}): Promise<number> {
  const { ai, commands } = session
  let agent = session.agent
  // The host may briefly drain its trace; standalone callers keep the immediate exit.
  const exitNow =
    opts.forceExit ??
    ((code: number) => {
      void agent.dispose("exit")
      process.exit(code)
    })
  const io = opts.io ?? stdio(() => exitNow(0))
  const ui = session.ui ?? new UiRequests(agent.bus, { sessionId: agent.sessionId })
  // JSONL has actions and direct submission, but no live change/visibility/preview callbacks.
  ui.nativeFormCallbacks = false
  const nonInteractive = session.nonInteractive === true || session.ui === undefined
  let lastTurn: LastTurn | undefined
  const prepareAgent = (a: Agent) => {
    if (!nonInteractive) return
    a.setNonInteractive()
    a.tools.setPolicy({ nonInteractive: true })
  }
  const replaceAgent = async (next: Agent) => {
    const old = agent
    if (old === next) return
    const handover =
      old.sessionId !== next.sessionId
        ? old.backgroundJobsHost?.handoverRoot(old.sessionId, next.sessionId)
        : undefined
    old.handoverBackgroundNotices(next)
    await handover
    await old.dispose("switch")
    agent = next
    prepareAgent(agent)
    lastTurn = undefined
  }
  prepareAgent(agent)
  if (nonInteractive) ui.unavailable = "rpc mode has no UI client"
  let closed = false
  const offSwitch = commands?.onSwitch((next) => {
    agent = next
    prepareAgent(agent)
    lastTurn = undefined
  })
  const send = (value: unknown) => io.write(`${safeJson(value)}\n`)
  const sendEvent = (event: AnyEvent) =>
    send(event.type === "ui.request" ? { ...event, data: rpcUiRequest(event.data) } : event)
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
  for (const e of opts.pending ?? []) await sendEvent(e)
  // Streaming deltas are dropped (and events.lost sent) once this queue fills up.
  const offEvents = agent.bus.subscribe(sendEvent, { maxQueue: opts.maxQueue ?? 2000 })
  opts.onReady?.()

  const dispatcher = createRpcDispatcher({
    handlers: createRpcOperations({
      agent: () => agent,
      ai,
      ui,
      commands,
      lastTurn: () => lastTurn,
      newTurnId,
      resume: opts.resume,
      replaceAgent,
    }),
    reply,
    fail,
  })

  // First Ctrl+C aborts the turn; a second one exits.
  let interrupted = false
  const onSigint = () => {
    if (interrupted) return exitNow(130)
    interrupted = true
    agent.abort()
  }
  process.on("SIGINT", onSigint)
  try {
    for await (const line of io.lines) await dispatcher.handle(line)
    closed = true
    // Approvals asked from now on are refused with a reason instead of a dialog nobody sees.
    ui.unavailable ??= "the rpc client closed its input"
    ui.cancelAll()
    await dispatcher.settle()
    // The running turn or /compact, background sub-agents still expected to report, and the
    // turns their results start; Ctrl+C stops waiting for the sub-agents.
    while (agent.busy || (!interrupted && (agent.expectedNotices > 0 || agent.noticeRetry)))
      await Bun.sleep(10)
    await Promise.race([agent.bus.flush(), Bun.sleep(opts.flushTimeoutMs ?? 2000)])
    await io.flush?.()
    return 0
  } finally {
    process.off("SIGINT", onSigint)
    // Bounded like the other frontends' exit (main.ts); dispose is idempotent.
    await Promise.race([agent.dispose("exit"), Bun.sleep(5000)])
    offEvents()
    offTurns()
    offSwitch?.()
    io.close?.()
  }
}

/** stdin split into lines, and stdout with backpressure. */
function stdio(onClosed: () => void): RpcIO {
  // The client went away; nobody is left to report to.
  const out = stdoutWriter({ onClosed })
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
