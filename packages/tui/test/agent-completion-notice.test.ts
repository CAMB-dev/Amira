import { expect, test } from "bun:test"
import { AGENT_STATUS_BADGES, emptyUsage, textResult } from "@amira/api"
import { EventBus } from "@amira/core"
import { defaultTheme, FakeTerminal, Spinner, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { userLines } from "../src/format.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"
import { createInlineView } from "../src/inline-view.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"
import { messageNoticeLines } from "../src/message-notice.ts"

test("legacy title glyphs cannot turn a failed completion into a successful badge", () => {
  const display = { origin: "subagent", text: "◆ Check ✓ examples ✗ explorer · 2s · 3 tok" }
  const rows = userLines(defaultTheme, { role: "user", content: [], display }, 80)
  expect(rows[0]).toContain(defaultTheme.error("✗ failed"))
  expect(stripAnsi(rows[0]!)).toBe("✗ failed Check ✓ examples · explorer · 2s · 3 tok")
  const ambiguous = { origin: "subagent", text: "◆ Check ✓ fixture · 2s ✗ explorer · 2s · 3 tok" }
  expect(userLines(defaultTheme, { role: "user", content: [], display: ambiguous }, 80)[0]).not.toContain(
    defaultTheme.success("✓ done"),
  )
})

test("legacy clean-stop notes use the same result-aware mapping as new notices", () => {
  const display = {
    origin: "subagent",
    text: "◆ Limit helper ✓ explorer · 1s · 0 tok · turn limit reached",
  }
  const rows = userLines(defaultTheme, { role: "user", content: [], display }, 100)
  expect(rows[0]).toContain(defaultTheme.warning("‖ stopped"))
  expect(stripAnsi(rows[0]!)).toBe("‖ stopped Limit helper · explorer · 1s · 0 tok · turn limit reached")
})

test("complete notice rows fit even when the badge is wider than the supplied width", () => {
  const before = { ...glyphs }
  try {
    for (const overrides of [{}, { pointer: ">" }, { statusStopped: "STOP" }]) {
      setGlyphs(overrides)
      for (const status of ["done", "failed", "stopped"] as const) {
        const display = { origin: "subagent", text: "X", notices: [{ status, text: "X" }] }
        for (const width of [0, 1, 2, 8, 12, 28])
          expect(
            userLines(defaultTheme, { role: "user", content: [], display }, width).every(
              (row) => visibleWidth(row) <= width,
            ),
          ).toBe(true)
      }
    }
  } finally {
    setGlyphs(before)
  }
})

for (const ascii of [false, true]) {
  for (const status of ["done", "failed", "stopped"] as const) {
    test(`background completion is a root ${status} badge with color and word (ASCII=${ascii})`, () => {
      const before = { ...glyphs }
      try {
        if (ascii) setGlyphs({ pointer: ">", separator: "|" })
        const text = `Do look · explorer · 2s · 3 tok${status === "done" ? "" : " · provider stopped unexpectedly"}`
        const renderedText = text.replaceAll(" · ", ` ${glyphs.separator} `)
        const message = {
          role: "user" as const,
          content: [{ type: "text" as const, text: "Full report for the model" }],
          display: { origin: "subagent", text, notices: [{ status, text }] },
        }
        const rows = userLines(defaultTheme, message, 120)
        const badge = AGENT_STATUS_BADGES[status]
        const label = `${ascii ? badge.ascii : badge.symbol} ${badge.label}`
        expect(rows).toEqual([`${defaultTheme[badge.role](label)} ${defaultTheme.muted(renderedText)}`])
        expect(stripAnsi(rows[0]!)).toBe(`${label} ${renderedText}`)
        expect(stripAnsi(rows[0]!)).not.toMatch(/^[└├]/)
        expect(rows.join("\n")).not.toContain("Full report for the model")
      } finally {
        setGlyphs(before)
      }
    })

    test(`host notice renderer styles semantic and legacy ${status} rows (ASCII=${ascii})`, () => {
      const before = { ...glyphs }
      try {
        if (ascii) setGlyphs({ pointer: ">", separator: "|" })
        const reason = status === "done" ? "" : " · HTTP 429: slow down"
        const text = `Do look · explorer · 2s · 3 tok${reason}`
        const legacy = { done: "✓", failed: "✗", stopped: "⊘" }[status]
        const semantic = { text, origin: "subagent", notices: [{ status, text }] }
        const stored = {
          text: `◆ Do look ${legacy} explorer · 2s · 3 tok${reason}`,
          origin: "subagent",
        }
        const badge = AGENT_STATUS_BADGES[status]
        const label = `${ascii ? badge.ascii : badge.symbol} ${badge.label}`
        const expected = [
          `${defaultTheme[badge.role](label)} ${defaultTheme.muted(text.replaceAll(" · ", ` ${glyphs.separator} `))}`,
        ]
        expect(messageNoticeLines(defaultTheme, semantic)).toEqual(expected)
        expect(messageNoticeLines(defaultTheme, stored)).toEqual(expected)
      } finally {
        setGlyphs(before)
      }
    })

    test(`inline background ${status} completion remains explicit after its live node is removed (ASCII=${ascii})`, () => {
      const before = { ...glyphs }
      const terminal = new FakeTerminal(120, 30)
      const screen = new VirtualScreen(120, 30)
      const write = terminal.write.bind(terminal)
      const written: string[] = []
      terminal.write = (data) => {
        write(data)
        written.push(data)
        screen.write(data)
      }
      const view = createInlineView({
        terminal,
        theme: defaultTheme,
        capabilities: {
          win32InputMode: false,
          kittyKeyboard: true,
          synchronizedOutput: false,
          shiftEnter: true,
        },
        settings: { margin: 0, marginRows: 0 },
        presenters: undefined,
        hyperlinks: false,
        renders: new ReplyRenderers(undefined),
        keys: new Keybindings(defaultKeys({ vscode: false })),
        spinner: new Spinner(),
        sessionId: () => "main",
        detail: () => "summary",
        bottom: () => ["input"],
        overlay: { render: () => [] },
        editorEmpty: () => true,
        showNote: () => {},
      })
      const bus = new EventBus()
      try {
        if (ascii) setGlyphs({ pointer: ">", separator: "|" })
        view.start()
        view.toolStart("call", "agent", {}, 0)
        view.subagentEvent(
          bus.emit(
            "subagent.start",
            {
              childSessionId: "child",
              toolCallId: "call",
              title: "Do look",
              prompt: "look",
              role: "explorer",
              model: { provider: "mock", model: "m1" },
              depth: 1,
              cwd: "/work",
              context: "fresh",
              queued: false,
            },
            { sessionId: "main" },
          ),
        )
        view.toolEnd("call", { result: textResult("Started in the background"), durationMs: 0 })
        view.turnEnd()
        view.subagentEvent(
          bus.emit(
            "subagent.end",
            {
              childSessionId: "child",
              status: status === "failed" ? "error" : status === "stopped" ? "aborted" : "done",
              usage: emptyUsage(),
              durationMs: 2000,
              error: status === "done" ? undefined : "its commander finished",
            },
            { sessionId: "main" },
          ),
        )
        const text = "Do look · explorer · 2s · 3 tok · its commander finished"
        view.user({
          role: "user",
          content: [{ type: "text", text: "Full report" }],
          display: { origin: "subagent", text, notices: [{ status, text }] },
        })
        view.render()
        const badge = AGENT_STATUS_BADGES[status]
        const label = `${ascii ? badge.ascii : badge.symbol} ${badge.label}`
        const rendered = `${label} ${text.replaceAll(" · ", ` ${glyphs.separator} `)}`
        const lines = [...screen.scrollback, ...screen.lines].filter((line) => line.includes("3 tok"))
        expect(lines.map((line) => line.trimEnd())).toEqual([rendered])
        expect(written.join("")).toContain(defaultTheme[badge.role](label))
      } finally {
        view.stop()
        setGlyphs(before)
      }
    })
  }
}

test("mixed completion batches preserve each state, detail rows, and bounded wrapping", () => {
  const notices = [
    { status: "done" as const, text: "First · explorer · 2s · 3 tok" },
    { status: "failed" as const, text: "Second · coder · 2s · 3 tok · provider exploded" },
    { text: "  changes kept: 3 files · /tmp/changes.patch" },
    { status: "stopped" as const, text: "Third · reviewer · 2s · 3 tok · its commander finished" },
  ]
  const display = { text: "ignored fallback", origin: "subagent", notices }
  const rows = messageNoticeLines(defaultTheme, display, 28)
  const plain = rows.map(stripAnsi)
  expect(plain.filter((row) => /^(✓ done|✗ failed|‖ stopped) /.test(row))).toHaveLength(3)
  expect(plain.join("\n")).toContain("changes kept:")
  expect(plain.every((row) => visibleWidth(row) <= 28)).toBe(true)
  expect(
    plain.filter((row) => !/^(✓ done|✗ failed|‖ stopped) /.test(row)).every((row) => row.startsWith("  ")),
  ).toBe(true)
})
