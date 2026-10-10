import { expect, test } from "bun:test"
import { type Message, type ToolPresenter, textResult } from "@amira/api"
import { defaultTheme, monoTheme, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { builtinPresenters } from "../../../extensions/builtin-tools/src/index.ts"
import type { BlockEnv } from "../src/blocks/base.ts"
import { ExploredBlock, exploredRun, groupExplored, ToolBlock } from "../src/blocks/tool.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"
import { historyLines } from "../src/history.ts"
import { explorationOf, exploredLine, exploredLines, type FinishedCall } from "../src/tool-view.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"

const plain = (rows: string[]) => rows.map(stripAnsi)
const env: BlockEnv = {
  theme: monoTheme,
  width: 100,
  now: 0,
  spinner: "*",
  detail: "summary",
  hyperlinks: false,
  presenters: { get: (name) => builtinPresenters[name] },
  nodes: new Map(),
}
const call = (name: string, args: Record<string, unknown>): FinishedCall => ({
  name,
  args,
  result: textResult("first\nsecond\nthird"),
})
const block = (id: string, name = "read", args = { path: `${id}.ts` }) => {
  const b = new ToolBlock(id, name, args, "main")
  b.end = { result: textResult("first\nsecond\nthird") }
  return b
}

test("read, search, glob, list and fetch have exploration metadata without a presenter", () => {
  for (const [name, args, verb, target] of [
    ["read", { path: "a.ts" }, "Read", "a.ts"],
    ["search", { query: "TODO" }, "Search", "TODO"],
    ["grep", { pattern: "TODO", path: "src" }, "Search", "TODO in src"],
    ["glob", { pattern: "*.ts" }, "Glob", "*.ts"],
    ["list", { path: "src" }, "List", "src"],
    ["fetch", { url: "https://example.com" }, "Fetch", "https://example.com"],
    ["web_fetch", { url: "https://example.com" }, "Fetch", "https://example.com"],
    ["web_search", { query: "Bun" }, "Search", "Bun"],
    ["web_search", { url: "https://example.com" }, "Fetch", "https://example.com"],
  ] as const) {
    expect(explorationOf(undefined, call(name, args))).toEqual({ verb, target })
  }
  expect(explorationOf(builtinPresenters.glob, call("glob", { pattern: "*.ts" }))).toEqual({
    verb: "Glob",
    target: "*.ts",
  })
  expect(explorationOf(undefined, call("bash", { command: "ls" }))).toBeUndefined()
  expect(explorationOf(undefined, call("read", {}))).toBeUndefined()
  expect(explorationOf({ explore: () => undefined }, call("read", { path: "a" }))).toBeUndefined()
  expect(
    explorationOf(
      {
        explore: () => {
          throw new Error("presenter failed")
        },
      },
      call("read", { path: "a" }),
    ),
  ).toBeUndefined()
})

test("counts include repeat targets, in first-action order, without displaying targets", () => {
  const actions = [
    { verb: "Read", target: "a.ts" },
    { verb: "Search", target: "TODO" },
    { verb: "read", target: "b.ts" },
    { verb: "Read", target: "a.ts" },
    { verb: "Glob", target: "*.ts" },
    { verb: "List", target: "src" },
    { verb: "List", target: "test" },
    { verb: "Fetch", target: "https://example.com" },
  ]
  expect(stripAnsi(exploredLine(defaultTheme, actions, 240, { last: true }))).toBe(
    "  └ Read 3 files · Searched 1 pattern · Globbed 1 pattern · Listed 2 directories · Fetched 1 page  ▸",
  )
  for (const [verb, noun] of [
    ["Read", "file"],
    ["Search", "pattern"],
    ["Glob", "pattern"],
    ["List", "directory"],
    ["Fetch", "page"],
  ]) {
    expect(stripAnsi(exploredLine(monoTheme, [{ verb: verb!, target: "a" }], 80))).toContain(`1 ${noun}`)
  }
})

test("folded rows stay count-only and fully muted, including verbs and disclosure", () => {
  const actions = [
    { verb: "Read", target: "界".repeat(30) },
    { verb: "Read", target: "b.ts" },
  ]
  const narrow = exploredLine(defaultTheme, actions, 29)
  expect(narrow).toContain(defaultTheme.muted("▸"))
  expect(stripAnsi(narrow)).toBe("  ├ Read 2 files  ▸")
  const wide = exploredLine(defaultTheme, actions, 120)
  expect(stripAnsi(wide)).toBe("  ├ Read 2 files  ▸")
  expect(wide).toContain(defaultTheme.muted("Read 2 files"))
  expect(wide).toBe(
    `  ${defaultTheme.muted("├")} ${defaultTheme.muted("Read 2 files")}  ${defaultTheme.muted("▸")}`,
  )
  expect(wide).not.toContain("b.ts")
  for (const width of [1, 3, 8, 28, 100]) {
    expect(visibleWidth(exploredLine(defaultTheme, actions, width))).toBeLessThanOrEqual(width)
  }
})

test("mixed verbs retain the counted head and trailing disclosure when paths do not fit", () => {
  const actions = [
    ...["a", "b", "c"].map((path) => ({ verb: "Read", target: `${path}/very/long/path.ts` })),
    ...["first", "second"].map((pattern) => ({ verb: "Search", target: `${pattern} very long pattern` })),
  ]
  expect(stripAnsi(exploredLine(defaultTheme, actions, 50))).toBe("  ├ Read 3 files · Searched 2 patterns  ▸")
})

test("failed, rejected and interrupted calls never enter a group or disappear in its renderer", () => {
  const good = call("read", { path: "a.ts" })
  const bad: FinishedCall[] = [
    { ...good, result: textResult("missing", true) },
    ...(["aborted", "blocked", "unknownTool", "invalidArgs"] as const).map((rejected) => ({
      ...good,
      rejected,
    })),
    { ...good, interrupted: true },
  ]
  for (const failed of bad) expect(explorationOf(builtinPresenters.read, failed)).toBeUndefined()
  const rows = plain(
    exploredLines(
      monoTheme,
      [
        { call: good, presenter: builtinPresenters.read },
        { call: bad[0]!, presenter: builtinPresenters.read },
      ],
      false,
      "summary",
      100,
    ),
  )
  expect(rows.join("\n")).not.toContain("Explored")
  expect(rows.join("\n")).toContain("✗ missing")
  const [a, b, failure, c, d] = ["a", "b", "failure", "c", "d"].map((id) => block(id))
  failure!.end = { result: textResult("missing", true) }
  const grouped = groupExplored([a!, b!, failure!, c!, d!], env)
  expect(grouped).toHaveLength(3)
  expect(grouped[0]).toBeInstanceOf(ExploredBlock)
  expect(grouped[1]).toBe(failure)
  expect(grouped[2]).toBeInstanceOf(ExploredBlock)
  expect(exploredRun([a!, failure!, b!], failure!, env)).toBeUndefined()
})

test("unfolding exposes every original call and its full body, even from collapsed detail", () => {
  const presenter: ToolPresenter = {
    explore: (args) => ({ verb: "Read", target: String(args.path) }),
    result: () => "3 lines",
    body: (_call, { detail }) => (detail === "full" ? [{ kind: "code", text: "one\ntwo\nthree" }] : []),
  }
  const local = { ...env, presenters: { get: () => presenter } }
  for (const detail of ["collapsed", "summary", "full"] as const) {
    const current = { ...local, detail }
    const group = new ExploredBlock([block("a"), block("a")])
    group.last = true
    if (detail !== "full") {
      expect(group.lines(current)).toHaveLength(1)
      group.toggleFold(current)
    }
    const rows = plain(group.lines(current))
    expect(rows[0]).toBe("  ├ read a.ts")
    expect(rows.some((row) => row.includes("Read 2 files") || row.includes("Explored"))).toBe(false)
    expect(rows.filter((row) => /[├└] read a.ts$/.test(row))).toHaveLength(2)
    expect(rows.filter((row) => row.trim().endsWith("three"))).toHaveLength(2)
    expect(group.printLines(current)).toEqual(group.lines(current))
  }
})

test("resumed history and tool blocks use the same folded and full exploration renderer", () => {
  const messages: Message[] = [
    {
      role: "assistant",
      model: { provider: "p", model: "m" },
      content: [
        { type: "toolCall", id: "a", name: "web_fetch", args: { url: "https://a.test" } },
        { type: "toolCall", id: "b", name: "web_fetch", args: { url: "https://b.test" } },
      ],
    },
    ...["a", "b"].map(
      (id): Message => ({
        role: "toolResult",
        toolCallId: id,
        toolName: "web_fetch",
        isError: false,
        content: [{ type: "text", text: "first\nsecond\nthird" }],
      }),
    ),
  ]
  const a = new ToolBlock("a", "web_fetch", { url: "https://a.test" }, "child-session")
  const b = new ToolBlock("b", "web_fetch", { url: "https://b.test" }, "child-session")
  for (const item of [a, b]) item.end = { result: textResult("first\nsecond\nthird") }
  const group = new ExploredBlock([a, b])
  group.last = true
  for (const detail of ["collapsed", "summary", "full"] as const) {
    const rows = plain(historyLines(monoTheme, messages, { width: 100, detail }))
    const start = rows.findIndex((row) => row.includes(detail === "full" ? "├ web_fetch" : "Fetched 2 pages"))
    const rendered = plain(group.lines({ ...env, detail, presenters: undefined }))
    expect(start).toBeGreaterThanOrEqual(0)
    expect(rows.slice(start, start + rendered.length)).toEqual(rendered)
  }
})

test("folded find searches counts; unfolding restores target search without changing raw block copy", () => {
  const a = block("a")
  const b = block("b")
  const group = new ExploredBlock([a, b])
  const copied = 'read {"path":"a.ts"}\nfirst\nsecond\nthird\n\nread {"path":"b.ts"}\nfirst\nsecond\nthird'
  expect(group.copyText()).toBe(copied)
  const pane = new TranscriptPane()
  pane.add(group)
  pane.render(env, 20)
  pane.find("a.ts")
  expect(pane.matchCount).toBe(0)
  pane.find("Read 2 files")
  expect(pane.matchCount).toBe(1)
  group.toggleFold(env)
  pane.render(env, 20)
  pane.find("a.ts")
  expect(pane.matchCount).toBe(1)
  expect(group.copyText()).toBe(copied)
})

test("fold disclosure follows the ASCII theme and measures custom glyph widths", async () => {
  const previous = { ...glyphs }
  try {
    const ascii = await Bun.file(new URL("../../cli/themes/ascii.json", import.meta.url)).json()
    setGlyphs(ascii.glyphs)
    expect(glyphs.folded).toBe(">")
    const actions = [
      { verb: "Read", target: "a.ts" },
      { verb: "Read", target: "a.ts" },
    ]
    expect(stripAnsi(exploredLine(monoTheme, actions, 100))).toBe("  |- Read 2 files  >")
    setGlyphs({ folded: "[+]" })
    const narrow = exploredLine(defaultTheme, actions, 23)
    expect(narrow).toContain(defaultTheme.muted("[+]"))
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(23)
  } finally {
    setGlyphs(previous)
  }
})
