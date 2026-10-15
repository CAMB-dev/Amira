import { expect, mock, spyOn, test } from "bun:test"
import type { ServerToolBlock } from "@amira/ai"
import type { AssistantMessage, EventEnvelope, EventMap, UserMessage } from "@amira/api"
import type { TurnActivity } from "../src/app/activity.ts"
import { createConversationEvents } from "../src/app/conversation-events.ts"
import { compactionNotice } from "../src/format.ts"
import { INTERRUPTED_NOTICE, modelErrorNotice } from "../src/transcript.ts"
import type { CallEnd, TranscriptView } from "../src/view.ts"

const prompt: UserMessage = { role: "user", content: [{ type: "text", text: "Hello" }] }
const model = { provider: "p", model: "m" }
const result = { content: [{ type: "text" as const, text: "Done" }] }
const search: ServerToolBlock = {
  type: "serverTool",
  id: "search",
  name: "web_search",
  input: { query: "Bun" },
  status: "running",
}

function event<K extends keyof EventMap>(type: K, data: EventMap[K]): EventEnvelope<K> {
  return { type, data, seq: 1, ts: 1000, sessionId: "owned" }
}

function setup() {
  const view = {
    runningTools: [],
    capturing: false,
    start: mock(),
    activate: mock(),
    setVisible: mock(),
    requestRender: mock(),
    setTheme: mock(),
    render: mock(),
    redraw: mock(),
    openOverlay: mock(),
    closeOverlay: mock(),
    requestOverlayRender: mock(),
    redrawOverlay: mock(),
    renderOverlay: mock(),
    stop: mock(),
    banner: mock(),
    user: mock(),
    replyDelta: mock(),
    reasoningDelta: mock(),
    replyEnd: mock(() => false),
    toolStart: mock(),
    toolUpdate: mock(),
    toolEnd: mock((_id: string, _end: CallEnd) => false),
    turnEnd: mock(() => false),
    subagentEvent: mock(() => false),
    notice: mock(),
    commandEcho: mock(),
    commandOutput: mock(),
    display: mock(),
    dialogEcho: mock(),
    openSession: mock(),
    leaveSession: mock(),
    detailNote: mock(() => ""),
    handleInput: mock(() => false),
  } satisfies TranscriptView
  const activity = {
    shimmerVisible: false,
    working: false,
    compacting: false,
    beginSend: mock(() => ({ turnStartedAt: 0, turnTokens: 0 })),
    sendFailed: mock(),
    turnStarted: mock((beforeClock: () => void) => beforeClock()),
    setRetry: mock(),
    messageStarted: mock(),
    textDelta: mock((_text: string, render: () => void) => render()),
    thinkingDelta: mock((_text: string, render: () => void) => render()),
    serverToolDelta: mock((render: () => void) => render()),
    toolCallDelta: mock(),
    messageEnded: mock(),
    toolStarted: mock(),
    turnEnded: mock(),
    setRetrying: mock(),
    startCompaction: mock(),
    endCompaction: mock(),
    render: mock(() => []),
  } satisfies TurnActivity
  const changed = mock()
  return { view, activity, changed, ...createConversationEvents(view, activity, changed) }
}

test("owned tool operations start and end activity without inventing a model prompt", () => {
  const { onEvent, view, activity } = setup()
  onEvent({ ...event("status.changed", { status: "working" }), turnId: "o_check" })
  expect(activity.turnStarted).toHaveBeenCalledTimes(1)
  onEvent({
    ...event("tool.execute.start", { toolCallId: "check", name: "bash", args: { command: "echo check" } }),
    turnId: "o_check",
  })
  onEvent({
    ...event("tool.execute.end", { toolCallId: "check", name: "bash", result, durationMs: 1 }),
    turnId: "o_check",
  })
  onEvent({ ...event("status.changed", { status: "idle" }), turnId: "o_check" })
  expect(activity.turnEnded).toHaveBeenCalledTimes(1)
  expect(view.toolStart).toHaveBeenCalledTimes(1)
  expect(view.toolEnd).toHaveBeenCalledTimes(1)
  expect(view.user).not.toHaveBeenCalled()
  expect(view.notice).not.toHaveBeenCalled()
})

