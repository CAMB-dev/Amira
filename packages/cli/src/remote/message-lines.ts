import type { Message } from "@amira/ai"
import type { ViewLine, ViewRenderOptions } from "@amira/api"

/** Stored messages as view lines: user prompts, replies, and finished tool calls with their results. */
export function messageLines(
  messages: readonly Message[],
  options: Pick<ViewRenderOptions, "renderReply" | "renderTool" | "toolDetail">,
): ViewLine[] {
  const lines: ViewLine[] = []
  for (const message of messages) {
    if (message.role === "toolResult") continue
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
    if (message.role === "user") lines.push({ kind: "user-message", text: message.display?.text ?? text })
    else {
      lines.push(...(options.renderReply?.(text) ?? [{ kind: "text" as const, text }]))
      for (const call of message.content) {
        if (call.type !== "toolCall") continue
        const result = messages.find((item) => item.role === "toolResult" && item.toolCallId === call.id)
        if (result?.role === "toolResult")
          lines.push(
            ...(options.renderTool?.(
              call.name,
              {
                args: call.args,
                text: result.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n"),
                result: { content: result.content, isError: result.isError, details: result.details },
              },
              options.toolDetail ?? "summary",
            ) ?? [{ kind: "text" as const, text: call.name }]),
          )
      }
    }
  }
  return lines
}
