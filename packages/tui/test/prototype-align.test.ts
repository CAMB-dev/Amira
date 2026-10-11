import { expect, spyOn, test } from "bun:test"
import { defineTool, textResult } from "@amira/api"
import { bold, createTheme, Editor, FakeTerminal, Spinner, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { builtinPresenters } from "../../../extensions/builtin-tools/src/index.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { activityRow } from "../src/app/activity-row.ts"
import { type BlockEnv, ReplyBlock, ToolBlock } from "../src/blocks.ts"
import { rememberMessageTime } from "../src/format.ts"
import { runningBoundary } from "../src/fullscreen/running-boundary.ts"
import { createFullscreenView } from "../src/fullscreen-view.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"
import { headerLine } from "../src/header.ts"
import { InputBox } from "../src/input-box.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"
import { closeImageApp, setup, waitFor } from "./app-harness.ts"
import { withSnapshotClock } from "./clock-fixture.ts"

const theme = createTheme({ theme: "dark", colorDepth: "truecolor", env: {}, platform: "linux" })
const at = new Date(2026, 9, 10, 20, 19).getTime()
const env: BlockEnv = {
  theme,
  width: 100,
  now: at,
  spinner: "⠋",
  detail: "collapsed",
  hyperlinks: false,
  presenters: { get: (name) => builtinPresenters[name] },
  nodes: new Map(),
}

test("header context uses uppercase units and preserves the million decimal", () => {
  const ctx = { theme, color: true, rows: 24 }
  const row = headerLine({ cwd: "~/dev/Amira", used: 16000, limit: 1000000 }, 100, ctx)
  expect(stripAnsi(row)).toEndWith("16K / 1.0M ")
  expect(visibleWidth(row)).toBe(100)
  expect(row).toContain(theme.fg2("16K"))
  expect(row).toContain(theme.muted(" / 1.0M"))
})

test("running boundary is quiet transient chrome, with one blank line on each side", () => {
  const pane = new TranscriptPane()
  const boundary = runningBoundary(pane)
  const reply = new ReplyBlock("Finished reply", false, false)
  const first = new ToolBlock("first", "bash", { command: "first" }, "s")
  const second = new ToolBlock("second", "bash", { command: "second" }, "s")
  first.startedAt = second.startedAt = at
  pane.add(reply)
  pane.add(first)
  pane.add(second)
  boundary.update([first, second])
  const rule = pane.blocks[1]!
  expect(rule.lines(env)).toEqual([theme.muted("  ───")])
  const rows = pane.render(env, 12).map(stripAnsi)
  const index = rows.indexOf("  ───")
  expect(rows.slice(index - 1, index + 2)).toEqual(["", "  ───", ""])
  boundary.update([first, second])
  expect(pane.blocks[1]).toBe(rule)
  expect(rule.copyText()).toBe("")
  expect(rule.copyRows(["  ───"], rule.lines(env))).toEqual([{ from: 5, to: 5 }])
  first.end = { result: textResult("done") }
  boundary.update([first, second])
  expect(pane.blocks).toEqual([reply, first, rule, second])
  boundary.clear()
  expect(pane.printout(env).join("\n")).not.toContain("───")
  boundary.update([first, second])
  second.end = { result: textResult("done") }
  boundary.update([first, second])
  expect(pane.blocks).toEqual([reply, first, second])
  expect(pane.render(env, 12).join("\n")).not.toContain("───")
  try {
    setGlyphs({ rule: "-" })
    second.end = undefined
    boundary.update([first, second])
    expect(rule.lines(env)).toEqual([theme.muted("  ---")])
    for (const width of [1, 2, 3, 5])
      expect(visibleWidth(rule.lines({ ...env, width })[0]!)).toBeLessThanOrEqual(width)
  } finally {
    setGlyphs()
  }
})

test(
  "width-100 fullscreen running turn matches the chosen prototype details",
  withSnapshotClock(() => {
    const clock = spyOn(Date, "now").mockReturnValue(at)
    const terminal = new FakeTerminal(100, 28)
    const screen = new VirtualScreen(100, 28)
    const write = terminal.write.bind(terminal)
    terminal.write = (data) => {
      write(data)
      screen.write(data)
    }
    const keys = new Keybindings(defaultKeys({ vscode: false }))
    const box = new InputBox(new Editor({ prompt: "› ", placeholder: "Message Amira" }), () => [
      { id: "model", text: "claude-opus-5-5 (high) · ask", align: "right", tone: "accent", priority: 40 },
    ])
    const hint = (t: typeof theme) =>
      " " +
      [
        [keys.label("permissions.mode"), "mode"],
        [keys.label("interrupt"), "stop"],
        [keys.label("tool-output"), "detail"],
        [keys.label("help"), "keys"],
      ]
        .map(([key, text]) => bold(t.fg2(key!.toLowerCase())) + t.muted(` ${text}`))
        .join(t.muted(`  ${glyphs.treePipe}  `))
    const view = createFullscreenView({
      terminal,
      theme,
      capabilities: {
        win32InputMode: false,
        kittyKeyboard: true,
        synchronizedOutput: false,
        shiftEnter: true,
      },
      settings: {},
      presenters: env.presenters,
      hyperlinks: false,
      renders: new ReplyRenderers(undefined),
      keys,
      spinner: new Spinner(),
      sessionId: () => "frame",
      detail: () => "collapsed",
      header: (width, ctx) => [
        headerLine(
          {
            cwd: "~/dev/Amira",
            branch: "main",
            dirty: true,
            title: "Status bar layout",
            cost: "$0.42",
            used: 124000,
            limit: 200000,
          },
          width,
          ctx,
        ),
      ],
      bottom: (width, ctx) => [
        activityRow(
          {
            label: "responding",
            spinner: "⠋",
            stepMs: 4100,
            turnMs: 80000,
            tokens: 12400,
            rate: 186,
            stop: "esc stop",
            animationMs: 0,
          },
          width,
          ctx,
        ),
        ...box.render(width, ctx),
        hint(ctx.theme),
      ],
      overlay: { render: () => [] },
      editorEmpty: () => true,
      showNote: () => {},
    })
    view.start()
    try {
      const prompt = {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Make the status bar clearer." }],
      }
      rememberMessageTime(prompt, at)
      view.user(prompt)
      view.reasoningDelta("Move context and cost into the header.")
      clock.mockReturnValue(at + 4200)
      view.replyDelta("# Status bar layout\n\nThe header now carries context and cost.")
      view.replyEnd([])
      for (const [id, name, args] of [
        ["1", "read", { path: "a.ts" }],
        ["2", "read", { path: "b.ts" }],
        ["3", "read", { path: "c.ts" }],
        ["4", "grep", { pattern: "TODO" }],
        ["5", "grep", { pattern: "FIXME" }],
        [
          "6",
          "edit",
          {
            path: "packages/tui/src/status-bar.ts",
            old_string: "old1\nold2\nold3",
            new_string: Array.from({ length: 12 }, (_, i) => `new${i}`).join("\n"),
          },
        ],
        ["7", "bash", { command: "bun test packages/tui" }],
      ] as const) {
        view.toolStart(id, name, args, at)
        view.toolEnd(id, {
          result: textResult(name === "bash" ? "✓ 412 pass" : "done"),
          durationMs: name === "bash" ? 3100 : 0,
        })
      }
      view.toolStart("8", "bash", { command: "git diff --stat" }, at)
      view.toolUpdate(
        "8",
        textResult(
          " packages/tui/src/status-bar.ts | 15 ++++++++++++---\n 1 file changed, 12 insertions(+), 3 deletions(-)",
        ),
      )
      view.render()
      const frame = screen.lines.join("\n")
      expect(frame).toContain("  ├ Read 3 files · Searched 2 patterns  ▸")
      expect(frame).toContain("Edited packages/tui/src/status-bar.ts")
      expect(frame).toContain("Ran bun test packages/tui  ✓ 412 pass · 3.1s")
      expect(frame).toContain("# Status bar layout")
      expect(frame).toContain("  ⠋ Running git diff --stat")
      expect(frame).toContain("    │  1 file changed, 12 insertions(+), 3 deletions(-)")
      expect(frame).toMatch(/∴ Thought for 4\.2s +8:19 PM/m)
      expect(frame.split("\n").filter((row) => row.includes("8:19 PM"))).toHaveLength(2)
      expect(frame).toContain("shift+tab mode  │  esc stop  │  ctrl+o detail  │  ? keys")
      const rows = screen.lines
      const index = rows.indexOf("  ───")
      expect(rows.slice(index - 1, index + 2)).toEqual(["", "  ───", ""])
      expect(rows).toHaveLength(28)
      expect(rows.every((row) => visibleWidth(row) <= 100)).toBe(true)
      expect(frame).toMatchSnapshot()
      if (process.env.TUI_ALIGN_FRAME === "1") console.log(`FRAME 100\n${frame}\nEND FRAME 100`)
      view.turnEnd()
      view.render()
      expect(screen.lines).not.toContain("  ───")
    } finally {
      view.stop()
      clock.mockRestore()
    }
  }),
)

for (const mode of ["fullscreen", "inline"] as const) {
  test(`${mode}: the border never retains token speed; live rate and contextual keys remain reachable`, async () => {
    const s = await setup([{ text: "answer", delayMs: 60 }], { cols: 120, settings: { mode } })
    try {
      s.host.status.register({ id: "token-speed", override: true, text: () => "999 tok/s", align: "right" })
      await s.host.load((api) => api.requestRender(), "test:rate-render")
      await waitFor(() => s.live().includes("shift+tab mode"), "fixed idle hints")
      expect(s.live()).not.toContain("999 tok/s")
      expect(s.live()).not.toContain("esc stop")
      s.terminal.send("go\r")
      await waitFor(() => s.live().includes("enter steer"), "contextual working hint")
      expect(s.live()).toContain("esc stop")
      expect(s.live()).toContain(`${keysForQueue()} queue`)
      await s.shows("answer")
      await s.idle()
      expect(s.live()).not.toContain("999 tok/s")
      expect(
        s
          .live()
          .split("\n")
          .find((row) => row.startsWith("╰")),
      ).toContain("m1 · auto")
    } finally {
      await closeImageApp(s)
    }
  })
}

for (const mode of ["fullscreen", "inline"] as const) {
  test(`${mode}: the running rule disappears at turn end and never enters scrollback`, async () => {
    const s = await setup(
      [{ text: "Finished part", toolCalls: [{ name: "slow", args: {} }] }, { text: "All done" }],
      { cols: 100, settings: { mode } },
    )
    let release: (() => void) | undefined
    s.agent.tools.register(
      defineTool({
        name: "slow",
        description: "",
        parameters: {},
        execute: () =>
          new Promise((resolve) => {
            release = () => resolve(textResult("done"))
          }),
      }),
      "test:boundary",
    )
    try {
      s.terminal.send("go\r")
      await waitFor(() => release !== undefined && s.live().includes("  ───"), "running boundary")
      const rows = s.live().split("\n")
      const index = rows.indexOf("  ───")
      expect(rows.slice(index - 1, index + 2)).toEqual(["", "  ───", ""])
      release!()
      await s.shows("All done")
      await s.idle()
      expect(s.all().split("\n")).not.toContain("  ───")
    } finally {
      release?.()
      await closeImageApp(s)
      expect(s.screen.mainText.split("\n")).not.toContain("  ───")
    }
  })
}

function keysForQueue() {
  return new Keybindings(defaultKeys({ vscode: false })).label("queue")!.toLowerCase()
}
