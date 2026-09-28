import type { AnyEvent } from "@amira/api"
import { type Agent, type CommandHost, parseCommandLine, type TurnResult, type UiRequests } from "@amira/core"

export interface PrintIO {
  stdout: (s: string) => void
  stderr: (s: string) => void
}

const defaultIO: PrintIO = {
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
}

export interface PrintOptions {
  io?: PrintIO
  /** Events emitted before this frontend subscribed (e.g. extension load errors). */
  pending?: AnyEvent[]
  /** How long to wait for slow event subscribers after the turn. Default 2000 ms. */
  flushTimeoutMs?: number
  /** Called once this frontend is subscribed, e.g. to announce the session. */
  onReady?: () => void
  /** Called on a second Ctrl+C. Default exits the process with 130. */
  forceExit?: () => void
  /** Dialogs extensions open; print mode cannot answer them, so they are cancelled. */
  ui?: UiRequests
  /** Slash commands: a prompt like "/status" runs the command instead of a turn. */
  commands?: CommandHost
}

/** Exit codes: 0 done, 1 error, 130 aborted. */
export function exitCode(r: TurnResult): number {
  return r.reason === "done" ? 0 : r.reason === "aborted" ? 130 : 1
}

/** JSON.stringify that never throws: BigInts become strings, cycles and failures are marked. */
export function safeJson(value: unknown): string {
  try {
    const seen = new WeakSet<object>()
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return v.toString()
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[circular]"
        seen.add(v)
      }
      return v
    })
  } catch (err) {
    return JSON.stringify({ unserializable: true, error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * One non-interactive turn. Plain mode streams the reply to stdout and tool
 * activity to stderr; JSON mode writes every event as one JSON line.
 */
export async function runPrint(
  agent: Agent,
  prompt: string,
  json: boolean,
  opts: PrintOptions = {},
): Promise<number> {
  const io = opts.io ?? defaultIO
  let endedWithNewline = true
  const handle = (e: AnyEvent) => {
    if (e.type === "ui.request") {
      io.stderr(`amira: cancelled "${e.data.title}": print mode cannot answer questions\n`)
      opts.ui?.cancel(e.data.requestId)
    }
    if (json) {
      io.stdout(`${safeJson(e)}\n`)
      return
    }
    switch (e.type) {
      case "message.delta":
        if (e.data.kind === "text") {
          io.stdout(e.data.text)
          endedWithNewline = e.data.text.endsWith("\n")
        }
        break
      case "tool.execute.start":
        // Finish an unterminated line of reply text so the tool line starts on its own row.
        if (!endedWithNewline) {
          io.stdout("\n")
          endedWithNewline = true
        }
        io.stderr(`● ${e.data.name} ${summarizeArgs(e.data.args)}\n`)
        break
      case "tool.execute.end":
        if (e.data.result.isError) io.stderr(`  ✗ ${firstLine(e.data.result.content)}\n`)
        break
      case "compact.start":
        if (!endedWithNewline) {
          io.stdout("\n")
          endedWithNewline = true
        }
        io.stderr(`● compacting ${e.data.replacing} older messages\n`)
        break
      case "compact.failed":
        io.stderr(
          e.data.blocked
            ? `● compaction skipped: ${e.data.error}\n`
            : `  ✗ compaction failed: ${e.data.error}\n`,
        )
        break
      case "extension.error":
        io.stderr(`[extension ${e.data.source}] ${e.data.error}\n`)
        break
      case "command.output":
        if (e.data.level === "info") io.stdout(`${e.data.text}\n`)
        else io.stderr(`${e.data.level}: ${e.data.text}\n`)
        break
      case "turn.end":
        if (!endedWithNewline) io.stdout("\n")
        if (e.data.reason === "error") io.stderr(`error: ${e.data.error}\n`)
        if (e.data.reason === "aborted") io.stderr("aborted\n")
        break
    }
  }
  for (const e of opts.pending ?? []) handle(e)
  const off = agent.bus.subscribe(handle)
  opts.onReady?.()

  // First Ctrl+C aborts the turn; a second one exits immediately.
  let interrupted = false
  const forceExit = opts.forceExit ?? (() => process.exit(130))
  const onSigint = () => {
    if (interrupted) return forceExit()
    interrupted = true
    agent.abort()
  }
  process.on("SIGINT", onSigint)
  try {
    let code: number
    if (opts.commands && parseCommandLine(prompt)) {
      code = (await opts.commands.run(prompt, { frontend: "print" })).ok ? 0 : 1
    } else {
      code = exitCode(await agent.prompt(prompt))
    }
    const flushed = await Promise.race([
      agent.bus.flush().then(() => true),
      Bun.sleep(opts.flushTimeoutMs ?? 2000).then(() => false),
    ])
    if (!flushed) io.stderr("amira: some event handlers did not finish; exiting anyway\n")
    return code
  } finally {
    process.off("SIGINT", onSigint)
    off()
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const s = Object.values(args)
    .filter((v) => typeof v === "string" || typeof v === "number")
    .join(" ")
    .replace(/\s+/g, " ")
  return s.length > 100 ? `${s.slice(0, 97)}...` : s
}

function firstLine(content: { type: string; text?: string }[]): string {
  const t = content.find((c) => c.type === "text")?.text ?? ""
  return t.split("\n")[0]!.slice(0, 200)
}
