import { expect, test } from "bun:test"
import { defaultTheme, Editor, stripAnsi, textKey, visibleWidth } from "@amira/tui-kit"
import { Dialog, dialogEchoLines } from "../src/dialog.ts"
import { dialogFrame } from "../src/dialog-frame.ts"
import { InputBox } from "../src/input-box.ts"
import { marginFrame } from "./margins-fixture.ts"

const ctx = { theme: defaultTheme, color: true, rows: 24 }
const options = Array.from({ length: 14 }, (_, i) => `model-${i + 1}`)

for (const fullscreen of [true]) {
  for (const columns of [60, 90, 100]) {
    for (const margin of [0, 3]) {
      test(`dialog border, gutter and footer: fullscreen ${columns} margin ${margin}`, () => {
        const dialog = new Dialog({ requestId: "frame", kind: "select", title: "Model", options }, () => {})
        dialog.maxRows = 8
        const frame = marginFrame(fullscreen, columns, 32, { margin, marginRows: 0 }, { bottom: dialog })
        const rows = frame.live.grid
        const top = rows.findIndex((row) => row.includes("╭ Model"))
        const bottom = rows.findIndex((row, i) => i > top && row.includes("╰"))
        const left = rows[top]!.indexOf("╭")
        const right = rows[top]!.indexOf("╮")
        expect(top).toBeGreaterThanOrEqual(0)
        expect(bottom).toBeGreaterThan(top)
        const effectiveMargin = columns - 2 * margin >= 60 ? margin : 0
        expect(left).toBe(effectiveMargin)
        expect(right).toBe(columns - effectiveMargin - 1)
        for (const row of rows.slice(top + 1, bottom)) {
          expect(row[left]).toBe("│")
          expect(row[right]).toBe("│")
        }
        const selected = rows.find((row) => row.includes("model-1"))!
        expect(selected[left + 1]).toBe("›")
        expect(selected.indexOf("model-1")).toBe(left + 2)
        expect(rows.find((row) => row.includes("1/14"))!.indexOf("1/14")).toBe(left + 2)
        expect(rows[bottom - 1]).toContain("enter choose")
        expect(rows[bottom]!.slice(left, right + 1)).toBe(`╰${"─".repeat(right - left - 1)}╯`)
      })
    }
  }
}

test("ANSI-styled padding is removed without losing the row's styles", () => {
  const counter = defaultTheme.muted("  1/14")
  const rows = dialogFrame("Model", [defaultTheme.accent("› selected"), counter, "esc cancel"], 30, ctx)
  expect(rows.map(stripAnsi)).toEqual([
    `╭ Model${"─".repeat(22)}╮`,
    `│›selected${" ".repeat(19)}│`,
    `│ 1/14${" ".repeat(23)}│`,
    `│ esc cancel${" ".repeat(17)}│`,
    `╰${"─".repeat(28)}╯`,
  ])
  expect(rows[2]).toContain(defaultTheme.muted("1/14"))
})

test("a colored no-match row starts at the content column", () => {
  const dialog = new Dialog({ requestId: "empty", kind: "select", title: "Model", options }, () => {})
  dialog.handleInput(textKey("z"))
  const rows = dialog.render(30, ctx).map(stripAnsi)
  expect(rows.find((row) => row.includes("no match"))!.indexOf("no match")).toBe(2)
})

test("four-row dialogs retain title, selection, interior hint and bottom border", () => {
  const dialog = new Dialog({ requestId: "small", kind: "select", title: "Model", options }, () => {})
  dialog.maxRows = 4
  const rows = dialog.render(30, ctx).map(stripAnsi)
  expect(rows).toHaveLength(4)
  expect(rows[0]).toStartWith("╭ Model")
  expect(rows[1]).toStartWith("│›model-1")
  expect(rows[2]).toContain("enter choose")
  expect(rows[3]).toBe(`╰${"─".repeat(28)}╯`)
})

test("a two-row diff preview retains both ends and an inline omission count", () => {
  const dialog = new Dialog(
    {
      requestId: "short-diff",
      kind: "diff-review",
      title: "Review",
      diff: Array.from({ length: 54 }, (_, i) => `+line ${i + 1}`).join("\n"),
      options: ["merge", "keep"],
    },
    () => {},
  )
  dialog.maxRows = 7
  const rows = dialog.render(60, ctx).map(stripAnsi)
  expect(rows).toHaveLength(7)
  expect(rows[1]).toContain("+ line 1")
  expect(rows[1]).toContain("… 52 more lines …")
  expect(rows[2]).toContain("+ line 54")
  expect(rows[3]).toStartWith("│›1 merge")
  expect(rows[4]).toStartWith("│ 2 keep")
  expect(rows[5]).toContain("enter choose")
  expect(rows[6]).toBe(`╰${"─".repeat(58)}╯`)
})

test("composer keeps both sides and its caret/content column, status reaches the shared edge", () => {
  const editor = new Editor({ prompt: "› " })
  editor.setText("hello")
  const box = new InputBox(editor, () => [
    { id: "right", text: "ready", priority: 1, align: "right", tone: "muted" },
  ])
  for (const width of [30, 60, 100]) {
    const rows = box.render(width, ctx).map(stripAnsi)
    expect(rows[1]).toBe(`│ › hello${" ".repeat(width - 10)}│`)
    expect(rows[1]!.indexOf("hello")).toBe(4)
    expect(rows.at(-2)).toBe(`╰${"─".repeat(width - 2)}╯`)
    expect(rows.at(-1)).toBe(`${" ".repeat(width - 5)}ready`)
    expect(rows.every((row) => visibleWidth(row) === width)).toBe(true)
  }
})

test("completed dialog echoes have an empty gutter, including cancellation and wrapped answers", () => {
  const request = { requestId: "echo", kind: "select" as const, title: "Model", options }
  expect(dialogEchoLines(request, undefined, defaultTheme, 60).map(stripAnsi)).toEqual([
    "  Model › cancelled",
  ])
  const rows = dialogEchoLines(request, "long answer ".repeat(6), defaultTheme, 20).map(stripAnsi)
  expect(rows.length).toBeGreaterThan(1)
  expect(rows.every((row) => row.startsWith("  ") && !row.includes("┃"))).toBe(true)
  expect(rows.every((row) => visibleWidth(row) <= 20)).toBe(true)
})
