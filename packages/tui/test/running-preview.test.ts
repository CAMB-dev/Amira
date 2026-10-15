// A/C/D style oracles: root markers at 0, content at 2, logical two-cell child rails and muted chrome.
import { expect, test } from "bun:test"
import { defineTool, textResult } from "@amira/api"
import { monoTheme, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { builtinPresenters } from "../../../extensions/builtin-tools/src/index.ts"
import { type BlockEnv, ToolBlock } from "../src/blocks.ts"
import { ExtensionViewer } from "../src/extension-view.ts"
import { runningBoundary } from "../src/fullscreen/running-boundary.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"
import { runningOutputLimit, runningToolLines } from "../src/tool-view.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"
import { closeImageApp, parallel, setup, waitFor } from "./app-harness.ts"

const env: BlockEnv = {
  theme: monoTheme,
  width: 100,
  now: 4000,
  spinner: "⠋",
  detail: "full",
  hyperlinks: false,
  presenters: { get: (name) => builtinPresenters[name] },
  nodes: new Map(),
}
const preview = (id: number) => textResult(`${id}-old\n${id}-earlier\n${id}-latest\n${id}-tail`)

function tool(id: number): ToolBlock {
  const block = new ToolBlock(String(id), "bash", { command: `check-${id}` }, "s")
  block.startedAt = 0
  block.partial = preview(id)
  return block
}

test("live previews share six rows, keep every head, and search/copy/selection see each row once", () => {
  const pane = new TranscriptPane()
  const calls = [tool(1), tool(2), tool(3)]
  for (const call of calls) pane.add(call)
  const rows = pane.render(env, 16).map(stripAnsi)
  expect(rows.filter((row) => row.startsWith("⠋ Running"))).toHaveLength(3)
  expect(rows.filter((row) => row.startsWith("│ "))).toEqual([
    "│ 1-latest",
    "│ 1-tail",
    "│ 2-latest",
    "│ 2-tail",
    "│ 3-latest",
    "│ 3-tail",
  ])
  pane.find("1-tail")
  expect(pane.matchCount).toBe(1)
  pane.selectText({ block: calls[0]!, line: 1, col: 0 }, { block: calls[0]!, line: 2, col: 100 })
  expect(pane.selectedText()).toBe("1-latest\n1-tail")
  expect(calls[0]!.copyText()).toBe('bash {"command":"check-1"}')
  expect(pane.printout(env).join("\n")).not.toContain("1-tail")
  calls[0]!.end = { result: textResult("1-latest\n1-tail") }
  calls[0]!.touch()
  pane.render(env, 16)
  pane.find("1-tail")
  expect(pane.matchCount).toBe(1)
  expect(
    pane
      .printout(env)
      .join("\n")
      .match(/1-tail/g),
  ).toHaveLength(1)
  expect(pane.plain(calls[1]!, env).slice(1)).toHaveLength(3)
})

test("preview budget remains bounded even with more streaming calls than rows", () => {
  for (const count of [1, 2, 3, 4, 6, 8, 20]) {
    const limits = Array.from({ length: count }, (_, index) => runningOutputLimit(index, count))
    expect(limits.reduce((sum, limit) => sum + limit, 0)).toBeLessThanOrEqual(6)
    expect(limits.every((limit) => limit >= 0 && limit <= 3)).toBe(true)
  }
})

test("running previews use the muted pipe even for a last call, fit narrow widths, and vanish on finish", () => {
  const before = { ...glyphs }
  try {
    for (const pipe of ["│", "|"]) {
      setGlyphs({ treePipe: pipe })
      for (const width of [1, 2, 8, 20, 100]) {
        const rows = runningToolLines(
          monoTheme,
          builtinPresenters.bash,
          {
            name: "bash",
            args: { command: "check" },
            startedAt: 0,
            partial: preview(1),
          },
          4000,
          "⠋",
          width,
          { last: true },
        )
        expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true)
        if (width === 100)
          expect(rows.slice(1).map(stripAnsi)).toEqual([
            `${pipe} 1-earlier`,
            `${pipe} 1-latest`,
            `${pipe} 1-tail`,
          ])
      }
    }
  } finally {
    setGlyphs(before)
  }
  const pane = new TranscriptPane()
  const call = tool(1)
  call.last = true
  call.partial = undefined
  pane.add(call)
  expect(pane.lines(call, env)).toHaveLength(1)
  const boundary = runningBoundary(pane)
  boundary.update([call])
  call.end = { result: textResult("done") }
  call.touch()
  boundary.update([call])
  expect(pane.render(env, 10).join("\n")).not.toContain("───")
  expect(pane.plain(call, env)[0]).toStartWith("└ Ran check-1")
})

