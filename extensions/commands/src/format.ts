import {
  type AssistantMessage,
  addUsage,
  type CompactionUsage,
  type ContextPreview,
  type ContextWindowSource,
  formatTokens,
  hasUnpricedSearch,
  type Message,
  padCells,
  serverToolText,
  textCells,
  type Usage,
} from "@amira/api"

export { formatTokens }

/** "$1.25", "$0.012", "$0.0004"; tinier amounts show as "<$0.0001". */
export function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01 || usd === 0) return `$${usd.toFixed(3)}`
  return usd < 0.00005 ? "<$0.0001" : `$${usd.toFixed(4)}`
}

/**
 * Output tokens per second of one reply, timed from its first streamed piece to its end.
 * Undefined when the reply was too short to time meaningfully.
 */
export function tokensPerSecond(
  outputTokens: number,
  firstDeltaAt: number,
  endAt: number,
): number | undefined {
  const seconds = (endAt - firstDeltaAt) / 1000
  if (outputTokens <= 0 || seconds < 0.2) return undefined
  return outputTokens / seconds
}

export interface ReplyTiming {
  start: number
  /** First streamed thinking. */
  thinking?: number
  /** First streamed text or tool-call arguments: the answer the model writes. */
  reply?: number
}

/** Separate the timed phases; estimates never read as provider token counts. */
export function replySpeed(
  message: AssistantMessage,
  timing: ReplyTiming,
  end: number,
  silentGap?: number,
): string | undefined {
  const output = message.usage?.output
  if (output === undefined) return undefined
  const reasoning = message.usage?.reasoning
  const thinking = timing.thinking !== undefined
  // Any thinking block, even an empty signed or redacted one, means the model reasoned.
  const hidden =
    !thinking &&
    ((reasoning ?? 0) > 0 ||
      message.content.some((b) => b.type === "thinking") ||
      (reasoning === undefined &&
        silentGap !== undefined &&
        timing.reply !== undefined &&
        timing.reply - timing.start >= silentGap))
  const estimate = reasoning === undefined && (thinking || hidden)
  const replyTokens = estimate
    ? message.content.reduce(
        (n, b) =>
          n +
          (b.type === "text"
            ? estimateTokens(b.text)
            : b.type === "toolCall"
              ? estimateTokens(b.name + JSON.stringify(b.args))
              : 0),
        0,
      )
    : Math.max(0, output - (reasoning ?? 0))
  const reply = timing.reply === undefined ? undefined : tokensPerSecond(replyTokens, timing.reply, end)
  const streamed = message.content.reduce(
    (n, b) => n + (b.type === "thinking" ? estimateTokens(b.text) : 0),
    0,
  )
  // A reported count far above what streamed means only a summary streamed (OpenAI Responses):
  // the reasoning ran before the summary began, so time it from the request and mark it.
  const summary = reasoning !== undefined && streamed < reasoning / 2
  const thought =
    timing.thinking === undefined
      ? undefined
      : tokensPerSecond(reasoning ?? streamed, summary ? timing.start : timing.thinking, timing.reply ?? end)
  const rate = (n: number) => (n < 10 ? n.toFixed(1) : String(Math.round(n)))
  const parts: string[] = []
  if (reply !== undefined)
    parts.push(`reply ${estimate ? "~" : ""}${rate(reply)} tok/s${hidden ? " (hidden reasoning)" : ""}`)
  if (thought !== undefined)
    parts.push(`thinking ${reasoning === undefined || summary ? "~" : ""}${rate(thought)} tok/s`)
  return parts.length ? parts.join(" · ") : undefined
}

/** Share of prompt tokens served from the provider's cache; undefined before any prompt tokens. */
export function cacheHitRate(input: number, cacheRead: number, cacheWrite: number): number | undefined {
  const prompt = input + cacheRead + cacheWrite
  return prompt > 0 ? cacheRead / prompt : undefined
}

const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "")

/**
 * A context window and where it came from, for /status: "256k (your settings)", "1.1M (from
 * the model catalog)", "128k (default guess — set contextWindow for this model)".
 */
