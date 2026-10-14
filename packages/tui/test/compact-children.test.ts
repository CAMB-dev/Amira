// A/C/D style oracles: root markers at 0, content at 2, logical two-cell child rails and muted chrome.
import { expect, test } from "bun:test"
import { createAi, createMockDialect, emptyUsage } from "@amira/ai"
import { type SpawnGroupInfo, textResult } from "@amira/api"
import { Agent, AgentTree, EventBus } from "@amira/core"
import { defaultTheme, monoTheme, stripAnsi, visibleWidth } from "@amira/tui-kit"
import type { BlockEnv } from "../src/blocks/base.ts"
import { SubagentGroupBlock } from "../src/blocks/subagent-group.ts"
import { ToolBlock } from "../src/blocks/tool.ts"
import { spawnGroupRow, treeLayout } from "../src/format.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"
import { nodeRows, type SubagentNode, subagentCounts, treeRows } from "../src/subagents.ts"

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
for (const state of ["working", "queued"] as const) {
  test(`a compact owner's progress hint cannot hide ${state} presentation`, () => {
    const group: SpawnGroupInfo = {
      id: "workflow",
      name: "workflow",
      parentSessionId: "main",
      state: "active",
      limits: {},
      compact: true,
      status: "Explore",
      usage: emptyUsage(),
      tokens: 0,
      agents: {
        total: 1,
        working: state === "working" ? 1 : 0,
        queued: state === "queued" ? 1 : 0,
        idle: 0,
        ended: 0,
      },
    }
    expect(stripAnsi(spawnGroupRow(group, 1, 100, defaultTheme))).toContain(`1 ${state}`)
  })
}

test("compact groups never turn failed, stopped or idle-only members into done", () => {
  const group: SpawnGroupInfo = {
    id: "workflow",
    name: "workflow",
    parentSessionId: "main",
    state: "active",
    limits: {},
    compact: true,
    usage: emptyUsage(),
    tokens: 0,
    agents: { total: 1, ended: 1, working: 0, queued: 0, idle: 0 },
  }
  const node = { ...child("member"), groupId: group.id }
  for (const status of ["error", "aborted"] as const) {
    node.end = { status, durationMs: 0, tokens: 0 }
    const rows = treeRows([node], 0, 100, monoTheme, new Map([[group.id, group]])).map(stripAnsi)
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toContain("✓")
    expect(rows[0]).toContain(status === "error" ? "1 failed" : "1 stopped")
    expect(rows[0]).not.toContain("1/1 done")
  }
})