test("owned turns show users, streamed text and thinking, calls, and usage", () => {
  const { onEvent, view, activity, changed } = setup()
  onEvent(event("turn.start", { prompt }))
  onEvent(event("message.start", { model }))
  onEvent(event("message.delta", { kind: "thinking", text: "Consider" }))
  onEvent(event("message.delta", { kind: "text", text: "Reply" }))
  onEvent(event("message.delta", { kind: "toolCall", toolCallId: "call", name: "read", argsDelta: "{}" }))
  const call = { type: "toolCall" as const, id: "call", name: "read", args: {} }
  view.replyEnd.mockReturnValue(true)
  onEvent(
    event("message.end", {
      message: {
        role: "assistant",
        model,
        content: [{ type: "thinking", text: "Consider" }, { type: "text", text: "Reply" }, call],
      },
    }),
  )
  onEvent(event("turn.end", { reason: "done", steps: 1 }))
  expect(view.user).toHaveBeenCalledWith(prompt)
  expect(view.reasoningDelta.mock.calls).toEqual([["Consider"]])
  expect(view.replyDelta.mock.calls).toEqual([["Reply"]])
  expect(view.replyEnd).toHaveBeenCalledWith([call])
  expect(activity.messageStarted).toHaveBeenCalledTimes(1)
  expect(activity.toolCallDelta).toHaveBeenCalledWith(2, "read")
  expect(activity.messageEnded).toHaveBeenCalledWith(undefined)
  expect(activity.turnEnded).toHaveBeenCalledTimes(1)
  expect(activity.setRetry).toHaveBeenLastCalledWith(undefined)
  expect(view.notice).not.toHaveBeenCalled()
  expect(changed).toHaveBeenCalledTimes(7)
})

test("first focus during streaming replaces a suffix with the authoritative reply once", () => {
  const { view, activity, changed } = setup()
  const replaceReply = mock((_content: AssistantMessage["content"]) => true)
  const renderer = createConversationEvents({ ...view, replaceReply }, activity, changed)
  renderer.onEvent(event("message.delta", { kind: "thinking", text: "end of thought" }))
  renderer.onEvent(event("message.delta", { kind: "text", text: "world" }))
  const message: AssistantMessage = {
    role: "assistant",
    model,
    content: [
      { type: "thinking", text: "Beginning and end of thought" },
      { type: "text", text: "Hello world" },
    ],
  }
  renderer.onEvent(event("message.end", { message }))
  renderer.onEvent(event("message.end", { message }))
  expect(replaceReply).toHaveBeenCalledTimes(1)
  expect(replaceReply).toHaveBeenCalledWith(message.content)
  expect(view.replyDelta.mock.calls).toEqual([["world"]])
  expect(view.reasoningDelta.mock.calls).toEqual([["end of thought"]])
  expect(view.replyEnd).toHaveBeenCalledTimes(1)
  expect(view.notice).not.toHaveBeenCalled()
})

test("inline recovery separates a complete reply from partial live fragments", () => {
  const { onEvent, view } = setup()
  onEvent(event("message.delta", { kind: "thinking", text: "thought suffix" }))
  onEvent(event("message.delta", { kind: "text", text: "world" }))
  onEvent(
    event("message.end", {
      message: {
        role: "assistant",
        model,
        content: [
          { type: "thinking", text: "Full thought suffix" },
          { type: "text", text: "Hello world" },
        ],
      },
    }),
  )
  expect(view.notice).toHaveBeenCalledWith("info", "Complete reply (earlier live output was partial):")
  expect(view.replyDelta.mock.calls).toEqual([["world"], ["Hello world"]])
  expect(view.reasoningDelta.mock.calls).toEqual([["thought suffix"], ["Full thought suffix"]])
  expect(view.replyEnd).toHaveBeenCalledTimes(2)
})

test("complete streams reconcile missing suffixes without repeating their prefix", () => {
  const { onEvent, view } = setup()
  onEvent(event("message.start", { model }))
  onEvent(event("message.delta", { kind: "thinking", text: "Thought" }))
  onEvent(event("message.delta", { kind: "text", text: "Hello" }))
  onEvent(
    event("message.end", {
      message: {
        role: "assistant",
        model,
        content: [
          { type: "thinking", text: "Thought" },
          { type: "text", text: "Hello world" },
        ],
      },
    }),
  )
  expect(view.replyDelta.mock.calls).toEqual([["Hello"], [" world"]])
  expect(view.reasoningDelta.mock.calls).toEqual([["Thought"]])
  expect(view.notice).not.toHaveBeenCalled()
})

test("late final thinking repairs the reply instead of adding a second reasoning fragment", () => {
  const { view, activity, changed } = setup()
  const replaceReply = mock((_content: AssistantMessage["content"]) => true)
  const { onEvent } = createConversationEvents({ ...view, replaceReply }, activity, changed)
  onEvent(event("message.start", { model }))
  onEvent(event("message.delta", { kind: "thinking", text: "Thought" }))
  onEvent(event("message.delta", { kind: "text", text: "Answer" }))
  const message: AssistantMessage = {
    role: "assistant",
    model,
    content: [
      { type: "thinking", text: "Thought completed" },
      { type: "text", text: "Answer" },
    ],
  }
  onEvent(event("message.end", { message }))
  expect(replaceReply).toHaveBeenCalledWith(message.content)
  expect(view.reasoningDelta.mock.calls).toEqual([["Thought"]])
  expect(view.replyDelta.mock.calls).toEqual([["Answer"]])
})

