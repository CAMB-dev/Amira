import { expect, test } from "bun:test"
import { textResult } from "@amira/api"
import { defaultGlyphs, defaultTheme, Editor, stripAnsi, surfaceTheme, visibleWidth } from "@amira/tui-kit"
import { pendingMessageRows } from "../src/app/outbox.ts"
import { ReplyBlock } from "../src/blocks/reply.ts"
import { Dialog } from "../src/dialog.ts"
import { dialogFrame } from "../src/dialog-frame.ts"
import { commandEchoLines, reasoningLines, treeIndent, userLines } from "../src/format.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"
import { InputBox } from "../src/input-box.ts"
import { finishedToolLines } from "../src/tool-view.ts"
import { noticeLines } from "../src/transcript.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"
import { marginFrame } from "./margins-fixture.ts"

const message = {
  role: "user" as const,
  content: [{ type: "text" as const, text: "one two three four five" }],
}
const plain = (rows: string[]) => rows.map(stripAnsi)

test("prompt, thought, command and composer share the two-cell marker column", () => {
  for (const width of [12, 20, 60]) {
    for (const theme of [defaultTheme, { ...defaultTheme, ...surfaceTheme("dark") }]) {
      const user = plain(userLines(theme, message, width)).filter((row) => row.trim())
      expect(user[0]).toStartWith("› one")
      expect(user.slice(1).every((row) => row.startsWith("  "))).toBe(true)
      expect(plain(commandEchoLines(theme, "/test", width))[0]).toBe("› /test")
      expect(plain(reasoningLines(theme, "", {}, width))[0]).toBe("∴ Thought")
      const editor = new Editor({ prompt: "› " })
      editor.setText("hello")
      const composer = plain(new InputBox(editor).render(width, { theme, color: false, rows: 24 }))
      expect(composer[1]).toStartWith("│›hello")
      expect(composer.every((row) => visibleWidth(row) === width)).toBe(true)
    }
  }
})

test("dialog frame title and filter align with content, option cursor with marker", () => {
  const dialog = new Dialog(
    { requestId: "grid", kind: "select", title: "Models", options: ["claude", "other"] },
    () => {},
  )
  dialog.handleInput({ type: "key", name: "c", text: "c", ctrl: false, alt: false, shift: false })
  const rows = plain(dialog.render(30, { theme: defaultTheme, color: false, rows: 24 }))
  expect(rows[0]).toStartWith("╭ Models")
  expect(rows.find((row) => row.includes("filter:"))).toStartWith("│ filter: c")
  expect(rows.find((row) => row.includes("claude"))).toStartWith("│›claude")
  expect(rows.at(-2)).toBe("│ enter choose · esc cancel  │")
  expect(rows.at(-1)).toBe(`╰${"─".repeat(28)}╯`)
  expect(rows.every((row) => visibleWidth(row) === 30)).toBe(true)
})

test("a whole-row colored focus marker stays in the gutter and keeps its styles", () => {
  const selected = defaultTheme.accent("› selected")
  const rows = dialogFrame("Focus", [selected, "esc cancel"], 30, {
    theme: defaultTheme,
    color: true,
    rows: 24,
  })
  expect(stripAnsi(rows[1]!)).toStartWith("│›selected")
  expect(rows[1]).toContain(defaultTheme.accent("›selected"))
  expect(rows.every((row) => visibleWidth(row) === 30)).toBe(true)
})

test("a dialog title uses every available top-border cell without losing a character", () => {
  const title = "Which approach do you prefer?"
  const dialog = new Dialog({ requestId: "title-fit", kind: "select", title, options: ["one"] }, () => {})
  const rows = plain(dialog.render(32, { theme: defaultTheme, color: false, rows: 24 }))
  expect(rows[0]).toBe(`╭ ${title}╮`)
  expect(visibleWidth(rows[0]!)).toBe(32)
})

