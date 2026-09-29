import { expect, test } from "bun:test"
import { defaultTheme, Editor, key, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { InputBox } from "../src/input-box.ts"
import { type StatusEntry, statusBorder, statusLine } from "../src/status-bar.ts"

const entry = (
  id: string,
  text: string,
  priority: number,
  align: "left" | "right" = "right",
  tone: StatusEntry["tone"] = "muted",
): StatusEntry => ({ id, align, tone, priority, text })

/** The built-in items as the status extension gives them, and one of another extension's. */
const items = [
  entry("model", "deepseek-flash", 40, "left", "accent"),
  entry("context", "ctx 29.4k/128k (23%)", 30),
  entry("cost", "$0.042", 20),
  entry("place", "feat/status-bar*", 10),
  entry("mine", "custom", 0),
]

test("the status sits in the bottom border, left items after the corner, right ones before the other", () => {
  const line = statusBorder(items, 90, plain)
  expect(line).toBe(
    `╰─ deepseek-flash ${"─".repeat(11)} ctx 29.4k/128k (23%) · $0.042 · feat/status-bar* · custom ─╯`,
  )
  expect(visibleWidth(line)).toBe(90)
  // At least three rules keep the two sides apart.
  expect(statusBorder(items, 82, plain)).toContain("deepseek-flash ─── ctx")
})

test("as the border narrows, items go lowest priority first: other extensions', branch, cost, context", () => {
  const at = (width: number) => statusBorder(items, width, plain)
  for (let width = 6; width <= 90; width++) {
    const line = at(width)
    expect([width, visibleWidth(line)]).toEqual([width, width])
    expect(line.startsWith("╰─")).toBe(true)
    expect(line.endsWith("─╯")).toBe(true)
  }
  expect(at(81)).toBe(
    `╰─ deepseek-flash ${"─".repeat(11)} ctx 29.4k/128k (23%) · $0.042 · feat/status-bar* ─╯`,
  )
  expect(at(60)).toBe(`╰─ deepseek-flash ${"─".repeat(9)} ctx 29.4k/128k (23%) · $0.042 ─╯`)
  expect(at(45)).toBe(`╰─ deepseek-flash ${"─".repeat(3)} ctx 29.4k/128k (23%) ─╯`)
  expect(at(30)).toBe(`╰─ deepseek-flash ${"─".repeat(11)}╯`)
  // A lone item too wide is cut; the border keeps its corners.
  expect(at(12)).toBe("╰─ deep… ──╯")
  // With less room than a few characters, it is left out.
  expect(at(10)).toBe("╰────────╯")
  expect(at(7)).toBe("╰─────╯")
})

test("items of equal priority go from the last one", () => {
  const line = statusBorder(
    [entry("a", "aaaa", 0, "left"), entry("b", "bbbb", 0), entry("c", "cccc", 0)],
    20,
    plain,
  )
  expect(line).toBe("╰─ aaaa ──── bbbb ─╯")
})

test("the border and separators take the border and muted colors, items their tone", () => {
  const ctx = {
    ...plain,
    theme: { ...plain.theme, border: (s: string) => `<${s}>`, warning: (s: string) => `!${s}!` },
  }
  const line = statusBorder([entry("context", "ctx 90k/100k (90%)", 30, "right", "warning")], 30, ctx)
  expect(line).toBe(`<╰─><${"─".repeat(6)}> !ctx 90k/100k (90%)! <─╯>`)
  // Real colors: nothing but the texts and the border when stripped.
  const colored = statusBorder(items, 90, { ...plain, theme: defaultTheme, color: true })
  expect(stripAnsi(colored)).toBe(statusBorder(items, 90, plain))
})

test("without items the border is plain", () => {
  expect(statusBorder([], 10, plain)).toBe("╰────────╯")
})

test("as a line of its own, left items from the left edge and right ones against the right", () => {
  expect(statusLine(items.slice(0, 3), 60, plain)).toEqual([
    `deepseek-flash${" ".repeat(17)}ctx 29.4k/128k (23%) · $0.042`,
  ])
  expect(statusLine(items, 40, plain)).toEqual([`deepseek-flash${" ".repeat(6)}ctx 29.4k/128k (23%)`])
  expect(statusLine(items, 20, plain)).toEqual(["deepseek-flash"])
  expect(statusLine(items, 10, plain)).toEqual(["deepseek-…"])
  expect(statusLine([], 40, plain)).toEqual([])
  for (let width = 1; width <= 90; width++) {
    expect(visibleWidth(statusLine(items, width, plain)[0] ?? "")).toBeLessThanOrEqual(width)
  }
})

test("the input box draws the status in its border, next to the rows hidden below", () => {
  const editor = new Editor({ prompt: "› " })
  const box = new InputBox(editor, () => items.slice(0, 2))
  expect(box.render(50, plain).map(stripAnsi)).toEqual([
    `╭${"─".repeat(48)}╮`,
    `│ › ${" ".repeat(44)} │`,
    `╰─ deepseek-flash ${"─".repeat(8)} ctx 29.4k/128k (23%) ─╯`,
  ])
  editor.setText(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"))
  for (let i = 0; i < 12; i++) editor.handleInput(key("up"))
  const rows = box.render(50, { ...plain, rows: 9 })
  const bottom = rows.at(-1)!
  expect(visibleWidth(bottom)).toBe(50)
  // The count of hidden rows stays; the status gives way around it.
  expect(bottom).toMatch(/ ↓ \d+ more ─╯$/)
  expect(bottom.startsWith("╰─ deepseek-flash")).toBe(true)
  // Narrower, the hidden rows' count outlasts every status item.
  const narrow = box.render(16, { ...plain, rows: 9 }).at(-1)!
  expect(narrow).toMatch(/^╰─+ ↓ \d+ more ─╯$/)
  expect(visibleWidth(narrow)).toBe(16)
  // Too narrow for a border, the box is bare and so is the status.
  expect(box.render(7, plain).some((r) => r.includes("deepseek"))).toBe(false)
})

test("wide characters and emoji are measured by their cells", () => {
  const wide = [entry("model", "模型名", 40, "left", "accent"), entry("place", "分支🚀*", 10)]
  for (let width = 6; width <= 30; width++) {
    expect([width, visibleWidth(statusBorder(wide, width, plain))]).toEqual([width, width])
  }
  // 模型名 is six cells, 分支🚀* seven.
  expect(statusBorder(wide, 24, plain)).toBe("╰─ 模型名 ─── 分支🚀* ─╯")
  expect(statusBorder(wide, 20, plain)).toBe("╰─ 模型名 ─────────╯")
  // A wide character that would straddle the cut is left out, not split.
  expect(visibleWidth(statusBorder(wide, 12, plain))).toBe(12)
})

test("a lone item with room for fewer than a few characters is left out, not cut to a stub", () => {
  const lone = [entry("model", "deepseek-flash", 40, "left")]
  expect(statusBorder(lone, 11, plain)).toBe("╰─ dee… ──╯")
  expect(statusBorder(lone, 10, plain)).toBe("╰────────╯")
  expect(statusLine(lone, 4, plain)).toEqual(["dee…"])
  expect(statusLine(lone, 3, plain)).toEqual([])
})
