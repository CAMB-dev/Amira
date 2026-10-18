import { expect, test } from "bun:test"
import { diffToolLines, type ToolCallView, type UiNode, type ViewDefinition } from "@amira/api"
import { CURSOR_MARKER, defaultTheme, stripAnsi, textKey, visibleWidth } from "@amira/tui-kit"
import ascii from "../../../cli/themes/ascii.json"
import { plain } from "../../../tui-kit/test/context.ts"
import { MAX_DIFF_LINE_ROWS } from "../../src/diff-view.ts"
import { ExtensionViewer } from "../../src/extension-view.ts"
import { glyphs, setGlyphs } from "../../src/glyphs.ts"
import { UiRuntime } from "../../src/ui-runtime/runtime.ts"
import { renderViewLines, segmentText } from "../../src/view-lines.ts"

/**
 * Every host-side cut in a declarative view: box title/aside, nested text segments, table
 * cells, list rows, tabs, chips and an input placeholder.
 */
const view: UiNode = {
  type: "column",
  children: [
    {
      node: {
        type: "box",
        title: "A very long box label that must be cut",
        aside: "aside too long",
        child: {
          type: "text",
          lines: [
            {
              kind: "segments",
              parts: [
                { kind: "text", text: "abcdefghijklmnop" },
                { kind: "chip", text: "TypeScript", tone: "info" },
              ],
            },
          ],
        },
      },
    },
    {
      node: {
        type: "table",
        columns: [{ key: "name", label: "Changed files" }],
        rows: [{ key: "one", cells: { name: "packages/api/src/events.ts" } }],
      },
    },
    {
      node: {
        type: "tree",
        id: "tree",
        items: [{ key: "x", row: [{ kind: "text", text: "A very long list item label" }] }],
      },
    },
    {
      node: {
        type: "tabs",
        id: "tabs",
        tabs: [
          { key: "a", label: "First long tab", body: { type: "spacer" } },
          { key: "b", label: "Second long tab", body: { type: "spacer" } },
        ],
      },
    },
    {
      node: {
        type: "bar",
        left: [
          { kind: "text", text: "State: " },
          { kind: "chip", text: "TypeScript", tone: "info" },
        ],
      },
    },
    { node: { type: "input", id: "input", placeholder: "Ask for a review with a long placeholder" } },
  ],
}

const context = { theme: defaultTheme, color: true, rows: 14 }

function render(width: number): string[] {
  return renderNode(view, width, 14)
}

function renderNode(node: UiNode, width: number, height: number): string[] {
  const runtime = new UiRuntime(() => {})
  try {
    return runtime.render(node, width, height, defaultTheme, (lines, w) =>
      renderViewLines(lines, defaultTheme, w),
    )
  } finally {
    runtime.dispose()
  }
}

/** The Unicode frames pinned in full, styling and padding included; they must never change. */
const UNICODE_12 = [
  "\u001b[90m╭\u001b[39m\u001b[90m\u001b[39m aside to…\u001b[90m╮\u001b[39m\u001b[0m",
  "\u001b[90m│\u001b[39mabcdefghi…\u001b[90m│\u001b[39m\u001b[0m",
  "\u001b[90m╰──────────╯\u001b[39m\u001b[0m",
  "\u001b[90mChanged fil…\u001b[39m\u001b[0m",
  "packages/ap…",
  "            ",
  "\u001b[7m›   A very …\u001b[27m\u001b[0m",
  "            ",
  "  \u001b[36m[First lo…\u001b[0m",
  "            ",
  "State: \u001b[38;5;24m▐\u001b[39m\u001b[48;5;24m\u001b[38;5;231mTyp…\u001b[0m",
  "            ",
  "  \u001b[90mAsk for…\u001b[39m\u001b[0m \u001b[0m \u001b[0m",
  "            ",
]

