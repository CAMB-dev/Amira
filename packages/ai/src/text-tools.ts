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
      "Use exactly this format and no other tool-calling syntax. " +
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

/**
 * `<tool_call name="x">`, or `<invoke name="x">` as in XML tool formats, also with a prefix
 * inside the tag like DeepSeek's `<｜｜DSML｜｜ invoke name="x">`.
 */
const OPEN = /<(?!\/)[^<>]*?\b(tool_call|invoke)(?=[\s>])[^<>]*>/
const CLOSE: Record<string, RegExp> = {
  tool_call: /<\/[^<>]*?\btool_call\s*>/,
  invoke: /<\/[^<>]*?\binvoke\s*>/,
}
/** Tags that wrap a group of calls; they are dropped from the text. */
const WRAPPER = /<\/?(?:[^<>]*\s)?(?:function_calls|tool_calls|calls)\s*>/g
const FAKE_RESULT = /<(?:[^<>]*\s)?(?:tool_result|function_results)\b/
/** An unfinished tag longer than this is taken to be text. */
const MAX_TAG = 200

/** Splits streamed reply text into plain text and tool calls. */
export class TextToolParser {
  readonly calls: ToolCallBlock[] = []
  text = ""
  #buf = ""
  #call: { tag: string; name: string } | undefined
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
        const close = CLOSE[this.#call.tag]!.exec(this.#buf)
        if (!close) return
        yield this.#emitCall(this.#call.name, this.#buf.slice(0, close.index))
        this.#buf = this.#buf.slice(close.index + close[0].length)
        this.#call = undefined
        continue
      }
      const open = OPEN.exec(this.#buf)
      // A model that writes its own results after its calls is making them up.
      const fake = this.calls.length ? FAKE_RESULT.exec(this.#buf) : null
      if (fake && (!open || fake.index < open.index)) {
        yield* this.#text(this.#buf.slice(0, fake.index))
        this.#buf = ""
        this.#stopped = true
        return
      }
      if (open) {
        yield* this.#text(this.#buf.slice(0, open.index))
        const name = /name\s*=\s*["']([^"']+)["']/.exec(open[0])?.[1] ?? ""
        this.#call = { tag: open[1]!, name }
        this.#buf = this.#buf.slice(open.index + open[0].length)
        continue
      }
      const hold = unfinishedTagAt(this.#buf)
      yield* this.#text(this.#buf.slice(0, hold))
      this.#buf = this.#buf.slice(hold)
      return
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
    const clean = t.replace(WRAPPER, "")
    if (!clean) return
    this.text += clean
    yield { type: "text.delta", text: clean }
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
    const tagged = raw.startsWith("{") ? undefined : parameterTags(raw)
    if (tagged) raw = JSON.stringify(tagged)
    const index = this.calls.length
    const id = `${this.#prefix}${index}`
    this.calls.push({ type: "toolCall", id, name, args: parseToolArgs(raw) })
    return { type: "toolCall.delta", id, index, name, argsDelta: raw }
  }
}

const PARAMETER = /<([^<>]*?parameter\s+name\s*=\s*["']([^"']+)["'][^<>]*)>([\s\S]*?)<\/[^<>]*?parameter\s*>/g

/**
 * Arguments written as `<parameter name="path">a.txt</parameter>` tags, which models trained
 * on XML tool formats tend to fall back to. Values that read as JSON (numbers, objects) are
 * parsed, unless the tag says string="true".
 */
function parameterTags(body: string): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = {}
  for (const [, tag, key, value] of body.matchAll(PARAMETER)) {
    const v = value!.replace(/^\r?\n|\r?\n$/g, "")
    try {
      args[key!] = /string\s*=\s*["']true/.test(tag!) ? v : JSON.parse(v)
    } catch {
      args[key!] = v
    }
  }
  return Object.keys(args).length ? args : undefined
}

/** Where a trailing tag that is still being written starts, or the text's length. */
function unfinishedTagAt(buf: string): number {
  const lt = buf.lastIndexOf("<")
  if (lt < 0 || buf.includes(">", lt) || buf.length - lt > MAX_TAG) return buf.length
  return lt
}