test("/agents host renderer uses the same heads, pipes, total cap and transient rule", () => {
  let done = false
  const viewer = new ExtensionViewer(
    {
      kind: "preview",
      title: () => "Preview",
      render: (_data, opts) => [
        ...opts.renderTool!(
          "bash",
          { args: { command: "finished" }, result: textResult("ok"), text: "ok" },
          "collapsed",
        ),
        ...[1, 2, 3].flatMap((id) =>
          done
            ? opts.renderTool!(
                "bash",
                { args: { command: `check-${id}` }, result: textResult("done"), text: "done" },
                "collapsed",
                { last: id === 3 },
              )
            : opts.renderRunningTool!(
                "bash",
                { args: { command: `check-${id}` }, startedAt: 0, partial: preview(id) },
                { last: id === 3 },
              ),
        ),
      ],
    },
    {},
    { now: () => 4000, presenters: env.presenters },
  )
  const ctx = { theme: monoTheme, color: false, rows: 30 }
  const rows = viewer.render(100, ctx).map(stripAnsi)
  expect(rows.filter((row) => row.startsWith("⠋ Running"))).toHaveLength(3)
  expect(rows.filter((row) => row.startsWith("│ "))).toEqual([
    "│ 1-latest",
    "│ 1-tail",
    "│ 2-latest",
    "│ 2-tail",
    "│ 3-latest",
    "│ 3-tail",
  ])
  const rule = rows.indexOf("  ───")
  expect(rows.slice(rule - 1, rule + 2)).toEqual(["", "  ───", ""])
  done = true
  const finished = viewer.render(100, ctx).map(stripAnsi)
  expect(finished).not.toContain("  ───")
  expect(finished.join("\n")).not.toContain("-tail")
  expect(finished).toContain("└ Ran check-3  ✓ done")
})

test("/agents long commands leave two cells before elapsed time and finished results retain their rail", () => {
  const command = `printf '%s' ${"very-long-argument/".repeat(12)} | head -5)`
  let done = false
  const viewer = new ExtensionViewer(
    {
      kind: "preview",
      title: () => "Preview",
      render: (_data, opts) =>
        done
          ? opts.renderTool!(
              "bash",
              {
                args: { command },
                result: { ...textResult("ok"), details: { exitCode: 0 } },
                text: "ok",
                durationMs: 17_600,
              },
              "collapsed",
            )
          : opts.renderRunningTool!("bash", { args: { command }, startedAt: 0 }),
    },
    {},
    { now: () => 9000, presenters: env.presenters },
  )
  const ctx = { theme: monoTheme, color: false, rows: 30 }
  const head = viewer
    .render(80, ctx)
    .map(stripAnsi)
    .find((row) => row.includes("Running"))!
  expect(head).toMatch(/head -5\) {2,}9s$/)
  expect(visibleWidth(head)).toBe(80)
  done = true
  const finished = viewer.render(80, ctx).map(stripAnsi)
  expect(finished.find((row) => row.includes("Ran"))).not.toContain("✓")
  expect(finished).toContain("│ ✓ 1 line · 17.6s")
  expect(finished.every((row) => visibleWidth(row) <= 80)).toBe(true)
})

test("/agents rule removes only its duplicate blank line, not earlier intentional spacing", () => {
  for (const blanks of [0, 1, 3]) {
    const viewer = new ExtensionViewer(
      {
        kind: "preview",
        title: () => "Preview",
        render: (_data, opts) => [
          ...opts.renderReply!("Before."),
          ...Array.from({ length: blanks }, () => ({ kind: "text" as const, text: "" })),
          ...opts.renderRunningTool!("bash", { args: { command: "check" }, startedAt: 0 }),
        ],
      },
      {},
      { now: () => 4000 },
    )
    const rows = viewer.render(100, { theme: monoTheme, color: false, rows: 30 }).map(stripAnsi)
    const before = rows.indexOf("  Before.")
    const rule = rows.indexOf("  ───")
    expect(rows.slice(before + 1, rule)).toEqual(Array(Math.max(1, blanks)).fill(""))
    expect(rows[rule + 1]).toBe("")
  }
})

test("/agents and fullscreen give one streaming call three rows beside two silent calls", () => {
  const pane = new TranscriptPane()
  for (const id of [1, 2, 3]) {
    const call = tool(id)
    if (id !== 2) call.partial = undefined
    pane.add(call)
  }
  const viewer = new ExtensionViewer(
    {
      kind: "preview",
      title: () => "Preview",
      render: (_data, opts) =>
        [1, 2, 3].flatMap((id) =>
          opts.renderRunningTool!("bash", {
            args: { command: `check-${id}` },
            startedAt: 0,
            ...(id === 2 ? { partial: preview(id) } : {}),
          }),
        ),
    },
    {},
    { now: () => 4000, presenters: env.presenters },
  )
  const liveRows = (rows: string[]) => rows.map(stripAnsi).filter((row) => row.startsWith("│ "))
  const expected = ["│ 2-earlier", "│ 2-latest", "│ 2-tail"]
  expect(liveRows(viewer.render(100, { theme: monoTheme, color: false, rows: 30 }))).toEqual(expected)
  expect(liveRows(pane.render(env, 16))).toEqual(expected)
})