const UNICODE_24 = [
  "\u001b[90m╭\u001b[39m A ve…\u001b[90m\u001b[39m aside too long \u001b[90m╮\u001b[39m\u001b[0m",
  "\u001b[90m│\u001b[39mabcdefghijklmnop\u001b[38;5;24m▐\u001b[39m\u001b[48;5;24m\u001b[38;5;231mType…\u001b[0m\u001b[90m│\u001b[39m\u001b[0m",
  "\u001b[90m╰──────────────────────╯\u001b[39m\u001b[0m",
  "\u001b[90mChanged files           \u001b[39m\u001b[0m",
  "packages/api/src/events…",
  "                        ",
  "\u001b[7m›   A very long list it…\u001b[27m\u001b[0m",
  "                        ",
  "  \u001b[36m[First long tab]\u001b[39m  \u001b[90mSec…\u001b[0m",
  "                        ",
  "State: \u001b[38;5;24m▐\u001b[39m\u001b[48;5;24m\u001b[38;5;231mTypeScript\u001b[39m\u001b[49m\u001b[38;5;24m▌\u001b[39m\u001b[0m     \u001b[0m",
  "                        ",
  "  \u001b[90mAsk for a review wi…\u001b[39m\u001b[0m \u001b[0m \u001b[0m",
  "                        ",
]

for (const [width, expected] of [
  [12, UNICODE_12],
  [24, UNICODE_24],
] as const) {
  test(`Unicode declarative view rendering is byte-identical at width ${width}`, () => {
    const before = { ...glyphs }
    try {
      setGlyphs()
      expect(render(width)).toEqual(expected)
    } finally {
      setGlyphs(before)
    }
  })
}

test("ASCII declarative views cut labels, list rows, table cells, nested text and tabs in ASCII", () => {
  const before = { ...glyphs }
  try {
    setGlyphs(ascii.glyphs)
    for (const width of [8, 12, 24, 40]) {
      const rows = render(width)
      expect(rows.join("\n")).not.toMatch(/[^\p{ASCII}]/u)
      expect(rows.every((row) => visibleWidth(row) === width)).toBe(true)
    }
    const narrow = render(12).map((row) => stripAnsi(row).trimEnd())
    expect(narrow[1]).toBe("|abcdefg...|")
    expect(narrow[3]).toBe("Changed f...")
    expect(narrow[4]).toBe("packages/...")
    expect(narrow[6]).toBe(">   A ver...")
    expect(narrow[12]).toBe("  Ask f...")

    const wide = render(24)
    const plain = wide.map((row) => stripAnsi(row).trimEnd())
    expect(plain[1]).toBe("|abcdefghijklmnop[Ty...|")
    expect(plain[4]).toBe("packages/api/src/even...")
    expect(plain[6]).toBe(">   A very long list ...")
    expect(plain[8]).toBe("  [First long tab]  S...")
    expect(plain[10]).toBe("State: [TypeScript]")
    expect(plain[12]).toBe("  Ask for a review ...")
    // ASCII changes the ends, not the tone: the label is still styled.
    expect(wide[10]).toContain("\u001b[")
    expect(wide.join("\n")).not.toContain("▐")
    expect(wide.join("\n")).not.toContain("▏")
  } finally {
    setGlyphs(before)
  }
})

test("ASCII chips keep their tone colors and stay distinguishable", () => {
  const before = { ...glyphs }
  try {
    setGlyphs(ascii.glyphs)
    const tones = ["neutral", "info", "success", "warning", "danger", "accent"] as const
    const styled = tones.map((tone) => segmentText([{ kind: "chip", text: "Status", tone }], defaultTheme))
    expect(new Set(styled).size).toBe(tones.length)
    expect(styled.every((text) => stripAnsi(text) === "[Status]")).toBe(true)
    expect(styled.join("")).toContain("\u001b[")
    expect(styled.join("")).not.toMatch(/[^\p{ASCII}]/u)
  } finally {
    setGlyphs(before)
  }
})