test("compact idle-only groups are not successful completions", () => {
  const group: SpawnGroupInfo = {
    id: "workflow",
    name: "workflow",
    parentSessionId: "main",
    state: "active",
    limits: {},
    compact: true,
    usage: emptyUsage(),
    tokens: 0,
    agents: { total: 1, ended: 0, working: 0, queued: 0, idle: 1 },
  }
  const node: SubagentNode = { ...child("member"), groupId: group.id }
  delete node.end
  node.idle = true
  group.agents = { total: 1, ended: 0, working: 0, queued: 0, idle: 1 }
  const rows = treeRows([node], 0, 100, monoTheme, new Map([[group.id, group]])).map(stripAnsi)
  expect(rows[0]).not.toContain("✓")
  expect(rows[0]).toContain("1 idle")
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

for (const state of ["failed", "stopped", "mixed", "idle", "paused"] as const) {
  test(`explicitly collapsed owning tool preserves ${state} children`, () => {
    const block = new ToolBlock("call", "agent", {}, "main")
    block.end = { result: textResult("started in the background") }
    block.folding = "collapsed"
    const node = child("member")
    if (state === "failed" || state === "mixed") node.end!.status = "error"
    else if (state === "stopped") node.end!.note = ""
    else {
      delete node.end
      node.idle = state === "idle"
      node.paused = state === "paused"
    }
    const nodes = state === "mixed" ? [node, child("done")] : [node]
    const rows = block.lines({ ...env, theme: defaultTheme, nodes: new Map(nodes.map((n) => [n.id, n])) })
    const summary = rows[1]!
    expect(stripAnsi(summary)).toContain(state === "mixed" ? "1 failed" : `1 ${state}`)
    expect(summary).not.toContain(defaultTheme.success(glyphs.subagentDone))
    expect(summary).not.toContain(defaultTheme.accent(env.spinner))
    if (state === "paused") expect(summary).toContain(defaultTheme.warning(glyphs.statusPaused))
    expect(visibleWidth(summary)).toBeLessThanOrEqual(env.width)
  })
}

test("a core-backed paused compact group publishes a static paused row rather than working", async () => {
  const mock = createMockDialect()
  mock.push({ text: "complete", delayMs: 1000 })
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const bus = new EventBus()
  const tree = new AgentTree({ ai, maxConcurrent: 1, sections: () => [] })
  const root = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: process.cwd(),
    systemPrompt: "root",
    bus,
    tree,
  })
  const group = tree.createGroup(root, { name: "paused workflow", compact: true, maxConcurrent: 1 })
  const node = group.spawn({ prompt: "work" })
  const queued = group.spawn({ prompt: "wait" })
  try {
    while (!tree.subagent(node.id)?.info.startedAt) await Bun.sleep(2)
    expect(tree.pause(node.id)).toBe(true)
    const snapshot = group.info()
    expect(node.state).toBe("working") // Admission slot remains occupied.
    expect(queued.state).toBe("queued")
    expect(snapshot.agents).toMatchObject({ paused: 1, working: 0, queued: 1 })
    const rows = treeRows(
      [{ ...child(node.id), groupId: group.id }],
      0,
      100,
      defaultTheme,
      new Map([[group.id, snapshot]]),
    )
    expect(stripAnsi(rows[0]!)).toContain("1 paused")
    expect(stripAnsi(rows[0]!)).not.toContain("1 working")
    expect(rows[0]).toContain(defaultTheme.warning(glyphs.statusPaused))
    expect(rows[0]).not.toContain(defaultTheme.accent("⠋"))
  } finally {
    group.end()
    await Promise.all([node.result(), queued.result()])
    await root.dispose("exit")
  }
})

test("compact group roots and counts retain outcomes after finished background nodes disappear", () => {
  const survivor = { ...child("survivor"), groupId: "workflow" }
  const group: SpawnGroupInfo = {
    id: "workflow",
    name: "workflow",
    parentSessionId: "main",
    state: "ended",
    limits: {},
    compact: true,
    usage: emptyUsage(),
    tokens: 0,
    agents: { total: 4, ended: 4, working: 0, queued: 0, idle: 0 },
    outcomes: { done: 3, failed: 1, stopped: 0 },
  }
  const current = {
    ...env,
    nodes: new Map([[survivor.id, survivor]]),
    groups: new Map([[group.id, group]]),
  }
  const block = new SubagentGroupBlock(survivor.id)
  block.last = true
  const rows = block.lines(current).map(stripAnsi)
  expect(rows).toHaveLength(2)
  expect(rows[0]).toBe("└ ○ in the background")
  expect(rows[1]).toBe("  └ ○ workflow · 3/4 done · 1 failed · 0 tok")
  const owningTool = new ToolBlock("call", "agent", {}, "main")
  owningTool.end = { result: textResult("done") }
  owningTool.folding = "collapsed"
  const collapsed = owningTool.lines(current).map(stripAnsi)[1]!
  expect(collapsed).toContain("4 sub-agents · 3 done · 1 failed")
  group.status = "Verify complete"
  expect(block.lines(current).map(stripAnsi)[1]).toContain("3/4 done · 1 failed")
  expect(block.lines(current).map(stripAnsi)[1]).toContain("Verify complete")
  for (const width of [20, 35, 100]) {
    const narrow = block.lines({ ...current, width }).map(stripAnsi)
    expect(narrow).toHaveLength(2)
    expect(narrow[1]).toContain("○ workflow")
    expect(narrow.every((row) => visibleWidth(row) <= width)).toBe(true)
  }
  group.outcomes = { done: 0, failed: 4, stopped: 0 }
  expect(block.lines(current).map(stripAnsi)[0]).toBe("└ ✗ in the background")
  group.outcomes = { done: 0, failed: 0, stopped: 4 }
  expect(block.lines(current).map(stripAnsi)[0]).toBe("└ ‖ in the background")
  expect(block.lines({ ...current, theme: defaultTheme })[0]).toContain(defaultTheme.warning("‖"))
  delete survivor.end
  survivor.idle = true
  group.agents = { total: 1, ended: 0, working: 0, queued: 0, idle: 1 }
  group.outcomes = { done: 0, failed: 0, stopped: 0 }
  expect(block.lines(current).map(stripAnsi)[0]).toBe("└ ○ in the background")
  group.agents = { total: 1, ended: 0, working: 0, queued: 1, idle: 0 }
  expect(block.lines({ ...current, theme: defaultTheme })[0]).toContain(defaultTheme.dim("·"))
})