for (const mode of ["fullscreen", "inline"] as const) {
  test(`${mode}: long running commands keep a two-cell timer gap and finished results wrap below`, async () => {
    const command = `printf '%s' ${"very-long-argument/".repeat(12)} | head -5)`
    const s = await setup(
      [
        { text: "Before the command.", toolCalls: [{ name: "bash", args: { command } }] },
        { text: "After the command." },
      ],
      { cols: 80, rows: 40, presenters: true, settings: { mode } },
    )
    let release: (() => void) | undefined
    s.agent.tools.register(
      defineTool({
        name: "bash",
        ...parallel,
        execute: async () => {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return {
            ...textResult(Array.from({ length: 22 }, (_, i) => `out ${i + 1}`).join("\n")),
            details: { exitCode: 0, outputLines: 22 },
          }
        },
      }),
      "test:timer-gap",
    )
    try {
      s.terminal.send("go\r")
      await waitFor(() => !!release && s.live().includes("Running"), "long running command")
      const head = s
        .live()
        .split("\n")
        .find((row) => row.includes("Running"))!
      expect(head).toMatch(/head -5\) {2,}\d+s$/)
      expect(visibleWidth(head)).toBe(80)
      release!()
      await s.shows("After the command.")
      await s.idle()
      const finished = s.all().split("\n")
      expect(finished.find((row) => row.includes("Ran"))).not.toContain("✓")
      expect(finished.some((row) => /^ +✓ 22 lines(?: · .+)?$/.test(row))).toBe(true)
    } finally {
      release?.()
      await closeImageApp(s)
    }
  })
  test(`${mode}: one streaming call beside two silent calls keeps three live rows`, async () => {
    const s = await setup(
      [
        { toolCalls: [1, 2, 3].map((id) => ({ name: "stream", args: { command: `check-${id}` } })) },
        { text: "After the checks." },
      ],
      { cols: 100, rows: 40, settings: { mode } },
    )
    const releases: (() => void)[] = []
    s.agent.tools.register(
      defineTool({
        name: "stream",
        ...parallel,
        execute: async (_args, ctx) => {
          const id = releases.length + 1
          if (id === 2) ctx.update(preview(id))
          await new Promise<void>((resolve) => releases.push(resolve))
          return textResult(`finished-${id}`)
        },
      }),
      "test:preview",
    )
    try {
      s.terminal.send("go\r")
      await waitFor(() => releases.length === 3 && s.live().includes("2-tail"), "mixed live previews")
      expect(
        s
          .live()
          .split("\n")
          .filter((row) => row.startsWith("│ ") && !row.startsWith("│ › ")),
      ).toEqual(["│ 2-earlier", "│ 2-latest", "│ 2-tail"])
      for (const release of releases) release()
      await s.shows("After the checks.")
      await s.idle()
      expect(s.all()).not.toContain("-tail")
    } finally {
      for (const release of releases) release()
      await closeImageApp(s)
    }
  })
  test(`${mode}: parallel live updates use one preview per call and disappear from the committed transcript`, async () => {
    const s = await setup(
      [
        {
          text: "Before the checks.",
          toolCalls: [1, 2, 3].map((id) => ({ name: "stream", args: { command: `check-${id}` } })),
        },
        { text: "After the checks." },
      ],
      { cols: 100, rows: 40, settings: { mode } },
    )
    const releases: (() => void)[] = []
    s.agent.tools.register(
      defineTool({
        name: "stream",
        ...parallel,
        execute: async (_args, ctx) => {
          const id = releases.length + 1
          ctx.update(preview(id))
          await new Promise<void>((resolve) => releases.push(resolve))
          return textResult(`finished-${id}`)
        },
      }),
      "test:preview",
    )
    try {
      s.terminal.send("go\r")
      await waitFor(() => releases.length === 3 && s.live().includes("3-tail"), "parallel previews")
      const rows = s.live().split("\n")
      expect(
        rows.filter((row) => /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/.test(row) && row.includes("stream check-")),
      ).toHaveLength(3)
      expect(rows.filter((row) => row.startsWith("│ ") && !row.startsWith("│ › "))).toEqual([
        "│ 1-latest",
        "│ 1-tail",
        "│ 2-latest",
        "│ 2-tail",
        "│ 3-latest",
        "│ 3-tail",
      ])
      for (const release of releases) release()
      await s.shows("After the checks.")
      await s.idle()
      expect(s.all()).not.toContain("-tail")
      expect(s.all().split("\n")).not.toContain("  ───")
      expect(s.all()).toContain("└ stream check-3  ✓ finished-3")
    } finally {
      for (const release of releases) release()
      await closeImageApp(s)
    }
  })
}
