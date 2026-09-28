import { parseToolArgs } from "./tool-args.ts"
import type {
  AssistantContent,
  Message,
  ModelRequest,
  StreamEvent,
  ToolCallBlock,
  ToolSpec,
  UserContent,
} from "./types.ts"

/**
 * Tool use for models without native tool calling (caps.tools "none", D40): the tools are
 * described in the system prompt, calls are parsed out of the reply text, and past calls and
 * results are written back into the history as text.
 */
export async function* withTextTools(
  req: ModelRequest,
  open: (req: ModelRequest) => AsyncIterable<StreamEvent>,
): AsyncGenerator<StreamEvent> {
  if (req.model.caps.tools !== "none" || req.tools.length === 0) {
    yield* open(req)
    return
  }
  const prompt = textToolsPrompt(req.tools)
  const parser = new TextToolParser()
  for await (const ev of open({
    ...req,
    systemPrompt: req.systemPrompt ? `${req.systemPrompt}\n\n${prompt}` : prompt,
    messages: toTextToolMessages(req.messages),
    tools: [],
  })) {
    if (ev.type === "text.delta") {
      yield* parser.feed(ev.text)
    } else if (ev.type === "done" || ev.type === "error") {
      yield* parser.end()
      const message = { ...ev.message, content: parser.content(ev.message.content, ev.type === "done") }
      if (ev.type === "done" && parser.calls.length && message.stopReason === "end") {
        message.stopReason = "toolUse"
      }
      yield { ...ev, message }
    } else {
      yield ev
    }
  }
}

export function textToolsPrompt(tools: ToolSpec[]): string {
  const list = tools.map(
    (t) =>
      `<tool name="${t.name}">\n<description>${t.description}</description>\n` +
      `<parameters>${JSON.stringify(t.parameters)}</parameters>\n</tool>`,
  )
  return [
    "# Tools",
    "",
    "You can use the tools below. To call a tool, write a block like this in your reply:",
    "",
    '<tool_call name="TOOL_NAME">',
    '{"argument": "value"}',
    "</tool_call>",
    "",
    "The block holds a JSON object with the tool's arguments, following its parameter schema. " +
      "You may call several tools in one reply. After your tool calls, end your reply: the results " +
      "come back in the next message as <tool_result> blocks. Never write <tool_result> blocks yourself.",
    "",
    "<tools>",
    ...list,
    "</tools>",
  ].join("\n")
}

/** Rewrites tool calls and results as text, merging the user turns this produces. */
export function toTextToolMessages(messages: Message[]): Message[] {
  const out: Message[] = []
  for (const m of messages) {
    if (m.role === "assistant") {
      const content: AssistantContent[] = m.content.map((b) =>
        b.type === "toolCall" ? { type: "text", text: formatCall(b) } : b,
      )
      out.push({ ...m, content })
      continue
    }
    const content: UserContent[] =
      m.role === "user"
        ? m.content
        : [
            {
              type: "text",
              text: `<tool_result name="${m.toolName}" id="${m.toolCallId}"${m.isError ? ' error="true"' : ""}>\n`,
            },
            ...m.content,
            { type: "text", text: "\n</tool_result>" },
          ]
    const last = out.at(-1)
    if (last?.role === "user") out[out.length - 1] = { ...last, content: [...last.content, ...content] }
    else out.push({ role: "user", content })
  }
  return out
}

function formatCall(call: ToolCallBlock): string {
  return `<tool_call name="${call.name}">\n${JSON.stringify(call.args)}\n</tool_call>`
}

const OPEN = "<tool_call"
const CLOSE = "</tool_call>"

/** Splits streamed reply text into plain text and tool calls. */
export class TextToolParser {
  readonly calls: ToolCallBlock[] = []
  text = ""
  #buf = ""
  #call: { name: string } | undefined
  #stopped = false
  #prefix = `text_call_${crypto.randomUUID().slice(0, 8)}_`