/** A narrow fullscreen prompt, whose label and empty-input placeholder both cut. */
function promptFrame(): string[] {
  const definition: ViewDefinition = {
    kind: "prompt-proof",
    title: () => "Prompt",
    keys: [{ key: "p", label: "" }],
    ui: () => ({ type: "text", lines: [{ kind: "text", text: "Body" }] }),
    onEvent(event, _data, view) {
      if (event.type === "key") void view.prompt("Message:")
    },
  }
  const viewer = new ExtensionViewer(definition, {})
  try {
    viewer.render(16, { ...context, rows: 8 })
    viewer.handleInput(textKey("p"))
    return viewer.render(16, { ...context, rows: 8 })
  } finally {
    viewer.dispose()
  }
}

test("ASCII view prompts cut their title and empty placeholder with three periods", () => {
  const before = { ...glyphs }
  try {
    setGlyphs(ascii.glyphs)
    const rows = promptFrame()
    expect(rows.join("\n")).not.toMatch(/[^\p{ASCII}]/u)
    const footer = stripAnsi(rows.at(-1)!).replace(CURSOR_MARKER, "")
    expect(footer).toBe("  Mess...ent...")
  } finally {
    setGlyphs(before)
  }
})

test("Unicode view prompts keep their raw styling and ellipses", () => {
  const before = { ...glyphs }
  try {
    setGlyphs()
    const footer = promptFrame().at(-1)!
    expect(footer).toBe(`  \u001b[36mMessag…\u001b[39m${CURSOR_MARKER}\u001b[90menter…\u001b[39m`)
  } finally {
    setGlyphs(before)
  }
})

test("ASCII view hints cut with three periods and keep their exact width", () => {
  const before = { ...glyphs }
  const definition: ViewDefinition = {
    kind: "hint-proof",
    title: () => "Hints",
    ui: () => ({ type: "text", lines: [] }),
  }
  const viewer = new ExtensionViewer(definition, {})
  try {
    setGlyphs(ascii.glyphs)
    for (const focused of [false, true]) {
      viewer.focused = focused
      const hint = viewer.focusHint(plain.theme, 8)
      expect(hint).not.toMatch(/[^\p{ASCII}]/u)
      expect(hint).toBe("tab r...")
      expect(visibleWidth(hint)).toBe(8)
    }

    // The same cuts in Unicode mode are byte-identical to the rows the view drew before.
    setGlyphs()
    for (const focused of [false, true]) {
      viewer.focused = focused
      expect(viewer.focusHint(plain.theme, 8)).toBe(focused ? "tab → i…" : "tab → v…")
    }
  } finally {
    viewer.dispose()
    setGlyphs(before)
  }
})

/**
 * A custom non-ASCII `more` marker belongs to text cuts that already used it (view segments);
 * chrome that drew a literal "…" (or LineInput's default) keeps it, as it did before.
 */
test("custom non-ASCII markers leave literal-ellipsis view chrome byte-identical", () => {
  const before = { ...glyphs }
  try {
    setGlyphs({ more: "~" })
    const twelve = render(12)
    const twentyFour = render(24)
    expect(twelve).toEqual(UNICODE_12.map((row, i) => (i === 1 ? row.replace("…", "~") : row)))
    expect(twentyFour).toEqual(UNICODE_24.map((row, i) => (i === 1 ? row.replace("…", "~") : row)))
    const footer = promptFrame().at(-1)!
    expect(footer).toBe(`  \u001b[36mMessag~\u001b[39m${CURSOR_MARKER}\u001b[90menter…\u001b[39m`)
  } finally {
    setGlyphs(before)
  }
})

test("ASCII wrapped view diffs reserve all three cells of their ellipsis", () => {
  const before = { ...glyphs }
  try {
    setGlyphs(ascii.glyphs)
    const line = { kind: "diff-add", text: "x".repeat(100) } as const
    const rows = renderViewLines([line], defaultTheme, 10)
    expect(rows).toHaveLength(MAX_DIFF_LINE_ROWS)
    expect(rows.every((row) => visibleWidth(row) === 10)).toBe(true)
    expect(stripAnsi(rows.at(-1)!)).toBe("  xxxxx...")
  } finally {
    setGlyphs(before)
  }
})