test("aggregate snapshots count nested compact members only once", () => {
  const lead = { ...child("lead"), groupId: "outer" }
  const helper = { ...child("helper", lead.id, 2), groupId: "inner" }
  const nested = { ...child("nested", helper.id, 3), groupId: "inner" }
  const group = (id: string, parentSessionId: string, total: number): SpawnGroupInfo => ({
    id,
    name: id,
    parentSessionId,
    state: "active",
    limits: {},
    compact: true,
    usage: emptyUsage(),
    tokens: 0,
    agents: { total, ended: total, working: 0, queued: 0, idle: 0 },
    outcomes: { done: total - 1, failed: 1, stopped: 0 },
  })
  const outer = group("outer", "main", 3)
  const inner = group("inner", lead.id, 2)
  const counts = subagentCounts(
    [lead, helper, nested],
    new Map([
      [outer.id, outer],
      [inner.id, inner],
    ]),
  )
  expect(counts).toMatchObject({ total: 3, done: 2, failed: 1 })
})

test("only and last children close their own level, including the legacy open-top path", () => {
  expect(treeLayout([{ depth: 1 }], false)).toEqual([{ indent: "", last: true }])
  const nodes = [child("first"), child("nested", "first", 2), child("last")]
  expect(treeLayout(nodes, false).map(({ last }) => last)).toEqual([false, true, true])
  const rows = treeRows(nodes, 6000, 100, monoTheme, undefined, false).map(stripAnsi)
  expect(rows[0]).toStartWith("├ ✓ done    first")
  expect(rows[1]).toStartWith("│ └ ✓ done    nested")
  expect(rows[2]).toStartWith("└ ✓ done    last")
})

test("tool children use closing arms with compact heads and expanded continuation results", () => {
  const block = new ToolBlock("call", "agent", {}, "main")
  block.end = { result: textResult("one\ntwo\nthree") }
  const only = child("only")
  for (const detail of ["collapsed", "summary", "full"] as const) {
    const current = { ...env, detail, nodes: new Map([[only.id, only]]) }
    const rows = block.lines(current).map(stripAnsi)
    expect(rows[1]).toStartWith("│ └ ✓ done    only")
    expect(rows.join("\n")).not.toContain("export function")
    expect(rows.join("\n")).not.toContain("```")
    expect(rows.join("\n")).not.toContain("RESULT TEXT")
    expect(rows.join("\n")).toContain("one")
    expect(rows.every((row) => visibleWidth(row) <= 100)).toBe(true)
  }
  block.folding = "collapsed"
  expect(block.lines({ ...env, nodes: new Map([[only.id, only]]) }).map(stripAnsi)[1]).toBe(
    "│ └ ✓ 1 sub-agent · 1 done",
  )
})

test("compact finished rows omit all result text without discarding the node's details", () => {
  for (const status of ["done", "error", "aborted"] as const) {
    const node = child("Scan")
    node.end = { status, error: "ERROR DETAILS", note: "STOP DETAILS", durationMs: 6000, tokens: 4100 }
    const mark = status === "error" ? "✗ failed" : "‖ stopped"
    const rows = nodeRows(node, 6000, 100, monoTheme).map(stripAnsi)
    expect(rows).toEqual([`└ ${mark.padEnd(9)} Scan · explorer · 6.0s · 4.1k tok`])
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
    expect(rows[0]).toStartWith("|-✓ done    first")
    expect(rows[1]).toStartWith("`-✓ done    last")
    for (const width of [1, 3, 12, 35, 100]) {
      expect(treeRows(nodes, 6000, width, monoTheme).every((row) => visibleWidth(row) <= width)).toBe(true)
    }
  } finally {
    setGlyphs(before)
  }
})
