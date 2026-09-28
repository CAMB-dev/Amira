import type { AssistantMessage, ContextPreview, Message, Usage } from "@amira/api"

/** Compact token counts: 999, 1.2k, 46k, 2.5M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const k = n / 1000
  if (Number(k.toFixed(1)) < 10) return `${k.toFixed(1)}k`
  if (Math.round(k) < 1000) return `${Math.round(k)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** "$1.25", "$0.012", "$0.0004"; tinier amounts show as "<$0.0001". */
export function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01 || usd === 0) return `$${usd.toFixed(3)}`
  return usd < 0.00005 ? "<$0.0001" : `$${usd.toFixed(4)}`
}

const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "")

/** Rows of cells as aligned columns, two spaces apart; the last column is not padded. */
export function table(rows: string[][]): string {
  const widths: number[] = []
  for (const row of rows) {
    for (const [i, cell] of row.entries()) widths[i] = Math.max(widths[i] ?? 0, cell.length)
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")
}

export interface ModelCost {
  model: string
  replies: number
  usage: Usage
  /** Undefined when no reply of this model had a price. */
  cost?: number
}

/** Usage and cost of the replies, per model in the order they were first used. */
export function costByModel(replies: readonly AssistantMessage[]): ModelCost[] {
  const out = new Map<string, ModelCost>()
  for (const r of replies) {
    if (!r.usage) continue
    const model = `${r.model.provider}/${r.model.model}`
    const row = out.get(model) ?? {
      model,
      replies: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    row.replies++
    row.usage.input += r.usage.input
    row.usage.output += r.usage.output
    row.usage.cacheRead += r.usage.cacheRead
    row.usage.cacheWrite += r.usage.cacheWrite
    if (r.usage.cost !== undefined) row.cost = (row.cost ?? 0) + r.usage.cost
    out.set(model, row)
  }
  return [...out.values()]
}

/** The /cost report. */
export function costReport(replies: readonly AssistantMessage[]): string {
  const rows = costByModel(replies)
  if (!rows.length) return "No model replies with usage in this session yet."
  const line = (r: Pick<ModelCost, "usage" | "cost">, label: string, count: string) => {
    const u = r.usage
    const prompt = u.input + u.cacheRead + u.cacheWrite
    const cached = u.cacheRead ? ` (${percent(u.cacheRead, prompt)} cached)` : ""
    return [
      label,
      count,
      `in ${formatTokens(prompt)}${cached}`,
      `out ${formatTokens(u.output)}`,
      r.cost === undefined ? "price unknown" : formatCost(r.cost),
    ]
  }
  const body = rows.map((r) => line(r, r.model, `${r.replies} ${r.replies === 1 ? "reply" : "replies"}`))
  if (rows.length > 1) {
    const total = rows.reduce(
      (t, r) => ({
        usage: {
          input: t.usage.input + r.usage.input,
          output: t.usage.output + r.usage.output,
          cacheRead: t.usage.cacheRead + r.usage.cacheRead,
          cacheWrite: t.usage.cacheWrite + r.usage.cacheWrite,
        },
        cost: r.cost === undefined ? t.cost : (t.cost ?? 0) + r.cost,
      }),
      { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Pick<ModelCost, "usage" | "cost">,
    )
    body.push(line(total, "total", ""))
  }
  const priced = rows.some((r) => r.cost === undefined)
    ? "\nModels without known prices are not counted."
    : ""
  return `Session cost by model:\n${table(body)}${priced}`
}

/** Rough token estimate: about four characters per token; images count as a flat 1000. */
export function estimateTokens(value: string | Message): number {
  if (typeof value === "string") return Math.ceil(value.length / 4)
  let n = 0
  for (const b of value.content) {
    if (b.type === "image") n += 1000
    else if (b.type === "toolCall") n += estimateTokens(b.name + JSON.stringify(b.args))
    else n += estimateTokens(b.text)
  }
  return n + 4
}

/** The /context report: estimated tokens by part, against the model's window. */
export function contextReport(preview: ContextPreview, window: number, reported: number | undefined): string {
  const parts: [string, number][] = [
    ["System prompt", estimateTokens(preview.systemPrompt)],
    [
      `Tool definitions (${preview.tools.length})`,
      preview.tools.reduce(
        (n, t) => n + estimateTokens(t.name + t.description + JSON.stringify(t.parameters)),
        0,
      ),
    ],
  ]
  const byRole = { user: [0, 0], assistant: [0, 0], toolResult: [0, 0] } as Record<Message["role"], number[]>
  for (const m of preview.messages) {
    byRole[m.role]![0]!++
    byRole[m.role]![1]! += estimateTokens(m)
  }
  const label = { user: "User messages", assistant: "Assistant messages", toolResult: "Tool results" }
  for (const role of ["user", "assistant", "toolResult"] as const) {
    const [count, tokens] = byRole[role]!
    parts.push([`${label[role]} (${count})`, tokens!])
  }
  const total = parts.reduce((n, [, t]) => n + t, 0)
  const rows = parts.map(([name, t]) => [name, `~${formatTokens(t)}`, percent(t, window)])
  rows.push(["Total (estimated)", `~${formatTokens(total)}`, percent(total, window)])
  const free = Math.max(0, window - (reported ?? total))
  const head =
    reported !== undefined
      ? `Context: ${formatTokens(reported)} of ${formatTokens(window)} tokens at the last reply (${percent(reported, window)}); ${formatTokens(free)} free.`
      : `Context window: ${formatTokens(window)} tokens; ~${formatTokens(free)} free.`
  return `${head}\n${table(rows)}\nEstimates count about four characters per token.`
}
