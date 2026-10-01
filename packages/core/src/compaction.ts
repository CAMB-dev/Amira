import {
  type Ai,
  type AssistantMessage,
  type CompactionLayout,
  type Message,
  type ModelInfo,
  type ModelRef,
  type Signature,
  serverToolText,
  type Usage,
} from "@amira/ai"
import { formatTokens } from "@amira/api"

export interface CompactionOptions {
  /** Compact once the context passes this fraction of the model's window. Default 0.8. */
  threshold?: number
  /** User turns kept verbatim. Default 2; fewer when the history is short. */
  keepTurns?: number
  /**
   * Model steps of the current turn kept verbatim when only that turn is left to compact
   * (a long single turn). Default 2.
   */
  keepSteps?: number
  /**
   * Model that writes the summary. Default: the session's model. When set, compactions are
   * always text summaries: a server-side checkpoint belongs to the session's model.
   */
  model?: ModelInfo
  /** Set false to never compact automatically. agent.compact() still works. */
  auto?: boolean
  /**
   * Where a server-side checkpoint goes (CompactionLayout); "tail" by default until live
   * tests pick one. Used when the provider's dialect can replay it there, else "tail". Text
   * summaries always go at the tail.
   */
  layout?: CompactionLayout
  /** Tokens of recent user messages the "recent-user" layout keeps. Default 64000 (as Codex). */
  keepUserTokens?: number
}

/** How many tokens of recent user messages the "recent-user" layout keeps by default. */
export const KEEP_USER_TOKENS = 64_000

/**
 * What to tell the user when automatic compaction goes by a context window that is only a
 * guess (ModelInfo.contextWindowSource "default"): where to set the real one.
 */
export function windowGuessNotice(model: ModelInfo, settingsFile: string): string {
  return (
    `The context window of ${model.provider}/${model.id} is not known, so automatic compaction assumes ${formatTokens(model.contextWindow)} tokens ` +
    `and may start too early or too late. Set it with /provider edit ${model.provider}, or as "contextWindow" ` +
    `in the entry for "${model.id}" under providers.${model.provider}.models in ${settingsFile}.`
  )
}

/** Tokens the context held at the time of a reply. */
export function contextTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite + u.output
}

/** Rough tokens messages take: about four characters a token; an image counts as 1000. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0
  let images = 0
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text" || b.type === "thinking") chars += b.text.length
      else if (b.type === "toolCall") chars += b.name.length + JSON.stringify(b.args).length
      else if (b.type === "serverTool") chars += (b.signature?.value ?? JSON.stringify(b.input)).length
      else images++
    }
  }
  return Math.ceil(chars / 4) + images * 1000
}

/**
 * The context size after a compaction, from the size before (as the model counted it) scaled
 * by how much of the history's estimated size is left: the summary and the kept messages.
 * Scaling by the model's own count keeps the estimate close for text of any script, where
 * characters per token differ widely. Never more than before unless the summary is longer
 * than what it replaced. A checkpoint's size is already in tokens: subtract the replaced
 * messages' estimate and add that size, preserving the system prompt and tools' overhead.
 */
export function estimateAfter(
  before: number,
  older: Message[],
  kept: Message[],
  summary: Message[] | number,
): number {
  if (typeof summary === "number") return Math.max(0, before - estimateTokens(older)) + summary
  const was = estimateTokens([...older, ...kept])
  const left = estimateTokens([...summary, ...kept])
  if (was <= 0) return before
  const after = Math.round((before * left) / was)
  return left > was ? after : Math.min(before, after)
}

const SUMMARY_PREFIX = "The earlier part of this conversation was compacted. Summary:"

/**
 * How a compaction summary appears in the conversation: a user message with the summary
 * and a short assistant acknowledgement, so roles keep alternating for every provider.
 */
export function summaryMessages(summary: string, model?: ModelRef, checkpoint?: Signature): Message[] {
  // A server's checkpoint rides on both messages: a dialect that can replay it sends it in
  // their place; any other gets the summary text.
  const sig = checkpoint ? { signature: { ...checkpoint } } : {}
  const ack: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: SUMMARY_ACK, ...sig }],
    model: model ?? { provider: "amira", model: "compaction" },
    stopReason: "end",
  }
  const text = `${SUMMARY_PREFIX}\n\n${summary.trim()}`
  return [{ role: "user", content: [{ type: "text", text, ...sig }] }, ack]
}

/** The server checkpoint a summary message carries, if any (see summaryMessages). */
export function checkpointOf(m: Message): Signature | undefined {
  const first = m.content[0]
  return first?.type === "text" && first.signature?.kind === "checkpoint" ? first.signature : undefined
}

/** The summary text of a summary pair's user message, without its prefix. */
export function summaryOf(m: Message): string {
  const first = m.content[0]
  return first?.type === "text" ? first.text.replace(`${SUMMARY_PREFIX}\n\n`, "").trim() : ""
}

/**
 * The most recent user messages that fit in `budget` tokens (estimateTokens), oldest first,
 * for the "recent-user" layout: real ones only, not earlier summaries. The latest is always
 * kept, even when it alone is larger (it is in the context already).
 */
export function recentUserMessages(messages: Message[], budget: number): Message[] {
  const out: Message[] = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== "user" || isSummaryMessage(m)) continue
    const size = estimateTokens([m])
    if (out.length && used + size > budget) break
    out.unshift(m)
    used += size
  }
  return out
}

const SUMMARY_ACK = "Understood. I will continue from this summary."

/** Whether a message is one of the pair `summaryMessages` makes. */
export function isSummaryMessage(m: Message): boolean {
  const first = m.content[0]
  if (m.content.length !== 1 || first?.type !== "text") return false
  return m.role === "user" ? first.text.startsWith(`${SUMMARY_PREFIX}\n\n`) : first.text === SUMMARY_ACK
}

