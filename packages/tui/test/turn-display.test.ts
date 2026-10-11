import { expect, spyOn, test } from "bun:test"
import type { AssistantMessage, Message, ToolDetailLevel, UserMessage } from "@amira/api"
import { FakeTerminal, Spinner, visibleWidth } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { localClock } from "../src/format.ts"
import { createFullscreenView } from "../src/fullscreen-view.ts"
import { createInlineView } from "../src/inline-view.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"
import { closeImageApp, setup as setupApp, waitFor } from "./app-harness.ts"

const at = new Date(2026, 9, 10, 20, 9).getTime()

function setup(mode: "inline" | "fullscreen", binding: string[] = ["ctrl+o"], columns = 100) {
  const terminal = new FakeTerminal(columns, 40)
  const screen = new VirtualScreen(columns, 40)
  const write = terminal.write.bind(terminal)
  terminal.write = (data) => {
    write(data)
    screen.write(data)
  }
  let detail: ToolDetailLevel = "summary"
  const keys = new Keybindings({ ...defaultKeys({ vscode: false }), "tool-output": binding })
  const view = (mode === "inline" ? createInlineView : createFullscreenView)({
    terminal,
    theme: plain.theme,
    capabilities: { win32InputMode: false, kittyKeyboard: true, synchronizedOutput: false, shiftEnter: true },
    settings: {},
    presenters: undefined,
    hyperlinks: false,
    renders: new ReplyRenderers(undefined),
    keys,
    spinner: new Spinner(),
    sessionId: () => "s",
    detail: () => detail,
    bottom: () => ["live header", "input"],
    header: () => ["fixed header"],
    overlay: { render: () => [] },
    editorEmpty: () => true,
    showNote: () => {},
  })
  view.start()
  return {
    view,
    screen,
    text: () => screen.lines.join("\n"),
    fullDetail: () => {
      detail = "full"
      view.render()
    },
  }
}

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: clocks belong to users and the first assistant row, including thinking, not later steps`, () => {
    const clock = spyOn(Date, "now").mockReturnValue(at)
    const { view, screen, text } = setup(mode)
    try {
      view.user({ role: "user", content: [{ type: "text", text: "Prompt." }] })
      view.reasoningDelta("First thought.")
      view.replyDelta("First reply.")
      view.replyEnd([{ id: "call", name: "read", args: { path: "a.ts" } }])
      view.toolStart("call", "read", { path: "a.ts" }, at)
      view.toolEnd("call", { result: { content: [], isError: false }, durationMs: 0 })
      clock.mockReturnValue(at + 180_000)
      view.reasoningDelta("Second thought.")
      view.replyDelta("Later reply.")
      view.replyEnd([])
      view.turnEnd()
      view.render()
      expect(text().split(localClock(at)).slice(1)).toHaveLength(2)
      expect(text()).not.toContain(localClock(at + 180_000))
      expect(
        text()
          .split("\n")
          .find((line) => line.includes("Thought")),
      ).toEndWith(localClock(at))
      expect(
        text()
          .split("\n")
          .find((line) => line.includes("First reply.")),
      ).not.toContain(localClock(at))
      expect(
        text()
          .split("\n")
          .filter((line) => line.includes("Thought")),
      ).toHaveLength(2)
      expect(
        text()
          .split("\n")
          .find((line) => line.includes("Later reply.")),
      ).not.toMatch(/\d{1,2}:\d{2}/)
      view.user({ role: "user", content: [{ type: "text", text: "Next prompt." }] })
      view.replyDelta("Next turn.")
      view.replyEnd([])
      view.turnEnd()
      view.render()
      expect(
        text()
          .split(localClock(at + 180_000))
          .slice(1),
      ).toHaveLength(2)
    } finally {
      view.stop()
      clock.mockRestore()
    }
    expect(screen.mainText.split(localClock(at)).slice(1)).toHaveLength(2)
    expect(screen.mainText.split(localClock(at + 180_000)).slice(1)).toHaveLength(2)
  })

  for (const first of ["reasoning", "tool", "text"] as const) {
    test(`${mode}: ${first}-first clocks are captured when output appears, not by empty deltas`, () => {
      const clock = spyOn(Date, "now").mockReturnValue(at)
      const { view, screen, text } = setup(mode)
      const shownAt = at + 180_000
      try {
        view.user({ role: "user", content: [{ type: "text", text: "Prompt." }] })
        view.replyDelta("")
        view.replyDelta(" \n")
        view.reasoningDelta("")
        view.render()
        expect(text().split(localClock(at)).slice(1)).toHaveLength(1)
        clock.mockReturnValue(shownAt)
        if (first === "reasoning") view.reasoningDelta("A thought.")
        else if (first === "tool") {
          view.replyEnd([{ id: "call", name: "read", args: { path: "a.ts" } }])
          // The event's execution time does not substitute for when its row appeared.
          view.toolStart("call", "read", { path: "a.ts" }, at)
        } else view.replyDelta("First text.")
        view.render()
        const head = text()
          .split("\n")
          .find((row) => row.includes(localClock(shownAt)))!
        expect(head).toContain(first === "reasoning" ? "Thinking" : first === "tool" ? "read" : "First text.")
        expect(visibleWidth(head)).toBe(98)
        clock.mockReturnValue(shownAt + 180_000)
        if (first === "tool") view.toolEnd("call", { result: { content: [], isError: false }, durationMs: 1 })
        view.replyDelta("Later text.")
        view.replyEnd([])
        view.turnEnd()
        view.render()
        expect(text().split(localClock(shownAt)).slice(1)).toHaveLength(1)
        expect(text()).not.toContain(localClock(shownAt + 180_000))
      } finally {
        view.stop()
        clock.mockRestore()
      }
      expect(screen.mainText.split(localClock(shownAt)).slice(1)).toHaveLength(1)
    })
  }

  test(`${mode}: the first exploration clock survives grouping, expansion and exit`, () => {
    const clock = spyOn(Date, "now").mockReturnValue(at)
    const { view, screen, text, fullDetail } = setup(mode)
    try {
      view.replyEnd([
        { id: "a", name: "read", args: { path: "a.ts" } },
        { id: "b", name: "read", args: { path: "b.ts" } },
      ])
      view.toolStart("a", "read", { path: "a.ts" }, at)
      view.render()
      expect(
        text()
          .split("\n")
          .find((row) => row.includes("a.ts")),
      ).toEndWith(localClock(at))
      view.toolEnd("a", { result: { content: [], isError: false }, durationMs: 0 })
      clock.mockReturnValue(at + 180_000)
      view.toolStart("b", "read", { path: "b.ts" }, at + 180_000)
      view.toolEnd("b", { result: { content: [], isError: false }, durationMs: 0 })
      view.render()
      expect(
        text()
          .split("\n")
          .find((row) => row.includes("Read 2 files")),
      ).toEndWith(localClock(at))
      fullDetail()
      expect(text().split(localClock(at)).slice(1)).toHaveLength(1)
      expect(text()).not.toContain(localClock(at + 180_000))
      view.replyDelta("Answer.")
      view.replyEnd([])
      view.turnEnd()
      view.render()
      expect(text().split(localClock(at)).slice(1)).toHaveLength(1)
    } finally {
      view.stop()
      clock.mockRestore()
    }
    expect(screen.mainText.split(localClock(at)).slice(1)).toHaveLength(1)
  })

  test(`${mode}: a thinking clock reserves only its head, not the expanded body or later text`, () => {
    const clock = spyOn(Date, "now").mockReturnValue(at)
    const { view, text, fullDetail } = setup(mode, ["ctrl+o"], 40)
    try {
      view.reasoningDelta("x".repeat(80))
      fullDetail()
      const rows = text().split("\n")
      const head = rows.find((row) => row.includes("Thinking"))!
      expect(head).toEndWith(localClock(at))
      expect(visibleWidth(head)).toBe(38)
      expect(rows).toContain(`    ${"x".repeat(36)}`)
      view.replyDelta("y".repeat(38))
      view.replyEnd([])
      view.turnEnd()
      view.render()
      expect(text().split("\n")).toContain(`  ${"y".repeat(38)}`)
      expect(text().split(localClock(at)).slice(1)).toHaveLength(1)
    } finally {
      view.stop()
      clock.mockRestore()
    }
  })

  for (const binding of [["ctrl+o"], ["ctrl+b"], []]) {
    test(`${mode}: thinking hints use bound keys only where the thought can be expanded`, () => {
      const { view, text, fullDetail } = setup(mode, binding)
      try {
        view.reasoningDelta("Readable thought.")
        view.render()
        const label = binding[0] === "ctrl+b" ? "ctrl+b" : "ctrl+o"
        if (binding.length) expect(text()).toContain(`${label} to expand`)
        else expect(text()).not.toContain("to expand")
        fullDetail()
        expect(text()).toContain("    Readable thought.")
        expect(text()).not.toContain("to expand")
      } finally {
        view.stop()
      }
    })
  }

  test(`${mode}: committed thinking is expandable only in the retained fullscreen transcript`, () => {
    const { view, text, fullDetail } = setup(mode)
    try {
      view.reasoningDelta("Retained thought.")
      view.replyDelta("Answer.")
      view.replyEnd([])
      view.render()
      expect(text().includes("ctrl+o to expand")).toBe(mode === "fullscreen")
      fullDetail()
      expect(text().includes("    Retained thought.")).toBe(mode === "fullscreen")
    } finally {
      view.stop()
    }
  })

  for (const detail of ["summary", "full"] as const) {
    test(`${mode} ${detail}: tool-first history retains its clock through exploration grouping`, () => {
      const first: AssistantMessage & { timestamp: number } = {
        role: "assistant",
        model: { provider: "mock", model: "m" },
        timestamp: at,
        content: [
          { type: "thinking", text: "" },
          { type: "text", text: " \n" },
          { type: "toolCall", id: "a", name: "read", args: { path: "a.ts" } },
          { type: "toolCall", id: "b", name: "read", args: { path: "b.ts" } },
        ],
      }
      const later: AssistantMessage & { timestamp: number } = {
        ...first,
        timestamp: at + 180_000,
        content: [{ type: "text", text: "Answer." }],
      }
      const messages: Message[] = [
        first,
        { role: "toolResult", toolCallId: "a", toolName: "read", content: [], isError: false },
        { role: "toolResult", toolCallId: "b", toolName: "read", content: [], isError: false },
        later,
      ]
      const { view, text, fullDetail } = setup(mode)
      try {
        if (detail === "full") fullDetail()
        view.openSession({ resumed: true }, messages, true)
        view.render()
        const stamped = text()
          .split("\n")
          .find((row) => row.includes(localClock(at)))!
        expect(stamped).toContain(detail === "full" ? "read a.ts" : "Read 2 files")
        expect(text().split(localClock(at)).slice(1)).toHaveLength(1)
        expect(text()).not.toContain(localClock(at + 180_000))
        expect(text()).not.toContain("Thought")
        // Old first output without metadata never moves the clock to a later saved reply.
        const { timestamp: _timestamp, ...oldFirst } = first
        view.openSession({ resumed: true }, [oldFirst, ...messages.slice(1)], true)
        view.render()
        expect(text()).not.toContain(localClock(at + 180_000))
      } finally {
        view.stop()
      }
    })
  }

  test(`${mode}: history carries the same turn clock rule across tools and intermediate messages`, () => {
    const assistant = (text: string, timestamp = at): AssistantMessage & { timestamp: number } => ({
      role: "assistant",
      model: { provider: "mock", model: "m" },
      timestamp,
      content: [
        { type: "thinking", text: "A thought." },
        { type: "text", text },
      ],
    })
    const first = assistant("First reply.")
    first.content.push({ type: "toolCall", id: "call", name: "read", args: { path: "a.ts" } })
    const user: UserMessage & { timestamp: number } = {
      role: "user",
      content: [{ type: "text", text: "Prompt." }],
      timestamp: at,
    }
    const messages: Message[] = [
      user,
      first,
      { role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: false },
      assistant("Later reply.", at + 180_000),
      assistant("Another intermediate reply.", at + 180_000),
    ]
    const { view, text } = setup(mode)
    try {
      view.openSession({ resumed: true }, messages, true)
      view.render()
      expect(text().split(localClock(at)).slice(1)).toHaveLength(2)
      expect(text()).not.toContain(localClock(at + 180_000))
      expect(
        text()
          .split("\n")
          .find((line) => line.includes("Thought")),
      ).toEndWith(localClock(at))
      expect(
        text()
          .split("\n")
          .find((line) => line.includes("First reply.")),
      ).not.toContain(localClock(at))
      expect(
        text()
          .split("\n")
          .filter((line) => line.includes("Thought")),
      ).toHaveLength(3)
      expect(text().includes("ctrl+o to expand")).toBe(mode === "fullscreen")
    } finally {
      view.stop()
    }
  })
}

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: the rebound key named by live thinking actually reveals its content`, async () => {
    let release!: () => void
    const until = new Promise<void>((resolve) => {
      release = resolve
    })
    const keys = new Keybindings({ ...defaultKeys({ vscode: false }), "tool-output": ["ctrl+b"] })
    const app = await setupApp(
      [{ thinking: "A readable thought.", text: "Answer.", hold: { chunks: 0, until } }],
      { settings: { mode }, keybindings: keys, cols: 100, rows: 40 },
    )
    try {
      app.terminal.send("go\r")
      await waitFor(() => app.live().includes("ctrl+b to expand"), "bound thinking hint")
      expect(app.live()).not.toContain("A readable thought.")
      app.terminal.send("\x02")
      await waitFor(() => app.live().includes("    A readable thought."), "expanded thinking")
      expect(app.live()).not.toContain("to expand")
      release()
      await app.idle()
    } finally {
      release()
      await closeImageApp(app)
    }
  })
}

test("inline keeps one blank row above its live header after both committed and live replies", () => {
  const { view, screen } = setup("inline")
  try {
    for (const finish of [false, true]) {
      view.replyDelta("Answer.")
      if (finish) view.replyEnd([])
      view.render()
      const rows = screen.lines
      const header = rows.findIndex((line) => line.trim() === "live header")
      expect(rows[header - 1]?.trim()).toBe("")
      expect(rows[header - 2]?.trim()).toStartWith("Answer.")
    }
  } finally {
    view.stop()
  }
})
