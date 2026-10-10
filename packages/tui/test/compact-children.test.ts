import { expect, test } from "bun:test"
import { textResult } from "@amira/api"
import { monoTheme, stripAnsi, visibleWidth } from "@amira/tui-kit"
import type { BlockEnv } from "../src/blocks/base.ts"
import { ToolBlock } from "../src/blocks/tool.ts"
import { treeLayout } from "../src/format.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"
import { nodeRows, type SubagentNode, treeRows } from "../src/subagents.ts"

const child = (id: string, parent = "main", depth = 1): SubagentNode => ({
  id,
  parent,
  toolCallId: "call",
  title: id,
  role: "explorer",
  depth,
  tokens: 4100,
  startedAt: 0,
  lastText: "```ts\nexport function result() {}\n```\n**RESULT TEXT MUST NOT APPEAR**",
  end: { status: "done", durationMs: 6000, tokens: 4100 },
})
const env: BlockEnv = {
  theme: monoTheme,
  width: 100,
  now: 6000,
  spinner: "*",
  detail: "summary",
  hyperlinks: false,
  presenters: undefined,
  nodes: new Map(),
}

test("only and last children close their own level, including the legacy open-top path", () => {
  expect(treeLayout([{ depth: 1 }], false)).toEqual([{ indent: "  ", last: true }])
  const nodes = [child("first"), child("nested", "first", 2), child("last")]
  expect(treeLayout(nodes, false).map(({ last }) => last)).toEqual([false, true, true])
  const rows = treeRows(nodes, 6000, 100, monoTheme, undefined, false).map(stripAnsi)
  expect(rows[0]).toStartWith("  ├ ✓ first")
  expect(rows[1]).toStartWith("  │ └ ✓ nested")
  expect(rows[2]).toStartWith("  └ ✓ last")
})

test("tool children use closing arms with compact heads and expanded continuation results", () => {
  const block = new ToolBlock("call", "agent", {}, "main")
  block.end = { result: textResult("one\ntwo\nthree") }
  const only = child("only")
  for (const detail of ["collapsed", "summary", "full"] as const) {
    const current = { ...env, detail, nodes: new Map([[only.id, only]]) }
    const rows = block.lines(current).map(stripAnsi)
    expect(rows[1]).toStartWith("  │  └ ✓ only")
    expect(rows.join("\n")).not.toContain("export function")
    expect(rows.join("\n")).not.toContain("```")
    expect(rows.join("\n")).not.toContain("RESULT TEXT")
    expect(rows.join("\n")).toContain("one")
    expect(rows.every((row) => visibleWidth(row) <= 100)).toBe(true)
  }
  block.folding = "collapsed"
  expect(block.lines({ ...env, nodes: new Map([[only.id, only]]) }).map(stripAnsi)[1]).toBe(
    "  │  └ ✓ 1 sub-agent",
  )
})

test("compact finished rows omit all result text without discarding the node's details", () => {
  for (const status of ["done", "error", "aborted"] as const) {
    const node = child("Scan")
    node.end = { status, error: "ERROR DETAILS", note: "STOP DETAILS", durationMs: 6000, tokens: 4100 }
    const mark = status === "done" ? "✓" : status === "error" ? "✗" : "⊘"
    const rows = nodeRows(node, 6000, 100, monoTheme).map(stripAnsi)
    expect(rows).toEqual([`  └ ${mark} Scan · explorer · 6.0s · 4.1k tok`])
    expect(node.lastText).toBe("```ts\nexport function result() {}\n```\n**RESULT TEXT MUST NOT APPEAR**")
    expect(node.end.error).toBe("ERROR DETAILS")
    expect(node.end.note).toBe("STOP DETAILS")
    node.title = "A much longer task title"
    const narrow = nodeRows(node, 6000, 44, monoTheme).map(stripAnsi)
    expect(narrow[0]).toEndWith("· explorer · 6.0s · 4.1k tok")
  }
})

test("last child closure and compact stats also respect ASCII arms and measured widths", () => {
  const before = { ...glyphs }
  try {
    setGlyphs({ treeBranch: "|-", treeLast: "`-", treePipe: "|" })
    const nodes = [child("first"), child("last")]
    const rows = treeRows(nodes, 6000, 100, monoTheme, undefined, false).map(stripAnsi)
    expect(rows[0]).toStartWith("  |- ✓ first")
    expect(rows[1]).toStartWith("  `- ✓ last")
    for (const width of [1, 3, 12, 35, 100]) {
      expect(treeRows(nodes, 6000, width, monoTheme).every((row) => visibleWidth(row) <= width)).toBe(true)
    }
  } finally {
    setGlyphs(before)
  }
})
