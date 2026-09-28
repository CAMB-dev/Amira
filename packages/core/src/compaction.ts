import type { Ai, Message, ModelInfo, Usage } from "@amira/ai"

export interface CompactionOptions {
  /** Compact once the context passes this fraction of the model's window. Default 0.8. */
  threshold?: number
  /** User turns kept verbatim. Default 2; fewer when the history is short. */
  keepTurns?: number
  /** Model that writes the summary. Default: the session's model. */
  model?: ModelInfo
  /** Set false to never compact automatically. agent.compact() still works. */
  auto?: boolean
}

/** Tokens the context held at the time of a reply. */
export function contextTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite + u.output
}

/**
 * Splits history into older messages to summarize and recent turns to keep. The cut is
 * always at a user message, so tool calls and their results stay together. Returns
 * undefined when there is nothing older than the most recent turn.
 */
export function splitHistory(
  messages: Message[],
  keepTurns = 2,
): { older: Message[]; kept: Message[] } | undefined {
  const starts = messages.flatMap((m, i) => (m.role === "user" ? [i] : []))
  for (let keep = Math.max(1, keepTurns); keep >= 1; keep--) {
    const cut = starts.at(-keep)
    if (cut !== undefined && cut > 0) return { older: messages.slice(0, cut), kept: messages.slice(cut) }
  }
  return undefined
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
      }
    } else {
      const text = m.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n")
      out.push(`[tool result: ${m.toolName}${m.isError ? ", error" : ""}]\n${clip(text)}`)
    }
  }
  return out.join("\n\n")
}

/** Asks the model for a summary of `messages`. Throws when the model fails. */
export async function summarize(
  ai: Ai,
  model: ModelInfo,
  messages: Message[],
  signal: AbortSignal,
): Promise<string> {
  const request = `Summarize this transcript:\n\n<transcript>\n${renderTranscript(messages)}\n</transcript>`
  let text = ""
  for await (const ev of ai.stream(
    {
      model,
      systemPrompt: SUMMARY_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: request }] }],
      tools: [],
    },
    signal,
  )) {
    if (ev.type === "error") throw new Error(ev.error.message)
    if (ev.type === "done") {
      text = ev.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
    }
  }
  if (!text.trim()) throw new Error("the model returned an empty summary")
  return text.trim()
}
