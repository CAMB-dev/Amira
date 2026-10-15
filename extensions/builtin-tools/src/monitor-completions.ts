import type { BackgroundJobSession, PendingNotice, UserMessage } from "@amira/api"
import { CompletionBatches } from "./completion-batches.ts"

const NOTICE_BYTES = 4096
const AUTOMATIC = "(Sent automatically; the user did not write this message.)"

interface MonitorCompletion {
  id: string
  final: string
  output: string
  single: UserMessage
}

function snippet(text: string, bytes: number): string {
  const buffer = Buffer.from(text)
  if (buffer.length <= bytes) return text
  if (bytes < 3) return ""
  return `${buffer
    .subarray(0, bytes - 3)
    .toString("utf8")
    .replace(/\uFFFD$/, "")}...`
}

function render(completions: MonitorCompletion[]): UserMessage {
  if (completions.length === 1) return completions[0]!.single
  const head = `Monitors ended. ${AUTOMATIC}`
  const prefixes = completions.map(({ id }) => `Monitor ${id} ended: `)
  const required =
    Buffer.byteLength(head) +
    completions.reduce((bytes, _item, i) => bytes + Buffer.byteLength(prefixes[i]!) + 1, 0)
  const withOutput = completions.filter(({ output }) => output)
  const omissionReserve = withOutput.length ? 64 : 0
  const each = Math.max(0, Math.floor((NOTICE_BYTES - required - omissionReserve) / completions.length))
  const summaries = completions.map(({ final }, i) => `${prefixes[i]}${snippet(final, each)}`)
  let text = `${head}\n${summaries.join("\n")}`
  // Terminal IDs and outcomes take priority over queued output. Every final remains in the
  // same model message even if the process registry has already pruned the job records.
  const outputBudget = Math.max(0, NOTICE_BYTES - omissionReserve - Buffer.byteLength(text))
  const perOutput = Math.floor(outputBudget / Math.max(1, withOutput.length))
  let omitted = 0
  for (const { id, output } of withOutput) {
    const label = `\n${id} output:\n`
    const lines = output.split("\n")
    const shown: string[] = []
    let bytes = Buffer.byteLength(label)
    for (const line of lines) {
      const size = Buffer.byteLength(line) + (shown.length ? 1 : 0)
      if (bytes + size > perOutput) break
      shown.push(line)
      bytes += size
    }
    omitted += lines.length - shown.length
    if (shown.length) text += label + shown.join("\n")
  }
  if (omitted) text += `\n+${omitted} more lines`
  return {
    role: "user",
    content: [{ type: "text", text }],
    display: { text: summaries.join("\n"), origin: "job" },
  }
}

const batches = new CompletionBatches<MonitorCompletion>(render)

/** The host gives each owner one stable scoped view; leases themselves follow handovers. */
export function queueMonitorCompletion(
  owner: BackgroundJobSession,
  notice: PendingNotice,
  completion: MonitorCompletion,
): void {
  batches.add(owner, completion, notice)
}
