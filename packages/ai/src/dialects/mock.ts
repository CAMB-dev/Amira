import type { Dialect } from "../dialect.ts"
import { parseToolArgs } from "../tool-args.ts"
import type { AssistantMessage, ModelRequest, StreamEvent, Usage } from "../types.ts"
import { emptyUsage } from "../types.ts"

/** One scripted model reply. */
export interface MockReply {
  text?: string
  thinking?: string
  toolCalls?: { name: string; args: Record<string, unknown> | string; id?: string }[]
  error?: { message: string; retryable?: boolean; status?: number }
  /** Milliseconds to wait before each streamed chunk. */
  delayMs?: number
  usage?: Partial<Usage>
}

export type MockStep = MockReply | ((req: ModelRequest) => MockReply)

/**
 * A scripted dialect for tests: each call to stream() consumes the next step.
 * Requests are recorded so tests can assert on what the model was sent.
 */
export function createMockDialect(steps: MockStep[] = []) {
  const queue = [...steps]
  const requests: ModelRequest[] = []
  let counter = 0

  const dialect: Dialect & { push(...s: MockStep[]): void; requests: ModelRequest[] } = {
    id: "mock",
    requests,
    push: (...s) => queue.push(...s),
    async *stream(req, ctx): AsyncGenerator<StreamEvent> {
      requests.push(structuredClone(req))
      const step = queue.shift() ?? { text: "" }
      const reply = typeof step === "function" ? step(req) : step
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        model: { provider: req.model.provider, model: req.model.id },
        usage: { ...emptyUsage(), ...reply.usage },
      }
      const wait = async () => {
        if (reply.delayMs) await Bun.sleep(reply.delayMs)
        if (ctx.signal.aborted) throw new DOMException("aborted", "AbortError")
      }

      try {
        await wait()
        yield { type: "start" }
        if (reply.error) {
          message.stopReason = "error"
          yield {
            type: "error",
            error: { message: reply.error.message, status: reply.error.status },
            retryable: reply.error.retryable ?? false,
            message,
          }
          return
        }
        if (reply.thinking) {
          message.content.push({ type: "thinking", text: reply.thinking })
          yield { type: "thinking.delta", text: reply.thinking }
        }
        if (reply.text) {
          const block = { type: "text" as const, text: "" }
          message.content.push(block)
          for (const chunk of reply.text.match(/.{1,8}/gs) ?? []) {
            await wait()
            block.text += chunk
            yield { type: "text.delta", text: chunk }
          }
        }
        for (const tc of reply.toolCalls ?? []) {
          await wait()
          const id = tc.id ?? `mock_call_${++counter}`
          const raw = typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args)
          yield { type: "toolCall.delta", id, name: tc.name, argsDelta: raw }
          message.content.push({ type: "toolCall", id, name: tc.name, args: parseToolArgs(raw) })
        }
        message.stopReason = reply.toolCalls?.length ? "toolUse" : "end"
        yield { type: "done", message }
      } catch (e) {
        if (!ctx.signal.aborted) throw e
        message.stopReason = "aborted"
        yield { type: "error", error: { message: "aborted", code: "aborted" }, retryable: false, message }
      }
    },
  }
  return dialect
}
