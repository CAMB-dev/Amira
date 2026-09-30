import type { AssistantContent, Message, ServerToolBlock, Signature, StreamEvent } from "./types.ts"

/**
 * Prepares history for a dialect. Thinking can only be replayed to the dialect that signed
 * it; for any other dialect the reasoning is kept as text wrapped in <thinking> tags, so a
 * conversation survives a switch between providers (D9). Redacted thinking from another
 * dialect cannot be read and is dropped. Messages are copied, never modified.
 */
export function adaptThinking(messages: Message[], dialect: string): Message[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !m.content.some((b) => b.type === "thinking")) return m
    const content: AssistantContent[] = []
    for (const b of m.content) {
      if (b.type !== "thinking" || b.signature?.dialect === dialect) {
        content.push(b)
      } else if (!b.redacted && b.text.trim()) {
        content.push({ type: "text", text: `<thinking>\n${b.text}\n</thinking>` })
      }
    }
    return { ...m, content }
  })
}

/** Where a request goes, which decides what signed data it may carry (canReplay). */
export interface ReplayTarget {
  dialect: string
  /** The provider's id. */
  provider: string
  /** The host of the provider's base URL. */
  host: string
  model: string
  /**
   * The request offers the provider's hosted web search (hasNativeWebSearch). A server tool's
   * item goes back only then: nothing says a server takes one for a tool it was not given.
   */
  webSearch: boolean
}

/**
 * Whether signed data may be sent to `target`: it came from the same dialect, the same provider
 * and the same host. `producer` is the provider of the message holding it, for data that does
 * not name its own. Data stored before hosts were kept is matched by provider alone. A
 * compaction checkpoint must name its provider, host and model, and all three must match:
 * nothing documents that one is valid for another model or endpoint.
 */
export function canReplay(sig: Signature, target: ReplayTarget, producer?: string): boolean {
  if (sig.dialect !== target.dialect) return false
  if (sig.kind === "checkpoint") {
    return sig.provider === target.provider && sig.host === target.host && sig.model === target.model
  }
  const provider = sig.provider ?? producer
  if (provider !== undefined && provider !== target.provider) return false
  if (sig.host !== undefined && sig.host !== target.host) return false
  if (sig.model !== undefined && sig.model !== target.model) return false
  return true
}

/**
 * Whether a server tool's item (a web_search_call) may go back to `target` as it is: only to
 * the dialect, provider and host that produced it (canReplay; a block without a host cannot
 * be told where it came from), and only while the request still offers the tool.
 */
export function canReplayServerTool(b: ServerToolBlock, target: ReplayTarget, producer: string): boolean {
  const sig = b.signature
  return target.webSearch && sig !== undefined && sig.host !== undefined && canReplay(sig, target, producer)
}

/**
 * History as `target` may receive it: signatures it cannot replay (canReplay,
 * canReplayServerTool) are removed, so the dialect sends those blocks as it sends unsigned
 * ones: reasoning as <thinking> text (or not at all when redacted), output text as plain
 * text, a checkpoint's summary as its text, a server tool's call as a text note
 * (serverToolText). Unchanged messages are kept; changed ones are copies.
 */
export function forReplay(messages: Message[], target: ReplayTarget): Message[] {
  let changed = false
  const out = messages.map((m): Message => {
    if (m.role === "toolResult") return m
    const producer = m.role === "assistant" ? m.model.provider : undefined
    const stale = (b: { type: string; signature?: Signature }) =>
      b.signature !== undefined &&
      (b.type === "serverTool"
        ? !canReplayServerTool(b as ServerToolBlock, target, producer ?? "")
        : !canReplay(b.signature, target, producer))
    if (!(m.content as { type: string; signature?: Signature }[]).some(stale)) return m
    changed = true
    const content = m.content.map((b) => {
      if (!("signature" in b) || !stale(b)) return b
      const { signature: _, ...rest } = b
      return rest
    })
    return { ...m, content } as Message
  })
  return changed ? out : messages
}

/**
 * Stamps the host a reply came from on its signatures that do not name one (reasoning, output
 * items and server tools' items alike), so they are only sent back there (canReplay).
 */
export async function* withSignatureHost(
  stream: AsyncIterable<StreamEvent>,
  host: string,
): AsyncGenerator<StreamEvent> {
  for await (const ev of stream) {
    if ((ev.type === "done" || ev.type === "error") && host) {
      for (const b of ev.message.content) {
        if (b.type !== "toolCall" && b.signature && b.signature.host === undefined) b.signature.host = host
      }
    }
    yield ev
  }
}
