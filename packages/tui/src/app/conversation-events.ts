import type { ServerToolBlock } from "@amira/ai"
import type { AnyEvent, AssistantMessage, EventMap, Message, UserMessage } from "@amira/api"
import { displayOutput } from "../display-history.ts"
import { compactionNotice } from "../format.ts"
import { replyCitations, serverToolCall } from "../server-tools.ts"
import { INTERRUPTED_NOTICE, modelErrorNotice } from "../transcript.ts"
import type { TranscriptView } from "../view.ts"
import { statusRetryLabel, type TurnActivity } from "./activity.ts"

/**
 * Renders the conversation the UI owns, without driving the main session's input or queue.
 * The caller scopes events to that conversation (including its sub-agents) and handles
 * events.lost. `changed` synchronizes activity animation and requests the next frame.
 */
export function createConversationEvents(
  view: TranscriptView,
  activity: TurnActivity,
  changed: () => void,
  { partial = true }: { partial?: boolean } = {},
) {
  const serverRows = new Map<string, { startedAt: number; ended: boolean }>()
  let shownUsers = new WeakSet<UserMessage>()
  let shownTurns = new Set<string>()
  let endedMessages = new WeakSet<AssistantMessage>()
  let turnShowedOutput = false
  let textSinceRow = true
  let streamComplete = !partial
  let streamedText = ""
  let streamedThinking = ""

  function clearStream(partial: boolean) {
    streamComplete = !partial
    streamedText = ""
    streamedThinking = ""
  }

  function finalContent(message: AssistantMessage, at: number) {
    for (const block of message.content) {
      if (block.type === "thinking") view.reasoningDelta(block.text)
      else if (block.type === "text") {
        view.replyDelta(block.text)
        if (block.text) textSinceRow = true
      } else if (block.type === "serverTool") serverRow(block, at, true)
    }
  }

  function reconcile(message: AssistantMessage, at: number) {
    const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    const thinking = message.content
      .flatMap((block) => (block.type === "thinking" ? [block.text] : []))
      .join("")
    if (text === streamedText && thinking === streamedThinking) return
    if (!streamedText && !streamedThinking) {
      finalContent(message, at)
      return
    }
    // Only append a proven suffix of a complete stream. Late thinking cannot be appended
    // after text: the view may have already committed the earlier reasoning block.
    if (streamComplete && thinking === streamedThinking && text.startsWith(streamedText)) {
      const suffix = text.slice(streamedText.length)
      if (suffix) {
        view.replyDelta(suffix)
        textSinceRow = true
      }
      return
    }
    if (streamComplete && !streamedText && !text && thinking.startsWith(streamedThinking)) {
      view.reasoningDelta(thinking.slice(streamedThinking.length))
      return
    }
    if (view.replaceReply?.(message.content)) {
      textSinceRow = !!text
      return
    }
    // Mixed thinking/tool content may not be replaceable in place. End the partial output
    // and show the authoritative reply as a whole once, rather than joining mismatched parts.
    if (view.replyEnd([])) turnShowedOutput = true
    view.notice("info", "Complete reply (earlier live output was partial):")
    textSinceRow = true
    finalContent(message, at)
  }

  function user(message: UserMessage) {
    // Switching to a live conversation can load its prompt before turn.start is delivered.
    if (shownUsers.has(message)) return
    shownUsers.add(message)
    view.user(message)
  }

  /** Hosted tools start after the preceding reply and finish once, at latest at message.end. */
  function serverRow(block: ServerToolBlock, at: number, final = false) {
    const call = serverToolCall(block)
    let row = serverRows.get(block.id)
    if (row?.ended) return
    if (!row) {
      if (final && block.status === "running") return
      row = { startedAt: at, ended: false }
      serverRows.set(block.id, row)
      if (view.replyEnd([])) turnShowedOutput = true
      textSinceRow = false
    }
    view.toolStart(block.id, call.name, call.args, row.startedAt)
    if (block.status === "running" && !final) return
    row.ended = true
    if (
      view.toolEnd(block.id, {
        result: call.result,
        durationMs: Math.max(0, at - row.startedAt),
        interrupted: call.rejected === "aborted",
        ...(call.rejected ? { rejected: call.rejected } : {}),
      })
    ) {
      turnShowedOutput = true
    }
  }

  function errorNotice(end: EventMap["turn.end"]) {
    const failure = end.failure
    if (!failure) return view.notice("error", modelErrorNotice(end.error))
    view.notice(
      "error",
      failure.hint ? `${failure.summary}\n${failure.hint}` : modelErrorNotice(failure.summary),
      failure.detail,
    )
  }

  function onEvent(e: AnyEvent): void {
    if (view.subagentEvent(e)) {
      changed()
      return
    }
    switch (e.type) {
      case "turn.start":
        if (!e.turnId || !shownTurns.has(e.turnId)) user(e.data.prompt)
        if (e.turnId) {
          shownTurns.add(e.turnId)
          if (shownTurns.size > 4096) shownTurns.delete(shownTurns.values().next().value!)
        }
        activity.turnStarted(() => {
          turnShowedOutput = false
          textSinceRow = true
          serverRows.clear()
          clearStream(true)
        })
        break
      case "model.retry":
        activity.setRetry({ ...e.data, at: e.ts + e.data.delayMs })
        break
      case "message.start":
        clearStream(false)
        activity.messageStarted()
        break
      case "message.delta":
        if (e.data.kind === "text") {
          const text = e.data.text
          streamedText += text
          activity.textDelta(text, () => {
            view.replyDelta(text)
            textSinceRow = true
          })
        } else if (e.data.kind === "thinking") {
          const text = e.data.text
          streamedThinking += text
          activity.thinkingDelta(text, () => view.reasoningDelta(text))
        } else if (e.data.kind === "serverTool") {
          const block = e.data.block
          activity.serverToolDelta(() => serverRow(block, e.ts))
        } else {
          activity.toolCallDelta(e.data.argsDelta.length, e.data.name)
        }
        break
      case "message.end": {
        const { message } = e.data
        if (endedMessages.has(message)) return
        endedMessages.add(message)
        reconcile(message, e.ts)
        for (const block of message.content) if (block.type === "serverTool") serverRow(block, e.ts, true)
        const sources = replyCitations(message.content)
        if (sources) view.replyDelta(textSinceRow ? sources : sources.trimStart())
        textSinceRow = true
        const calls = message.content.flatMap((block) => (block.type === "toolCall" ? [block] : []))
        if (view.replyEnd(calls)) turnShowedOutput = true
        activity.messageEnded(message.usage?.output)
        clearStream(true)
        break
      }
      case "tool.execute.start":
        activity.toolStarted()
        view.toolStart(e.data.toolCallId, e.data.name, e.data.args, e.ts)
        changed()
        // The tool may block the event loop before a scheduled frame can run.
        view.render()
        return
      case "tool.execute.update":
        view.toolUpdate(e.data.toolCallId, e.data.partial)
        break
      case "tool.execute.end": {
        const { result, durationMs, rejected, approval } = e.data
        if (
          view.toolEnd(e.data.toolCallId, {
            result,
            durationMs,
            interrupted: rejected === "aborted",
            ...(rejected ? { rejected } : {}),
            ...(approval ? { approval } : {}),
          })
        ) {
          turnShowedOutput = true
        }
        break
      }
      case "turn.end":
        serverRows.clear()
        clearStream(true)
        if (view.turnEnd()) turnShowedOutput = true
        activity.turnEnded()
        activity.setRetry(undefined)
        if (e.data.reason === "error") errorNotice(e.data)
        else if (e.data.reason === "aborted") view.notice("interrupted", INTERRUPTED_NOTICE)
        else if (!turnShowedOutput) view.notice("info", "No reply")
        break
      case "status.changed":
        // Owner-invoked tools have no synthetic model turn to start/end the activity clock.
        if (e.turnId?.startsWith("o_")) {
          if (e.data.status === "idle") activity.turnEnded()
          else if (!activity.working) activity.turnStarted(() => {})
        }
        activity.setRetrying(statusRetryLabel(e.data))
        break
      case "compact.start":
        activity.startCompaction(e.data.native === true)
        break
      case "compact.end":
        activity.endCompaction()
        view.notice("success", compactionNotice(e.data.replaced, e.data))
        break
      case "compact.failed":
        activity.endCompaction()
        if (e.data.empty) view.notice("info", "Nothing to compact yet.")
        else if (e.data.blocked) view.notice("info", `Compaction skipped: ${e.data.error}`)
        else view.notice("warning", `Compaction failed: ${e.data.error}`)
        break
      case "extension.error":
        view.notice(
          "warning",
          e.data.source === "settings"
            ? `Settings: ${e.data.error}`
            : `Extension ${e.data.source}: ${e.data.error}`,
        )
        break
      case "extension.notice":
      case "command.output":
        displayOutput(view, e.data)
        break
      case "turn.steer":
        // Pending steering belongs to the sender; only injected messages join the transcript.
        if (e.data.state !== "injected") return
        user(e.data.message)
        break
      default:
        return
    }
    changed()
  }

  /** Clear renderer state after the caller refreshes the shared view, without replaying history. */
  function reset(history: readonly Message[] = [], renderedTurnIds: readonly string[] = []): void {
    serverRows.clear()
    shownTurns = new Set(renderedTurnIds)
    shownUsers = new WeakSet(history.filter((message): message is UserMessage => message.role === "user"))
    endedMessages = new WeakSet(
      history.filter((message): message is AssistantMessage => message.role === "assistant"),
    )
    clearStream(true)
    turnShowedOutput = false
    textSinceRow = true
    activity.turnEnded()
    activity.setRetry(undefined)
    activity.endCompaction()
    changed()
  }

  return { onEvent, reset }
}