/** A view whose only rows are the two hunks the public helper builds, with its own gap line. */
const hunks: UiNode = {
  type: "text",
  lines: diffToolLines([
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
    { oldStart: 20, oldLines: 1, newStart: 20, newLines: 1, lines: ["-past", "+next"] },
  ]),
}

test("ASCII views draw their own hunk gap inside the number column", () => {
  const before = { ...glyphs }
  try {
    setGlyphs(ascii.glyphs)
    for (const width of [10, 24]) {
      const rows = renderNode(hunks, width, 8)
      expect(rows.join("\n")).not.toMatch(/[^\p{ASCII}]/u)
      expect(rows.every((row) => visibleWidth(row) === width)).toBe(true)
    }
    expect(
      renderNode(hunks, 24, 8)
        .map((row) => stripAnsi(row).trimEnd())
        .slice(0, 5),
    ).toEqual([" 1 - old", " 1 + new", "...", "20 - past", "20 + next"])
  } finally {
    setGlyphs(before)
  }
})

test("Unicode view hunk gaps keep the glyph diffToolLines writes", () => {
  const before = { ...glyphs }
  try {
    setGlyphs()
    expect(renderNode(hunks, 24, 8).map((row) => stripAnsi(row).trimEnd())[2]).toBe(" ⋯")
  } finally {
    setGlyphs(before)
  }
})

