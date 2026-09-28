import type { AnyEvent } from "@amira/api"
import type { Agent, TurnResult } from "@amira/core"

export interface PrintIO {
  stdout: (s: string) => void
  stderr: (s: string) => void
}

const defaultIO: PrintIO = {
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
}

/** Exit codes: 0 done, 1 error, 130 aborted. */
export function exitCode(r: TurnResult): number {
  return r.reason === "done" ? 0 : r.reason === "aborted" ? 130 : 1
}

/**
 * One non-interactive turn. Plain mode streams the reply to stdout and tool
 * activity to stderr; JSON mode writes every event as one JSON line.
 */
export async function runPrint(
  agent: Agent,
  prompt: string,
  json: boolean,
  io = defaultIO,
  pending: AnyEvent[] = [],
): Promise<number> {
  let endedWithNewline = true
  const handle = (e: AnyEvent) => {
    if (json) {
      io.stdout(`${JSON.stringify(e)}\n`)
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
        io.stderr(`● ${e.data.name} ${summarizeArgs(e.data.args)}\n`)
        break
      case "tool.execute.end":
        if (e.data.result.isError) io.stderr(`  ✗ ${firstLine(e.data.result.content)}\n`)
        break
      case "extension.error":
        io.stderr(`[extension ${e.data.source}] ${e.data.error}\n`)
        break
      case "turn.end":
        if (!endedWithNewline) io.stdout("\n")
        if (e.data.reason === "error") io.stderr(`error: ${e.data.error}\n`)
        if (e.data.reason === "aborted") io.stderr("aborted\n")
        break
    }
  }
  for (const e of pending) handle(e)
  const off = agent.bus.subscribe(handle)

  const onSigint = () => agent.abort()
  process.on("SIGINT", onSigint)
  try {
    const result = await agent.prompt(prompt)
    await agent.bus.flush()
    return exitCode(result)
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