export function windowLabel(tokens: number, source: ContextWindowSource | undefined): string {
  const size = formatTokens(tokens)
  if (source === "settings") return `${size} (your settings)`
  if (source === "catalog") return `${size} (from the model catalog)`
  if (source === "default") return `${size} (default guess — set contextWindow for this model)`
  return size
}

/** Rows of cells as aligned columns, two spaces apart; the last column is not padded. */
export function table(rows: string[][]): string {
  const widths: number[] = []
  for (const row of rows) {
    for (const [i, cell] of row.entries()) widths[i] = Math.max(widths[i] ?? 0, textCells(cell))
  }
  // Measured in terminal cells, so CJK and emoji cells line up too.
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : padCells(cell, widths[i]!)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")
}

export interface ModelCost {
  model: string
  replies: number
  usage: Usage
  /** Undefined when no reply had a price, or a search fee is unknown. */
  cost?: number
}

/** Usage and cost of the replies, per model in the order they were first used. */
export function costByModel(replies: readonly AssistantMessage[]): ModelCost[] {
  const out = new Map<string, ModelCost>()
  const unpricedSearch = new Set<string>()
  for (const r of replies) {
    if (!r.usage) continue
    const model = `${r.model.provider}/${r.model.model}`
    const row = out.get(model) ?? {
      model,
      replies: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    row.replies++
    row.usage = addUsage(row.usage, r.usage)
    if (hasUnpricedSearch(r)) unpricedSearch.add(model)
    row.cost = row.usage.cost
    if (unpricedSearch.has(model)) {
      delete row.cost
      delete row.usage.cost
    }
    out.set(model, row)
  }
  return [...out.values()]
}

/**
 * The /cost report: replies by model, then compactions by model (as "compaction" rows;
 * `replies` then counts compactions).
 */
export function costReport(
  replies: readonly AssistantMessage[],
  compactions: readonly CompactionUsage[] = [],
  sideRequests: readonly CompactionUsage[] = [],
): string {
  const asReplies = compactions.map(
    (c): AssistantMessage => ({ role: "assistant", content: [], model: c.model, usage: c.usage }),
  )
  const compactionRows = costByModel(asReplies).map((r) => ({ ...r, compaction: true }))
  const sideReplies = sideRequests.map(
    (c): AssistantMessage => ({ role: "assistant", content: [], model: c.model, usage: c.usage }),
  )
  // Side requests by purpose, then by model; unlabelled ones are session titles.
  const sideLabels = [...new Set(sideRequests.map((c) => c.label ?? "session title"))]
  const sideRows = sideLabels.flatMap((label) =>
    costByModel(sideReplies.filter((_, i) => (sideRequests[i]?.label ?? "session title") === label)).map(
      (r) => ({ ...r, side: label }),
    ),
  )
  const rows: (ModelCost & { compaction?: boolean; side?: string })[] = [
    ...costByModel(replies),
    ...compactionRows,
    ...sideRows,
  ]
  const unpricedSearch = [...replies, ...asReplies, ...sideReplies].some(hasUnpricedSearch)
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
  const body = rows.map((r) =>
    r.compaction
      ? line(r, `${r.model} (compaction)`, `${r.replies} ${r.replies === 1 ? "compaction" : "compactions"}`)
      : r.side
        ? line(r, `${r.model} (${r.side})`, `${r.replies} requests`)
        : line(r, r.model, `${r.replies} ${r.replies === 1 ? "reply" : "replies"}`),
  )
  if (rows.length > 1) {
    const usage = rows.reduce<Usage>((u, r) => addUsage(u, r.usage), {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
    body.push(line({ usage, cost: unpricedSearch ? undefined : usage.cost }, "total", ""))
  }
  const priced = unpricedSearch
    ? "\nSearch costs are unknown for some replies."
    : rows.some((r) => r.cost === undefined)
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
    else if (b.type === "serverTool") n += estimateTokens(b.signature?.value ?? serverToolText(b))
    else n += estimateTokens(b.signature?.kind === "webSearch" ? b.signature.value : b.text)
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