test("a view that cannot retract committed rows ends partial output before showing the complete reply", () => {
  const { view, activity, changed } = setup()
  const output: string[] = []
  const replaceReply = mock((_content: AssistantMessage["content"]) => false)
  const { onEvent } = createConversationEvents(
    {
      ...view,
      replaceReply,
      replyDelta: (text) => {
        output.push(text)
      },
      replyEnd: () => {
        output.push("end")
        return true
      },
      notice: (_level, text) => {
        output.push(text)
      },
    },
    activity,
    changed,
  )
  onEvent(event("message.delta", { kind: "text", text: "suffix" }))
  const message: AssistantMessage = {
    role: "assistant",
    model,
    content: [{ type: "text", text: "Full suffix" }],
  }
  onEvent(event("message.end", { message }))
  onEvent(event("message.end", { message }))
  onEvent(event("turn.end", { reason: "done", steps: 1 }))
  expect(replaceReply).toHaveBeenCalledTimes(1)
  expect(output).toEqual([
    "suffix",
    "end",
    "Complete reply (earlier live output was partial):",
    "Full suffix",
    "end",
  ])
})

test("a thinking-only stream can append its final suffix without duplicating reasoning", () => {
  const { onEvent, view } = setup()
  onEvent(event("message.start", { model }))
  onEvent(event("message.delta", { kind: "thinking", text: "Thought" }))
  onEvent(
    event("message.end", {
      message: { role: "assistant", model, content: [{ type: "thinking", text: "Thought completed" }] },
    }),
  )
  expect(view.reasoningDelta.mock.calls).toEqual([["Thought"], [" completed"]])
  expect(view.replyDelta).not.toHaveBeenCalled()
  expect(view.notice).not.toHaveBeenCalled()
})

test("initial focus can explicitly identify a complete observed stream", () => {
  const { view, activity, changed } = setup()
  const { onEvent } = createConversationEvents(view, activity, changed, { partial: false })
  onEvent(event("message.delta", { kind: "text", text: "Hello" }))
  onEvent(
    event("message.end", {
      message: { role: "assistant", model, content: [{ type: "text", text: "Hello world" }] },
    }),
  )
  expect(view.replyDelta.mock.calls).toEqual([["Hello"], [" world"]])
  expect(view.notice).not.toHaveBeenCalled()
})

test("message end alone renders final content, but reset does not replay finished history", () => {
  const { onEvent, reset, view } = setup()
  const previous: AssistantMessage = {
    role: "assistant",
    model,
    content: [{ type: "text", text: "Old reply" }],
  }
  reset([prompt, previous])
  onEvent(event("message.end", { message: previous }))
  expect(view.replyDelta).not.toHaveBeenCalled()
  const message: AssistantMessage = {
    role: "assistant",
    model,
    content: [
      { type: "thinking", text: "Full thought" },
      { type: "text", text: "Full reply" },
    ],
  }
  onEvent(event("message.end", { message }))
  onEvent(event("message.end", { message }))
  expect(view.replyDelta.mock.calls).toEqual([["Full reply"]])
  expect(view.reasoningDelta.mock.calls).toEqual([["Full thought"]])
  expect(view.replyEnd).toHaveBeenCalledTimes(1)
})

test("reset after lost events starts a new partial stream, not a complete one", () => {
  const { onEvent, reset, view } = setup()
  onEvent(event("message.start", { model }))
  onEvent(event("message.delta", { kind: "text", text: "Before loss" }))
  reset([prompt])
  onEvent(event("message.delta", { kind: "text", text: "After loss" }))
  onEvent(
    event("message.end", {
      message: { role: "assistant", model, content: [{ type: "text", text: "Before loss and After loss" }] },
    }),
  )
  expect(view.notice).toHaveBeenCalledWith("info", "Complete reply (earlier live output was partial):")
  expect(view.replyDelta.mock.calls).toEqual([
    ["Before loss"],
    ["After loss"],
    ["Before loss and After loss"],
  ])
})

