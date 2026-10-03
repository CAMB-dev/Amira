import { expect, test } from "bun:test"
import type { UiNode, UiTreeItem, ViewSegment } from "@amira/api"
import {
  bold,
  defaultTheme,
  inverse,
  key,
  monoTheme,
  stripAnsi,
  type Theme,
  visibleWidth,
} from "@amira/tui-kit"
import { UiRuntime } from "../../src/ui-runtime/runtime.ts"
import { renderViewLines } from "../../src/view-lines.ts"

const parts = (text: string): ViewSegment[] => [{ kind: "text", text }]
const text = (value: string, id?: string): UiNode => ({
  type: "text",
  id,
  lines: [{ kind: "text", text: value }],
})
const tabs = (style?: "brackets" | "divided"): Extract<UiNode, { type: "tabs" }> => ({
  type: "tabs",
  id: "tabs",
  style,
  tabs: ["Summary", "Diff", "Logs", "Actions"].map((label) => ({
    key: label,
    label,
    body: text(`${label} body`, "body"),
  })),
})
function setup(node: UiNode, theme: Theme, width = 60, height = 8) {
  const runtime = new UiRuntime(() => {})
  const render = (w = width, h = height) =>
    runtime.render(node, w, h, theme, (lines, size) => renderViewLines(lines, theme, size))
  return { runtime, render }
}

for (const theme of [defaultTheme, monoTheme]) {
  const mode = theme === monoTheme ? "mono" : "color"
  test(`default and explicit bracket tabs retain their original strip in ${mode}`, () => {
    for (const style of [undefined, "brackets"] as const) {
      const s = setup(tabs(style), theme)
      s.runtime.setState({ activeTabs: { tabs: "Diff" }, focused: "body" })
      const lines = s.render()
      expect(stripAnsi(lines[0]!)).toBe("  Summary  [Diff]  Logs  Actions".padEnd(60))
      expect(lines[0]).toContain(theme.accent("[Diff]"))
      expect(stripAnsi(lines[1]!)).toStartWith("❯ Diff body")
      s.runtime.dispose()
    }
  })

  test(`divided tabs distinguish the active tab and keep the focus marker in ${mode}`, () => {
    const s = setup(tabs("divided"), theme)
    s.runtime.setState({ activeTabs: { tabs: "Diff" }, focused: "body" })
    const line = s.render()[0]!
    const selected = mode === "mono" ? "[Diff]" : "Diff"
    expect(stripAnsi(line)).toBe(`  Summary  │  ${selected}  │  Logs  │  Actions  `.padEnd(60))
    expect(line).toContain(mode === "mono" ? theme.accent("[Diff]") : bold(inverse(theme.accent("Diff"))))
    expect(line).toContain(theme.border("│"))
    s.runtime.focus("tabs")
    expect(stripAnsi(s.render()[0]!)).toStartWith("❯ Summary")
    s.runtime.handleInput(key("right"))
    expect(s.runtime.state.activeTabs.tabs).toBe("Logs")
    expect(stripAnsi(s.render()[1]!)).toContain("Logs body")
    s.runtime.dispose()
  })

  test(`divided tabs keep later active labels visible and clip sanitized text in ${mode}`, () => {
    const node = tabs("divided")
    node.tabs[0]!.label = "gone\r\x1b[31msafe\x1b[0m\x1b]0;injected\x07"
    const s = setup(node, theme)
    s.runtime.setState({ activeTabs: { tabs: "Actions" } })
    expect(stripAnsi(s.render(13)[0]!)).toContain(mode === "mono" ? "[Actions]" : "Actions")
    for (const width of [0, 1, 2, 4, 8, 13, 60]) {
      const lines = s.render(width)
      expect(lines).toHaveLength(width ? 8 : 0)
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true)
      expect(lines.map(stripAnsi).join("\n")).not.toContain("injected")
    }
    node.tabs.pop()
    expect(stripAnsi(s.render()[0]!)).toContain(mode === "mono" ? "[safe]" : "safe")
    expect(s.runtime.state.activeTabs.tabs).toBe("Summary")
    s.runtime.dispose()
  })

  test(`tree lead gaps normalize to cells without changing the default in ${mode}`, () => {
    for (const [gap, spaces] of [
      [undefined, 1],
      [0, 0],
      [1, 1],
      [2.7, 2],
      [-1, 0],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
    ] as const) {
      const s = setup(
        {
          type: "tree",
          id: "tree",
          items: [{ key: "row", lead: parts("界"), gap, node: parts("○"), row: parts("Row") }],
        },
        theme,
        20,
        1,
      )
      expect(stripAnsi(s.render()[0]!)).toBe(`❯ 界${" ".repeat(spaces)}○ Row`.padEnd(19))
      s.runtime.dispose()
    }
  })

  test(`mixed tree gaps share a lead column across child rails, details and underlines in ${mode}`, () => {
    const items: UiTreeItem[] = [
      {
        key: "parent",
        lead: parts("1234"),
        gap: 0,
        row: parts("Parent"),
        rail: true,
        detail: [{ kind: "text", text: "Parent detail" }],
        children: [
          {
            key: "child",
            row: parts("Child"),
            rail: true,
            underline: true,
            detail: { type: "bar", left: parts("Child detail") },
          },
        ],
      },
      { key: "last", lead: parts("界"), gap: 4, node: parts("○"), row: parts("Last") },
    ]
    const s = setup({ type: "tree", id: "tree", expanded: "all", items }, theme, 40)
    const lines = s.render().map(stripAnsi)
    expect(lines[0]).toBe("❯ 1234  ▾ Parent".padEnd(40))
    expect(lines[1]).toBe("        │ Parent detail".padEnd(40))
    expect(lines[2]).toBe("        └─▾ Child".padEnd(40))
    expect(lines[3]).toBe("          │ Child detail".padEnd(40))
    expect(lines[4]).toBe(`          │ ${"─".repeat(28)}`)
    expect(lines[5]).toBe("  界    ○ Last".padEnd(39))
    s.runtime.setState({ scroll: { tree: { top: 3, following: false } } })
    expect(
      s
        .render(40, 2)
        .map(stripAnsi)
        .map((line) => line.slice(2)),
    ).toEqual(lines.slice(3, 5).map((line) => line.slice(2)))
    s.runtime.dispose()
  })

  test(`large tree gaps stay bounded and lead segments stay sanitized in ${mode}`, () => {
    const s = setup(
      {
        type: "tree",
        id: "tree",
        expanded: "all",
        items: [
          {
            key: "row",
            lead: parts("gone\r\x1b[31msafe\x1b[0m\x1b]0;injected\x07"),
            gap: Number.MAX_VALUE,
            row: parts("Row"),
            rail: true,
            underline: true,
            detail: text("Detail"),
          },
        ],
      },
      theme,
    )
    expect(stripAnsi(s.render()[0]!)).toContain("safe")
    for (const width of [0, 1, 2, 4, 8, 20, 60]) {
      const lines = s.render(width)
      expect(lines).toHaveLength(width ? 8 : 0)
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true)
      expect(lines.map(stripAnsi).join("\n")).not.toContain("injected")
    }
    s.runtime.dispose()
  })
}
