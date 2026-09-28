import type { Dialect, DialectContext } from "../dialect.ts"
import { parseSSE } from "../sse.ts"
import { parseToolArgs } from "../tool-args.ts"
import type {
  AssistantContent,
  AssistantMessage,
  Message,
  ModelRequest,
  StopReason,
  StreamEvent,
  Usage,
} from "../types.ts"
import { emptyUsage } from "../types.ts"
import { ToolCallAssembler } from "./openai-chat-tool-calls.ts"

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }

interface ChatToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export function toChatMessages(systemPrompt: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = []
  if (systemPrompt) out.push({ role: "system", content: systemPrompt })
  for (const m of messages) {
    if (m.role === "user") {
      const onlyText = m.content.every((b) => b.type === "text")
      out.push({
        role: "user",
        content: onlyText
          ? m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
          : m.content.map(
              (b): ChatPart =>
                b.type === "text"
                  ? { type: "text", text: b.text }
                  : { type: "image_url", image_url: { url: `data:${b.mimeType};base64,${b.data}` } },
            ),
      })
    } else if (m.role === "assistant") {
      // Chat Completions has no way to send thinking back, so it is dropped here.
      const textOut = m.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
      const calls = m.content
        .filter((b) => b.type === "toolCall")
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.args) },
        }))
      const msg: ChatMessage = { role: "assistant", content: textOut || null }
      if (calls.length) msg.tool_calls = calls
      out.push(msg)
    } else {
      const body = m.content.map((b) => (b.type === "text" ? b.text : `[image: ${b.mimeType}]`)).join("\n")
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: body })
    }
  }
  return out
}

function mapFinish(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "toolUse"
    case "length":
      return "maxTokens"
    case "content_filter":
      return "error"
    default:
      return "end"
  }
}

function mapUsage(u: any): Usage {
  if (!u) return emptyUsage()
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0
  return {
    input: Math.max(0, (u.prompt_tokens ?? 0) - cached),
    output: u.completion_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
  }
}

export const openaiChat: Dialect = {
  id: "openai-chat",
  async *stream(req: ModelRequest, ctx: DialectContext): AsyncGenerator<StreamEvent> {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      model: { provider: req.model.provider, model: req.model.id },
      usage: emptyUsage(),
    }
    const fail = (msg: string, retryable: boolean, extra: { status?: number; code?: string } = {}) => {
      message.stopReason = extra.code === "aborted" ? "aborted" : "error"
      return { type: "error" as const, error: { message: msg, ...extra }, retryable, message }
    }

    const body: Record<string, unknown> = {
      model: req.model.id,
      messages: toChatMessages(req.systemPrompt, req.messages),
      stream: true,
      stream_options: { include_usage: true },
    }
    if (req.tools.length && req.model.caps.tools === "native") {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    }
    if (req.maxTokens) body.max_tokens = req.maxTokens
    if (req.temperature !== undefined) body.temperature = req.temperature

    let res: Response
    try {
      res = await ctx.fetch(`${ctx.endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(ctx.endpoint.apiKey ? { authorization: `Bearer ${ctx.endpoint.apiKey}` } : {}),
          ...ctx.endpoint.headers,
        },
        body: JSON.stringify(body),
        signal: ctx.signal,
      })
    } catch (e) {
      if (ctx.signal.aborted) yield fail("aborted", false, { code: "aborted" })
      else yield fail(`request failed: ${(e as Error).message}`, true)
      return
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "")
      yield fail(`HTTP ${res.status}: ${detail.slice(0, 500)}`, res.status === 429 || res.status >= 500, {
        status: res.status,
      })
      return
    }

    const resBody = res.body
    try {
      yield { type: "start" }
      let textBlock: { type: "text"; text: string } | undefined
      let thinkingBlock: { type: "thinking"; text: string } | undefined
      const calls = new ToolCallAssembler()
      let finish: string | null | undefined

      try {
        for await (const sse of parseSSE(res.body)) {
          if (sse.data === "[DONE]") break
          let chunk: any
          try {
            chunk = JSON.parse(sse.data)
          } catch {
            continue
          }
          if (chunk.error) {
            yield fail(chunk.error.message ?? "stream error", false)
            return
          }
          if (chunk.usage) message.usage = mapUsage(chunk.usage)
          const choice = chunk.choices?.[0]
          if (!choice) continue
          const delta = choice.delta ?? {}
          const reasoning: unknown = delta.reasoning_content ?? delta.reasoning
          if (typeof reasoning === "string" && reasoning) {
            if (!thinkingBlock) {
              thinkingBlock = { type: "thinking", text: "" }
              message.content.push(thinkingBlock)
            }
            thinkingBlock.text += reasoning
            yield { type: "thinking.delta", text: reasoning }
          }
          if (typeof delta.content === "string" && delta.content) {
            if (!textBlock) {
              textBlock = { type: "text", text: "" }
              message.content.push(textBlock)
            }
            textBlock.text += delta.content
            yield { type: "text.delta", text: delta.content }
          }
          yield* calls.apply(delta.tool_calls)
          if (choice.finish_reason) finish = choice.finish_reason
        }
      } catch (e) {
        if (ctx.signal.aborted) yield fail("aborted", false, { code: "aborted" })
        else yield fail(`stream failed: ${(e as Error).message}`, true)
        return
      }

      const toolBlocks: AssistantContent[] = calls.calls.map((c) => ({
        type: "toolCall",
        id: c.id,
        name: c.name,
        args: parseToolArgs(c.args),
      }))
      message.content.push(...toolBlocks)
      const stop = mapFinish(finish)
      if (stop === "error") {
        yield fail("the provider filtered the output (finish_reason: content_filter)", false, {
          code: "content_filter",
        })
        return
      }
      message.stopReason = stop === "end" && toolBlocks.length ? "toolUse" : stop
      yield { type: "done", message }
    } finally {
      // Covers consumers that stop before the body is read to the end.
      await resBody.cancel().catch(() => {})
    }
  },
}