  /** The final content: the original thinking, then the plain text, then the calls. */
  content(original: AssistantContent[], withCalls: boolean): AssistantContent[] {
    const out: AssistantContent[] = original.filter((b) => b.type === "thinking")
    const text = this.text.trim()
    if (text) out.push({ type: "text", text })
    if (withCalls) out.push(...this.calls)
    return out
  }

  *feed(chunk: string): Generator<StreamEvent> {
    if (this.#stopped) return
    this.#buf += chunk
    while (true) {
      if (this.#call) {
        const end = this.#buf.indexOf(CLOSE)
        if (end < 0) return
        yield this.#emitCall(this.#call.name, this.#buf.slice(0, end))
        this.#buf = this.#buf.slice(end + CLOSE.length)
        this.#call = undefined
        continue
      }
      // A model that writes its own results after its calls is making them up.
      const fake = this.calls.length ? this.#buf.indexOf("<tool_result") : -1
      const open = findOpen(this.#buf)
      if (fake >= 0 && (open.index < 0 || fake < open.index)) {
        yield* this.#text(this.#buf.slice(0, fake))
        this.#buf = ""
        this.#stopped = true
        return
      }
      if (open.index < 0) {
        const hold = partialTagAt(this.#buf)
        yield* this.#text(this.#buf.slice(0, hold))
        this.#buf = this.#buf.slice(hold)
        return
      }
      if (open.end < 0) {
        yield* this.#text(this.#buf.slice(0, open.index))
        this.#buf = this.#buf.slice(open.index)
        return
      }
      yield* this.#text(this.#buf.slice(0, open.index))
      this.#call = {
        name: /name\s*=\s*["']([^"']+)["']/.exec(this.#buf.slice(open.index, open.end))?.[1] ?? "",
      }
      this.#buf = this.#buf.slice(open.end + 1)
    }
  }

  /** Flushes what is left; a call cut off at the end is still a call. */
  *end(): Generator<StreamEvent> {
    if (this.#call) yield this.#emitCall(this.#call.name, this.#buf)
    else if (!this.#stopped) yield* this.#text(this.#buf)
    this.#buf = ""
    this.#call = undefined
    this.#stopped = true
  }

  *#text(t: string): Generator<StreamEvent> {
    if (!t) return
    this.text += t
    yield { type: "text.delta", text: t }
  }

  #emitCall(name: string, body: string): StreamEvent {
    let raw = body.trim()
    // Some models put the name inside, as {"name": ..., "arguments": {...}}.
    if (!name) {
      try {
        const v = JSON.parse(raw)
        const args = v?.arguments ?? v?.parameters ?? v?.args ?? {}
        if (typeof v?.name === "string") {
          name = v.name
          raw = typeof args === "string" ? args : JSON.stringify(args)
        }
      } catch {}
    }
    const index = this.calls.length
    const id = `${this.#prefix}${index}`
    this.calls.push({ type: "toolCall", id, name, args: parseToolArgs(raw) })
    return { type: "toolCall.delta", id, index, name, argsDelta: raw }
  }
}

/** The next `<tool_call ...>` tag: its start, and its closing `>` or -1 while incomplete. */
function findOpen(buf: string): { index: number; end: number } {
  let from = 0
  while (true) {
    const index = buf.indexOf(OPEN, from)
    if (index < 0) return { index: -1, end: -1 }
    const next = buf[index + OPEN.length]
    if (next === undefined) return { index, end: -1 }
    if (next === ">" || /\s/.test(next)) return { index, end: buf.indexOf(">", index) }
    from = index + 1
  }
}

/** Where a trailing, possibly incomplete tag of the protocol starts, or the text's length. */
function partialTagAt(buf: string): number {
  const lt = buf.lastIndexOf("<")
  if (lt < 0) return buf.length
  const tail = buf.slice(lt)
  return OPEN.startsWith(tail) || "<tool_result".startsWith(tail) ? lt : buf.length
}