test("sub-agent events stay in their tool rows rather than becoming owned reply text", () => {
  const { onEvent, view, activity, changed } = setup()
  view.subagentEvent.mockReturnValue(true)
  onEvent({ ...event("message.delta", { kind: "text", text: "Child reply" }), sessionId: "child" })
  expect(view.subagentEvent).toHaveBeenCalledTimes(1)
  expect(view.replyDelta).not.toHaveBeenCalled()
  expect(activity.textDelta).not.toHaveBeenCalled()
  expect(changed).toHaveBeenCalledTimes(1)
})

test("tool execution renders immediately and preserves partials, approval, and abort rejection", () => {
  const { onEvent, view, activity, changed } = setup()
  const clock = spyOn(Date, "now").mockReturnValue(1200)
  try {
    onEvent(event("tool.execute.start", { toolCallId: "call", name: "read", args: { path: "a" } }))
    expect(activity.toolStarted).toHaveBeenCalledTimes(1)
    expect(view.toolStart).toHaveBeenCalledWith("call", "read", { path: "a" }, 1200)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(view.render).toHaveBeenCalledTimes(1)
    onEvent(event("tool.execute.update", { toolCallId: "call", name: "read", partial: result }))
    expect(view.toolUpdate).toHaveBeenCalledWith("call", result)
    onEvent(
      event("tool.execute.end", {
        toolCallId: "call",
        name: "read",
        result,
        durationMs: 20,
        approval: "user",
      }),
    )
    expect(view.toolEnd).toHaveBeenLastCalledWith("call", {
      result,
      durationMs: 20,
      interrupted: false,
      approval: "user",
    })
    onEvent(
      event("tool.execute.end", {
        toolCallId: "call",
        name: "read",
        result,
        durationMs: 0,
        rejected: "aborted",
      }),
    )
    expect(view.toolEnd).toHaveBeenLastCalledWith("call", {
      result,
      durationMs: 0,
      interrupted: true,
      rejected: "aborted",
    })
  } finally {
    clock.mockRestore()
  }
})

test("hosted search ends once and citations start directly below its row", () => {
  const { onEvent, view } = setup()
  const clock = spyOn(Date, "now").mockReturnValue(1200)
  try {
    onEvent(event("message.delta", { kind: "serverTool", block: search }))
    expect(view.replyEnd).toHaveBeenCalledWith([])
    expect(view.toolStart).toHaveBeenCalledWith("search", "web_search", { query: "Bun" }, 1200)
    expect(view.toolEnd).not.toHaveBeenCalled()
    clock.mockReturnValue(1500)
    const done: ServerToolBlock = { ...search, status: "done" }
    onEvent(event("message.delta", { kind: "serverTool", block: done }))
    onEvent(
      event("message.end", {
        message: {
          role: "assistant",
          model,
          content: [
            done,
            {
              type: "text",
              text: "Answer",
              citations: [{ url: "https://bun.sh", title: "Bun" }],
            },
          ],
        },
      }),
    )
    expect(view.toolEnd).toHaveBeenCalledTimes(1)
    expect(view.toolEnd.mock.calls[0]?.[1]).toMatchObject({ durationMs: 300, interrupted: false })
    expect(view.replyDelta.mock.calls).toEqual([["Answer"], ["\n\nSources:\n1. [Bun](https://bun.sh)"]])
  } finally {
    clock.mockRestore()
  }
})

test("message end aborts unfinished streamed searches but does not start unseen unfinished ones", () => {
  const { onEvent, view } = setup()
  onEvent(event("message.delta", { kind: "serverTool", block: search }))
  onEvent(
    event("message.end", {
      message: {
        role: "assistant",
        model,
        content: [search, { ...search, id: "unseen" }],
      },
    }),
  )
  expect(view.toolStart).toHaveBeenCalledTimes(2)
  expect(view.toolEnd).toHaveBeenCalledTimes(1)
  expect(view.toolEnd.mock.calls[0]?.[1]).toMatchObject({ rejected: "aborted", interrupted: true })
})

test("turn end shows empty, error, structured failure, and interrupted notices", () => {
  const { onEvent, view } = setup()
  onEvent(event("turn.end", { reason: "done", steps: 0 }))
  expect(view.notice).toHaveBeenLastCalledWith("info", "No reply")
  onEvent(event("turn.end", { reason: "error", steps: 0, error: "Unavailable" }))
  expect(view.notice).toHaveBeenLastCalledWith("error", modelErrorNotice("Unavailable"))
  onEvent(
    event("turn.end", {
      reason: "error",
      steps: 0,
      failure: {
        kind: "rate",
        summary: "Too many requests",
        hint: "Try later",
        detail: "Provider detail",
      },
    }),
  )
  expect(view.notice).toHaveBeenLastCalledWith("error", "Too many requests\nTry later", "Provider detail")
  onEvent(event("turn.end", { reason: "aborted", steps: 0 }))
  expect(view.notice).toHaveBeenLastCalledWith("interrupted", INTERRUPTED_NOTICE)
})