test("reply list and quote markers use the gutter; code labels are neither copy nor search text", () => {
  for (const width of [16, 30, 60]) {
    const reply = new ReplyBlock(
      "- list text\n\n> quote text\n\n```typescript\nconst x = 1\n```",
      false,
      false,
    )
    const env = {
      theme: defaultTheme,
      width,
      now: 0,
      spinner: "*",
      detail: "summary" as const,
      presenters: undefined,
      hyperlinks: false,
      nodes: new Map(),
    }
    const pane = new TranscriptPane()
    pane.add(reply)
    pane.render(env, 30)
    const lines = pane.lines(reply, env)
    const rows = plain(lines)
    expect(rows).toContain("• list text")
    expect(rows).toContain(`${defaultGlyphs.quoteBar} quote text`)
    const label = rows.findIndex((row) => row.trim() === "typescript")
    const code = rows.findIndex((row) => row.includes("const x"))
    expect(label).toBeGreaterThan(0)
    expect(rows[label]).toEndWith("typescript")
    expect(rows[code]).toStartWith("  const x")
    expect(reply.copyRows(rows, lines)[label]?.skip).toBe(true)
    expect(reply.searchRows(rows, lines)[label]?.skip).toBe(true)
    expect(pane.codeBlocks(reply)).toHaveLength(1)
    pane.select(reply)
    expect(pane.selectCode(0)).toBe(true)
    expect(pane.codeText()).toBe("const x = 1")
  }
})

test("welcome banner hangs on the content column in real inline and fullscreen printouts", () => {
  for (const fullscreen of [false, true]) {
    for (const columns of [20, 70]) {
      for (const margin of [0, 3]) {
        const frame = marginFrame(fullscreen, columns, 30, { margin, marginRows: 0 })
        const rows = [...frame.committed.scrollback, ...frame.committed.grid]
        const banner = rows.find((row) => row.trimStart().startsWith("Amira margin"))
        // Existing margins collapse below60 columns; the local two-cell gutter never does.
        const left = columns === 20 ? 0 : margin
        expect(banner).toStartWith(`${" ".repeat(left + 2)}Amira margin`)
        if (columns === 20) {
          expect(rows.find((row) => row.trim() === "regression")).toStartWith("  regression")
        }
      }
    }
  }
})

test("pending footer labels, wrapped rows and counters start on the content column", () => {
  for (const width of [20, 40, 70]) {
    const rows = plain(
      pendingMessageRows(
        [
          { label: "queued", text: "long message ".repeat(15) },
          ...Array.from({ length: 4 }, () => ({ label: "steering", text: "short" })),
        ],
        width,
        defaultTheme,
      ),
    )
    expect(rows.every((row) => /^ {2}\S/.test(row))).toBe(true)
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true)
    expect(rows.at(-1)).toBe("  +2 more waiting")
    expect(rows.length).toBeLessThanOrEqual(7)
  }
})

test("sub-agent tree roots share the marker column and add two cells per nested level", () => {
  expect(treeIndent(1)).toBe("")
  expect(treeIndent(2)).toBe("  ")
  expect(treeIndent(3)).toBe("    ")
})

test("wide warning and ASCII tree markers consume the gap within two cells", () => {
  expect(plain(noticeLines(defaultTheme, "warning", "warning"))[0]).toBe("⚠️warning")
  const before = { ...glyphs }
  try {
    setGlyphs({ treeBranch: "|-", treeLast: "`-", result: "`-" })
    const noted = userLines(defaultTheme, { ...message, display: { text: "hello", note: "note" } }, 30)
    expect(plain(noted)[1]).toBe("`-note")
    const rows = plain(
      finishedToolLines(
        defaultTheme,
        undefined,
        { name: "read", args: {}, result: textResult("ok") },
        "summary",
        30,
      ),
    )
    expect(rows[0]).toBe("|-read  ✓ ok")
    expect(rows[0]?.slice(2)).toStartWith("read")
  } finally {
    setGlyphs(before)
  }
})
