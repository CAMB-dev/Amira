import type { CompactionInfo, Message, ToolResultMessage } from "@amira/api"
import { isSummaryMessage } from "@amira/core"
import type { Terminal } from "@amira/tui-kit"
import type { Block, BlockEnv, LinesBlock } from "../blocks/base.ts"
import { userBlock } from "../blocks/base.ts"
import { ReasoningBlock, SummaryBlock } from "../blocks/reasoning.ts"
import { ReplyBlock } from "../blocks/reply.ts"
import { groupExplored, ToolBlock } from "../blocks/tool.ts"
import { messageTimestamp } from "../format.ts"
import { summaryText } from "../history.ts"
import { replyCitations, serverToolCall } from "../server-tools.ts"
import { type NoticeLevel, replyEndNotice } from "../transcript.ts"

export interface HistoryBlocksDeps {
  compactionInfo?: (message: Message) => CompactionInfo | undefined
  hyperlinks: boolean
  noticeBlock: (level: NoticeLevel, text: string) => LinesBlock
  sessionId: () => string
  terminal: Pick<Terminal, "columns">
}

export function historyBlocks(
  messages: Message[],
  env: (width: number) => BlockEnv,
  deps: HistoryBlocksDeps,
): Block[] {
  const results = new Map<string, ToolResultMessage>()
  for (const m of messages) {
    if (m.role === "toolResult") results.set(m.toolCallId, m)
  }
  const blocks: Block[] = []
  let assistantSeen = false
  const firstAssistantTime = (timestamp: number | undefined) => {
    if (assistantSeen) return undefined
    assistantSeen = true
    return timestamp
  }
  for (const m of messages) {
    // A compaction's summary is a folded block of its own; the reply that took it goes with it.
    if (isSummaryMessage(m)) {
      if (m.role === "user") blocks.push(new SummaryBlock(summaryText(m), deps.compactionInfo?.(m)))
    } else if (m.role === "user") {
      assistantSeen = false
      blocks.push(userBlock(m, messageTimestamp(m), false))
    } else if (m.role === "assistant") {
      // The sources the reply cited follow its last text, as they did live.
      const sources = replyCitations(m.content)
      const timestamp = messageTimestamp(m)
      const lastText = m.content.findLastIndex((b) => b.type === "text" && b.text.trim() !== "")
      for (const [i, b] of m.content.entries()) {
        if (b.type === "thinking" && (b.text.trim() || b.redacted))
          blocks.push(new ReasoningBlock(b.text, undefined, undefined, false, firstAssistantTime(timestamp)))
        else if (b.type === "text" && b.text.trim()) {
          blocks.push(
            new ReplyBlock(
              i === lastText ? b.text + sources : b.text,
              false,
              deps.hyperlinks,
              firstAssistantTime(timestamp),
            ),
          )
        } else if (b.type === "serverTool") {
          // A search the provider ran shows as the tool row it was live.
          const { rejected, ...call } = serverToolCall(b)
          const row = new ToolBlock(b.id, call.name, call.args, deps.sessionId())
          row.timestamp = firstAssistantTime(timestamp)
          row.end = { result: call.result, ...(rejected ? { rejected } : {}) }
          blocks.push(row)
        } else if (b.type === "toolCall") {
          const call = new ToolBlock(b.id, b.name, b.args, deps.sessionId())
          call.timestamp = firstAssistantTime(timestamp)
          const result = results.get(b.id)
          // A result that records its rejection renders as the call did live; no result at
          // all (the turn was cut short) means it never ran to completion either.
          call.end = result
            ? {
                result: { content: result.content, isError: result.isError },
                ...(result.rejected ? { rejected: result.rejected } : {}),
              }
            : { result: { content: [], isError: true }, rejected: "aborted" }
          blocks.push(call)
        }
      }
      // How the reply ended, when it did not end well: as the live transcript said it.
      const end = replyEndNotice(m)
      if (end) blocks.push(deps.noticeBlock(end.level, end.text))
    }
  }
  return groupExplored(blocks, env(deps.terminal.columns))
}