const toolResult = { content: [{ type: "text" as const, text: "ok" }] }
const bodyDiff = diffToolLines([
  { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
  { oldStart: 20, oldLines: 1, newStart: 20, newLines: 1, lines: ["-past", "+next"] },
])

/** A call without a presenter, and one whose presenter body is a two-hunk diff. */
const toolView: ViewDefinition = {
  kind: "tool-proof",
  title: () => "Tools",
  ui: (_data, ctx) => ({
    type: "text",
    lines: [
      ...ctx.renderTool!(
        "read",
        { args: { path: "src/a.ts", limit: 20 }, result: toolResult, text: "ok" },
        "summary",
      ),
      ...ctx.renderTool!("diff", { args: {}, result: toolResult, text: "ok" }, "full"),
    ],
  }),
}

function toolRows(): string[] {
  const presenters = { get: (name: string) => (name === "diff" ? { body: () => bodyDiff } : undefined) }
  const viewer = new ExtensionViewer(toolView, {}, { presenters })
  try {
    return viewer.render(60, { ...context, rows: 12 })
  } finally {
    viewer.dispose()
  }
}

test("ASCII views separate host-composed tool labels with an ASCII separator", () => {
  const before = { ...glyphs }
  try {
    setGlyphs(ascii.glyphs)
    const rows = toolRows()
    expect(rows.join("\n")).not.toMatch(/[^\p{ASCII}]/u)
    expect(rows.every((row) => visibleWidth(row) <= 60)).toBe(true)
    const plain = rows.map((row) => stripAnsi(row)).join("\n")
    expect(plain).toContain("src/a.ts . limit=20")
    expect(plain).toContain("...")
  } finally {
    setGlyphs(before)
  }
})

test("Unicode views keep the middle dot in host-composed tool labels", () => {
  const before = { ...glyphs }
  try {
    setGlyphs()
    expect(
      toolRows()
        .map((row) => stripAnsi(row))
        .join("\n"),
    ).toContain("src/a.ts · limit=20")
  } finally {
    setGlyphs(before)
  }
})

/** A batched call no presenter knows, so its summary is host-composed. */
const batchCall: ToolCallView = {
  args: { path: "src/a.ts", limit: 20 },
  result: { content: [{ type: "text", text: "ok" }] },
  text: "ok",
}

function viewRows(definition: ViewDefinition, width: number, height = 6): string[] {
  const viewer = new ExtensionViewer(definition, {}, { now: () => 500 })
  try {
    return viewer.render(width, { ...context, rows: height })
  } finally {
    viewer.dispose()
  }
}

test("ASCII views separate batched non-exploration tool labels with an ASCII separator", () => {
  const before = { ...glyphs }
  try {
    setGlyphs(ascii.glyphs)
    const definition: ViewDefinition = {
      kind: "batch-proof",
      title: () => "Batched",
      ui: (_data, ctx) => ({
        type: "text",
        lines: ctx.renderTools!([{ name: "other", call: batchCall }], "summary"),
      }),
    }
    const rows = viewRows(definition, 60)
    expect(rows.join("\n")).not.toMatch(/[^\p{ASCII}]/u)
    expect(rows.map((row) => stripAnsi(row)).join("\n")).toContain("|-other src/a.ts . limit=20")
    expect(rows.every((row) => visibleWidth(row) <= 60)).toBe(true)
  } finally {
    setGlyphs(before)
  }
})

test("Unicode views keep the middle dot in batched non-exploration tool labels", () => {
  const before = { ...glyphs }
  try {
    setGlyphs()
    const definition: ViewDefinition = {
      kind: "batch-proof",
      title: () => "Batched",
      ui: (_data, ctx) => ({
        type: "text",
        lines: ctx.renderTools!([{ name: "other", call: batchCall }], "summary"),
      }),
    }
    expect(
      viewRows(definition, 60)
        .map((row) => stripAnsi(row))
        .join("\n"),
    ).toContain("├ other src/a.ts · limit=20")
  } finally {
    setGlyphs(before)
  }
})

test("ASCII views draw running tools with ASCII spinner frames and cuts", () => {
  const before = { ...glyphs }
  try {
    setGlyphs(ascii.glyphs)
    const definition: ViewDefinition = {
      kind: "running-proof",
      title: () => "Running",
      ui: (_data, ctx) => ({
        type: "text",
        lines: ctx.renderRunningTool!("other", {
          args: { path: "run" },
          startedAt: 0,
          partial: { content: [{ type: "text", text: "x".repeat(40) }] },
        }),
      }),
    }
    const rows = viewRows(definition, 24, 4)
    expect(rows.join("\n")).not.toMatch(/[^\p{ASCII}]/u)
    const live = rows.find((row) => stripAnsi(row).includes("xxx"))
    expect(live).toBeDefined()
    expect(stripAnsi(live!)).toBe(`| ${"x".repeat(19)}...`)
    expect(visibleWidth(live!)).toBe(24)
  } finally {
    setGlyphs(before)
  }
})

test("ASCII views end cut tool heads with three periods", () => {
  const before = { ...glyphs }
  try {
    setGlyphs(ascii.glyphs)
    const definition: ViewDefinition = {
      kind: "head-proof",
      title: () => "Head",
      ui: (_data, ctx) => ({
        type: "text",
        lines: ctx.renderTool!(
          "other",
          { args: { path: "abcdefghijklmnop" }, result: batchCall.result, text: "ok" },
          "summary",
        ),
      }),
    }
    const rows = viewRows(definition, 12)
    expect(rows.join("\n")).not.toMatch(/[^\p{ASCII}]/u)
    expect(stripAnsi(rows[0]!)).toBe("|-other a...")
    expect(visibleWidth(rows[0]!)).toBe(12)
  } finally {
    setGlyphs(before)
  }
})

test("ASCII views keep a numbered row's marker when the gutter is too wide", () => {
  const before = { ...glyphs }
  try {
    setGlyphs(ascii.glyphs)
    const numbered: UiNode = {
      type: "text",
      lines: [{ kind: "diff-add", lineNo: 123, text: "abcdef" }],
    }
    const rows = renderNode(numbered, 6, 4)
    expect(rows.join("\n")).not.toMatch(/[^\p{ASCII}]/u)
    expect(stripAnsi(rows[0]!)).toBe("123...")
    expect(visibleWidth(rows[0]!)).toBe(6)
  } finally {
    setGlyphs(before)
  }
})

test("Unicode views keep the ordinary tool cuts and numbered gutter", () => {
  const before = { ...glyphs }
  try {
    setGlyphs()
    const numbered: UiNode = {
      type: "text",
      lines: [{ kind: "diff-add", lineNo: 123, text: "abcdef" }],
    }
    const rows = renderNode(numbered, 6, 4)
    expect(stripAnsi(rows[0]!)).toBe("123 +…")
    expect(visibleWidth(rows[0]!)).toBe(6)
  } finally {
    setGlyphs(before)
  }
})

test("ASCII views keep a note's marker beside a numbered diff", () => {
  const before = { ...glyphs }
  try {
    setGlyphs(ascii.glyphs)
    const mixed: UiNode = {
      type: "text",
      lines: [
        { kind: "diff-add", lineNo: 123, text: "abcdef" },
        { kind: "muted", text: "additional explanation" },
      ],
    }
    const rows = renderNode(mixed, 8, 4)
    expect(rows.join("\n")).not.toMatch(/[^\p{ASCII}]/u)
    expect(stripAnsi(rows[1]!)).toBe("     ...")
    expect(visibleWidth(rows[1]!)).toBe(8)
  } finally {
    setGlyphs(before)
  }
})

test("Unicode views keep the historical numbered-diff note row", () => {
  const before = { ...glyphs }
  try {
    setGlyphs()
    const mixed: UiNode = {
      type: "text",
      lines: [
        { kind: "diff-add", lineNo: 123, text: "abcdef" },
        { kind: "muted", text: "additional explanation" },
      ],
    }
    expect(stripAnsi(renderNode(mixed, 8, 4)[1]!)).toBe("      a…")
  } finally {
    setGlyphs(before)
  }
})

/** Two successful reads fold into the one count-only exploration row. */
function explorationView(calls: number): ViewDefinition {
  const read = (path: string) => ({
    name: "read",
    call: {
      args: { path },
      result: { content: [{ type: "text" as const, text: "ok" }] },
      text: "ok",
    },
  })
  return {
    kind: "explore-proof",
    title: () => "Explore",
    ui: (_data, ctx) => ({
      type: "text",
      lines: ctx.renderTools!(
        Array.from({ length: calls }, () => read("a.ts")),
        "summary",
      ),
    }),
  }
}

test("ASCII views cut a folded exploration row with three periods", () => {
  const before = { ...glyphs }
  try {
    setGlyphs(ascii.glyphs)
    const rows = viewRows(explorationView(2), 12)
    expect(rows.join("\n")).not.toMatch(/[^\p{ASCII}]/u)
    expect(stripAnsi(rows[0]!)).toBe("|-Read...  >")
    expect(visibleWidth(rows[0]!)).toBe(12)
  } finally {
    setGlyphs(before)
  }
})

const noteText = "ok\n[... 10 lines (100 characters) omitted: lines 2-11 ...]"

/** A call no presenter knows, whose full-detail body holds a generic preview note. */
function noteView(): ViewDefinition {
  return {
    kind: "note-proof",
    title: () => "Notes",
    ui: (_data, ctx) => ({
      type: "text",
      lines: ctx.renderTool!(
        "other",
        {
          args: {},
          result: { content: [{ type: "text", text: noteText }] },
          text: noteText,
        },
        "full",
      ),
    }),
  }
}

test("ASCII views draw generic preview notes with ASCII decorations", () => {
  const before = { ...glyphs }
  try {
    setGlyphs(ascii.glyphs)
    const rows = viewRows(noteView(), 80, 8)
    expect(rows.join("\n")).not.toMatch(/[^\p{ASCII}]/u)
    const note = rows.find((row) => stripAnsi(row).includes("lines omitted"))
    expect(stripAnsi(note!)).toBe("| ... 10 lines omitted (2-11)".padEnd(80))
    expect(visibleWidth(note!)).toBe(80)
  } finally {
    setGlyphs(before)
  }
})

test("Unicode views keep the API's preview-note decorations", () => {
  const before = { ...glyphs }
  try {
    setGlyphs()
    const note = viewRows(noteView(), 80, 8).find((row) => stripAnsi(row).includes("lines omitted"))
    expect(stripAnsi(note!)).toBe("│ … 10 lines omitted (2–11)".padEnd(80))
  } finally {
    setGlyphs(before)
  }
})