test("finished tool output suppresses No reply but the next turn starts empty", () => {
  const { onEvent, view } = setup()
  view.turnEnd.mockReturnValueOnce(true)
  onEvent(event("turn.end", { reason: "done", steps: 1 }))
  expect(view.notice).not.toHaveBeenCalled()
  onEvent(event("turn.start", { prompt }))
  onEvent(event("turn.end", { reason: "done", steps: 0 }))
  expect(view.notice).toHaveBeenCalledWith("info", "No reply")
})

test("retry and compaction events affect only owned activity and notices", () => {
  const { onEvent, view, activity } = setup()
  const retry = {
    attempt: 2,
    maxRetries: 3,
    delayMs: 500,
    kind: "rate" as const,
    status: 429,
    error: "Wait",
  }
  onEvent(event("model.retry", retry))
  expect(activity.setRetry).toHaveBeenCalledWith({ ...retry, at: 1500 })
  onEvent(event("status.changed", { status: "working", reason: "retrying (2/3)" }))
  expect(activity.setRetrying).toHaveBeenCalledWith("retrying (2/3)")
  onEvent(event("compact.start", { reason: "manual", replacing: 10, kept: 2, native: true }))
  expect(activity.startCompaction).toHaveBeenCalledWith(true)
  const compacted = { reason: "manual" as const, summary: "Summary", replaced: 10, kept: 2 }
  onEvent(event("compact.end", compacted))
  expect(view.notice).toHaveBeenLastCalledWith("success", compactionNotice(10, compacted))
  onEvent(event("compact.failed", { error: "Empty", empty: true }))
  expect(view.notice).toHaveBeenLastCalledWith("info", "Nothing to compact yet.")
  onEvent(event("compact.failed", { error: "Busy", blocked: true }))
  expect(view.notice).toHaveBeenLastCalledWith("info", "Compaction skipped: Busy")
  onEvent(event("compact.failed", { error: "Unavailable" }))
  expect(view.notice).toHaveBeenLastCalledWith("warning", "Compaction failed: Unavailable")
  expect(activity.endCompaction).toHaveBeenCalledTimes(4)
})

test("extension notices and command output use the existing displayOutput routing", () => {
  const { onEvent, view } = setup()
  onEvent(event("extension.notice", { source: "ext", level: "info", text: "Notice" }))
  expect(view.notice).toHaveBeenCalledWith("info", "Notice")
  onEvent(event("command.output", { command: "test", level: "warning", text: "Output" }))
  expect(view.commandOutput).toHaveBeenCalledWith("warning", "Output")
  const output = {
    source: "ext",
    level: "success" as const,
    text: "Folded",
    details: "Detail",
    persist: true,
  }
  onEvent(event("extension.notice", output))
  expect(view.display).toHaveBeenCalledWith("success", "Folded", output)
  onEvent(event("extension.error", { source: "settings", error: "Invalid setting" }))
  expect(view.notice).toHaveBeenLastCalledWith("warning", "Settings: Invalid setting")
})

test("reset seeds already visible users without replaying history and clears transient state", () => {
  const { onEvent, reset, view, activity } = setup()
  reset([prompt])
  expect(activity.turnEnded).toHaveBeenCalledTimes(1)
  expect(activity.endCompaction).toHaveBeenCalledTimes(1)
  expect(view.openSession).not.toHaveBeenCalled()
  onEvent(event("turn.start", { prompt }))
  expect(view.user).not.toHaveBeenCalled()
  const steer: UserMessage = { role: "user", content: [{ type: "text", text: "Continue" }] }
  onEvent(event("turn.steer", { message: steer, state: "queued" }))
  expect(view.user).not.toHaveBeenCalled()
  onEvent(event("turn.steer", { message: steer, state: "injected" }))
  onEvent(event("turn.steer", { message: steer, state: "injected" }))
  expect(view.user).toHaveBeenCalledTimes(1)
  expect(view.user).toHaveBeenCalledWith(steer)
  reset()
  onEvent(event("turn.start", { prompt }))
  expect(view.user).toHaveBeenCalledTimes(2)
})

test("events.lost and unrelated control events are left to the caller", () => {
  const { onEvent, view, activity, changed } = setup()
  onEvent(event("events.lost", { dropped: 5 }))
  onEvent(event("ui.render", {}))
  expect(view.subagentEvent).toHaveBeenCalledTimes(2)
  expect(view.notice).not.toHaveBeenCalled()
  expect(activity.turnEnded).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
})
