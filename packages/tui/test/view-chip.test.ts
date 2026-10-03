import { expect, test } from "bun:test"
import type { UiNode, ViewLine, ViewSegment } from "@amira/api"
import { defaultTheme, monoTheme, stripAnsi, type Theme, visibleWidth } from "@amira/tui-kit"
import { terminalText } from "../src/diff-view.ts"
import { ExtensionViewer } from "../src/extension-view.ts"
import { UiRuntime } from "../src/ui-runtime/runtime.ts"
import { renderViewLines, segmentText, viewTitle } from "../src/view-lines.ts"

const tones = ["neutral", "info", "success", "warning", "danger", "accent"] as const
const chip = (text: string): ViewSegment[] => [{ kind: "chip", text }]

for (const tone of tones) {
  test(`chip ${tone} uses its background color on the half-block ends`, () => {
    const output = segmentText([{ kind: "chip", text: "Ready", tone }], defaultTheme)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: verify host-owned chip color escapes
    const edge = output.match(/^\x1b\[38;5;(\d+)m▐\x1b\[39m/)
    expect(edge).not.toBeNull()
    expect(output).toContain(`\x1b[48;5;${edge![1]}m`)
    expect(output).toContain("Ready\x1b[39m\x1b[49m")
    expect(output).toEndWith(`\x1b[38;5;${edge![1]}m▌\x1b[39m`)
    expect(stripAnsi(output)).toBe("▐Ready▌")
    expect(visibleWidth(output)).toBe(7)
    expect(segmentText([{ kind: "chip", text: "Ready", tone }], monoTheme)).toBe("[Ready]")
  })
}

test("chips default to neutral and preserve adjacent segment styles", () => {
  const parts: ViewSegment[] = [
    { kind: "muted", text: "State: " },
    ...chip("Ready"),
    { kind: "success", text: " next" },
  ]
  expect(segmentText(chip("Ready"), defaultTheme)).toBe(
    segmentText([{ kind: "chip", text: "Ready", tone: "neutral" }], defaultTheme),
  )
  expect(segmentText(parts, defaultTheme)).toBe(
    defaultTheme.muted("State: ") + defaultTheme.chipNeutral!("Ready") + defaultTheme.success(" next"),
  )
  expect(stripAnsi(segmentText(parts, monoTheme))).toBe("State: [Ready] next")
  expect(
    new Set(tones.map((tone) => segmentText([{ kind: "chip", text: "x", tone }], defaultTheme))).size,
  ).toBe(6)
})

test("custom and older themes without chip tokens fall back to bracketed labels", () => {
  const plain = (text: string) => text
  const theme: Theme = {
    text: plain,
    muted: plain,
    accent: plain,
    success: plain,
    warning: plain,
    error: plain,
    border: plain,
  }
  for (const tone of tones) expect(segmentText([{ kind: "chip", text: "x", tone }], theme)).toBe("[x]")
  expect(segmentText(chip(""), theme)).toBe("[]")
  const custom = { ...theme, chipInfo: (text: string) => `<${text}>` }
  expect(segmentText([{ kind: "chip", text: "x", tone: "info" }], custom)).toBe("<x>")
})

test("chip text is sanitized before the host supplies styling", () => {
  const dirty = "gone\r\x1b[31mclean\b!\x1b[0m\tend\nrow\x1b]0;injected\x07"
  const clean = terminalText(dirty)
  expect(segmentText(chip(dirty), defaultTheme)).toBe(defaultTheme.chipNeutral!(clean))
  expect(segmentText(chip(dirty), monoTheme)).toBe(`[${clean}]`)
})

test("chips fit terminal cells in lines and titles, including wide and combining text", () => {
  for (const theme of [defaultTheme, monoTheme]) {
    for (const text of ["", "e\u0301", "你好", "👩‍💻", "a long chip label"]) {
      const line: ViewLine = { kind: "segments", parts: chip(text) }
      for (const width of [1, 2, 4, 8, 40]) {
        const rows = renderViewLines([line], theme, width)
        expect(rows).toHaveLength(1)
        expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(width)
        expect(viewTitle(line, theme, width)).toBe(rows[0]!)
      }
    }
  }
})

test("legacy view titles, headers, bodies and UI-error fallback all render chips", () => {
  const line: ViewLine = { kind: "segments", parts: chip("Ready") }
  for (const theme of [defaultTheme, monoTheme]) {
    const ctx = { theme, color: theme !== monoTheme, rows: 10 }
    const viewer = new ExtensionViewer(
      { kind: "chips", title: () => line, header: () => [line], render: () => [line] },
      {},
    )
    const rows = viewer.render(40, ctx)
    const expected = segmentText(line.parts, theme)
    for (const index of [0, 1, 3]) expect(rows[index]).toBe(expected)
    const failed = new ExtensionViewer(
      {
        kind: "chips",
        title: () => line,
        ui: () => {
          throw new Error("failed")
        },
      },
      {},
    )
    expect(failed.render(40, ctx)[0]).toBe(expected)
    viewer.dispose()
    failed.dispose()
  }
})

test("every declarative segment consumer retains chips with and without colors", () => {
  const line: ViewLine = { kind: "segments", parts: chip("Ready") }
  const nodes: UiNode[] = [
    { type: "box", title: line, child: { type: "spacer" } },
    { type: "text", lines: [line] },
    { type: "tree", id: "tree", items: [{ key: "x", row: chip("Ready") }] },
    { type: "tree", id: "tree", items: [{ key: "x", row: [], aside: chip("Ready") }] },
    { type: "tree", id: "tree", items: [{ key: "x", row: [], detail: [line] }] },
    { type: "tree", id: "tree", items: [{ key: "x", row: [], lead: chip("Ready") }] },
    {
      type: "tree",
      id: "tree",
      items: [{ key: "x", row: [], detail: { type: "bar", left: chip("Ready") } }],
    },
    {
      type: "table",
      columns: [{ key: "x", label: "Status" }],
      rows: [{ key: "x", cells: { x: chip("Ready") } }],
    },
    { type: "bar", left: chip("Ready") },
    { type: "bar", left: [], right: chip("Ready") },
  ]
  for (const theme of [defaultTheme, monoTheme]) {
    for (const node of nodes) {
      const runtime = new UiRuntime(() => {})
      runtime.setState({ expanded: { tree: ["x"] } })
      const rows = runtime.render(node, 40, 8, theme, (lines, width) => renderViewLines(lines, theme, width))
      expect(rows.map(stripAnsi).join("\n")).toContain(theme === monoTheme ? "[Ready]" : "▐Ready▌")
      expect(rows.every((row) => visibleWidth(row) <= 40)).toBe(true)
      runtime.dispose()
    }
  }
})