export interface HistorySplit {
  /** Messages the summary replaces, in history order. */
  older: Message[]
  /** Messages kept verbatim, in history order; the summary goes before them. */
  kept: Message[]
  /**
   * When the current turn's earlier steps are summarized: its prompt, which is kept, so the
   * summary can say what those steps did for it.
   */
  prompt?: Message
}

/**
 * Splits history into older messages to summarize and recent messages to keep. Turns start at
 * user messages other than an earlier summary. Whole turns are cut first: the most recent
 * `keepTurns` stay, fewer when the history is short. When nothing but an earlier summary
 * precedes the current turn, that turn's first model steps are summarized
 * too, keeping its user message and the last `keepSteps` steps (a step is a model reply and
 * its tool results, which always stay together), so one long turn can still be compacted.
 * Returns undefined when nothing but an earlier summary would be summarized.
 */
export function splitHistory(messages: Message[], keepTurns = 2, keepSteps = 2): HistorySplit | undefined {
  const worthIt = (older: Message[]) => older.some((m) => !isSummaryMessage(m))
  const starts = messages.flatMap((m, i) => (m.role === "user" && !isSummaryMessage(m) ? [i] : []))
  for (let keep = Math.max(1, keepTurns); keep >= 1; keep--) {
    const cut = starts.at(-keep)
    if (cut !== undefined && worthIt(messages.slice(0, cut))) {
      return { older: messages.slice(0, cut), kept: messages.slice(cut) }
    }
  }
  // Nothing but an earlier summary precedes the current turn: fold its older steps.
  const turn = starts.at(-1)
  if (turn === undefined) return undefined
  const steps = messages.flatMap((m, i) => (i > turn && m.role === "assistant" ? [i] : []))
  const cut = steps.length > Math.max(1, keepSteps) ? steps.at(-Math.max(1, keepSteps))! : turn + 1
  const older = [...messages.slice(0, turn), ...messages.slice(turn + 1, cut)]
  if (!worthIt(older)) return undefined
  const prompt = messages[turn]!
  return { older, kept: [prompt, ...messages.slice(cut)], ...(cut > turn + 1 ? { prompt } : {}) }
}

const SUMMARY_PROMPT = `You summarize a coding session between a user and Amira, a coding agent, so that the work can continue without the full history.

Write a concise summary that keeps everything needed to carry on:
- What the user asked for, their goals and preferences, in their own words where it matters.
- Decisions made and why.
- Files read, created or changed, with the important details of each change.
- Commands run and their outcomes, including errors and how they were resolved.
- What is done, what is in progress, and what remains.

Use exact paths, names, and values. Do not add anything that is not in the transcript. Reply with the summary only.`

/** The history as plain text; long tool output is shortened. */
export function renderTranscript(messages: Message[], maxBlock = 2000): string {
  const clip = (t: string) =>
    t.length > maxBlock ? `${t.slice(0, maxBlock)}\n[... ${t.length - maxBlock} more characters]` : t
  const out: string[] = []
  for (const m of messages) {
    if (m.role === "user") {
      const text = m.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n")
      out.push(`[user]\n${clip(text)}`)
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "text" && b.text.trim()) out.push(`[assistant]\n${clip(b.text)}`)
        else if (b.type === "toolCall") out.push(`[tool call: ${b.name}]\n${clip(JSON.stringify(b.args))}`)
        else if (b.type === "serverTool") out.push(`[assistant]\n${serverToolText(b)}`)
      }
    } else {
      const text = m.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n")
      out.push(`[tool result: ${m.toolName}${m.isError ? ", error" : ""}]\n${clip(text)}`)
    }
  }
  return out.join("\n\n")
}

/**
 * Asks the model for a summary of `messages`; `instructions` from the user steer it. `prompt`
 * is the request the transcript's last steps work on (see HistorySplit.prompt). Throws when
 * the model fails.
 */
export async function summarize(
  ai: Ai,
  model: ModelInfo,
  messages: Message[],
  signal: AbortSignal,
  instructions?: string,
  prompt?: Message,
): Promise<{ summary: string; usage?: Usage }> {
  const extra = instructions?.trim() ? `\n\nThe user asked for this summary: ${instructions.trim()}` : ""
  const current = prompt
    ? `The transcript ends with steps taken for the user's current request, which stays in the conversation after the summary; say what has been done for it so far:\n\n<current_request>\n${renderTranscript([prompt])}\n</current_request>\n\n`
    : ""
  const request = `${current}Summarize this transcript:\n\n<transcript>\n${renderTranscript(messages)}\n</transcript>${extra}`
  let text = ""
  let usage: Usage | undefined
  // The summary comes from the transcript alone: no tools, and no hosted web search either.
  const writer: ModelInfo = { ...model, caps: { ...model.caps, webSearch: false } }
  for await (const ev of ai.stream(
    {
      model: writer,
      systemPrompt: SUMMARY_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: request }] }],
      tools: [],
    },
    signal,
  )) {
    if (ev.type === "error") throw new SummaryError(ev.error.message, ev.message.usage)
    if (ev.type === "done") {
      text = ev.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
      usage = ev.message.usage
    }
  }
  if (!text.trim()) throw new SummaryError("the model returned an empty summary", usage)
  return { summary: text.trim(), ...(usage ? { usage } : {}) }
}

/** Writing a summary failed; `usage` is what the request still cost, when it said. */
export class SummaryError extends Error {
  constructor(
    message: string,
    readonly usage?: Usage,
  ) {
    super(message)
  }
}
