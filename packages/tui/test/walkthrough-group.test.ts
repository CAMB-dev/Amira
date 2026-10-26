// A/C/D style oracles: root markers at 0, content at 2, logical two-cell child rails and muted chrome.
import { expect, spyOn, test } from "bun:test"
import { emptyUsage, userMessage } from "@amira/ai"
import type { AnyEvent, EventMap, SpawnGroupInfo } from "@amira/api"
import { EventBus } from "@amira/core"
import { defaultTheme, FakeTerminal, Spinner, stripAnsi, visibleWidth } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { type BlockEnv, SubagentGroupBlock } from "../src/blocks.ts"
import { createFullscreenView } from "../src/fullscreen-view.ts"
import { setGlyphs } from "../src/glyphs.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"

const at = 1000

function setup(_mode: "fullscreen") {
  const terminal = new FakeTerminal(100, 40)
  const screen = new VirtualScreen(100, 40)
  const write = terminal.write.bind(terminal)
  terminal.write = (data) => {
    write(data)
    screen.write(data)
  }
  const spinner = new Spinner()
  const view = createFullscreenView({
    terminal,
    theme: plain.theme,
    capabilities: { win32InputMode: false, kittyKeyboard: true, synchronizedOutput: false, shiftEnter: true },
    settings: { margin: 0, marginRows: 0 },
    presenters: undefined,
    hyperlinks: false,
    renders: new ReplyRenderers(undefined),
    keys: new Keybindings(defaultKeys({ vscode: false })),
    spinner,
    sessionId: () => "main",
    detail: () => "summary",
    bottom: () => ["input"],
    overlay: { render: () => ["agents overlay"] },
    editorEmpty: () => true,
    showNote: () => {},
  })
  const bus = new EventBus()
  const event = <K extends keyof EventMap>(type: K, data: EventMap[K], sessionId = "main") =>
    view.subagentEvent(bus.emit(type, data, { sessionId }) as AnyEvent)
  const start = (id: string, parent = "main", callId?: string) =>
    event(
      "subagent.start",
      {
        childSessionId: id,
        title: id,
        role: "explorer",
        prompt: "work",
        model: { provider: "mock", model: "m1" },
        depth: parent === "main" ? 1 : 2,
        cwd: "/work",
        context: "fresh",
        queued: false,
        ...(callId ? { toolCallId: callId } : {}),
      },
      parent,
    )
  view.start()
  return { view, screen, event, start, spinner, text: () => screen.lines.join("\n") }
}

function guides(ascii: boolean) {
  return ascii
    ? { branch: "|-", last: "`-", gap: "", first: "| ", final: "  ", activity: "    " }
    : { branch: "├", last: "└", gap: " ", first: "│ ", final: "  ", activity: "    " }
}

for (const ascii of [false, true]) {
  for (const mode of ["fullscreen"] as const) {
    test(`${mode}: sibling background groups nest their children after resumed history (${ascii ? "ASCII" : "Unicode"})`, () => {
      const clock = spyOn(Date, "now").mockReturnValue(at)
      if (ascii) setGlyphs({ treeBranch: "|-", treeLast: "`-", treePipe: "|" })
      const { view, start, event, text } = setup(mode)
      try {
        view.openSession({ resumed: true }, [userMessage("Restored prompt")], true)
        // Inline's committed calls have moved their children to the background region;
        // fullscreen has no call block for these roots and makes group blocks of its own.
        start("First task", "main", "first-call")
        start("Last task", "main", "last-call")
        event(
          "tool.execute.start",
          { toolCallId: "scan", name: "bash", args: { command: "ls src" } },
          "Last task",
        )
        view.render()
        const g = guides(ascii)
        const rows = text().split("\n")
        const first = rows.findIndex((row) => row.includes("First task · explorer"))
        const last = rows.findIndex((row) => row.includes("Last task · explorer"))
        expect(rows[first - 1]).toStartWith(`${g.branch}${g.gap}⠋ `)
        expect(rows[first]).toBe(`${g.first}${g.last}${g.gap}⠋ working First task · explorer · 0s · 0 tok`)
        expect(rows[last - 1]).toStartWith(`${g.last}${g.gap}⠋ `)
        expect(rows[last]).toBe(`${g.final}${g.last}${g.gap}⠋ working Last task · explorer · 0s · 0 tok`)
        expect(rows[last + 1]).toBe(`${g.activity}${g.last}${g.gap}⠋ bash ls src`)
        expect(text()).toContain("Restored prompt")
        // /agents temporarily covers the transcript; restoring it uses the same group routes.
        view.openOverlay()
        view.renderOverlay()
        view.closeOverlay()
        view.render()
        expect(text()).toContain(`${g.first}${g.last}${g.gap}⠋ working First task`)
        expect(text()).toContain(`${g.final}${g.last}${g.gap}⠋ working Last task`)
      } finally {
        view.stop()
        setGlyphs()
        clock.mockRestore()
      }
    })
  }

  test(`fullscreen exit prints the group hierarchy and resumed history (${ascii ? "ASCII" : "Unicode"})`, () => {
    const clock = spyOn(Date, "now").mockReturnValue(at)
    if (ascii) setGlyphs({ treeBranch: "|-", treeLast: "`-", treePipe: "|" })
    const { view, start, screen } = setup("fullscreen")
    try {
      view.openSession({ resumed: true }, [userMessage("Restored prompt")], true)
      start("First task")
      start("Last task")
      view.render()
      view.stop()
      const g = guides(ascii)
      expect(screen.mainText).toContain(
        `${g.branch}${g.gap}⠋ started by a command · in the background\n${g.first}${g.last}${g.gap}⠋ working First task`,
      )
      expect(screen.mainText).toContain(
        `${g.last}${g.gap}⠋ started by a command · in the background\n${g.final}${g.last}${g.gap}⠋ working Last task`,
      )
      expect(screen.mainText).toContain("Restored prompt")
    } finally {
      view.stop()
      setGlyphs()
      clock.mockRestore()
    }
  })
}

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: a compact command group is one child below its header, not its sibling`, () => {
    const clock = spyOn(Date, "now").mockReturnValue(at)
    const { view, event, text } = setup(mode)
    const group: SpawnGroupInfo = {
      id: "workflow",
      name: "workflow demo",
      parentSessionId: "main",
      state: "active",
      limits: {},
      compact: true,
      status: "Explore · 0/2 agents",
      usage: emptyUsage(),
      tokens: 0,
      agents: { total: 2, working: 2, queued: 0, idle: 0, ended: 0 },
    }
    try {
      event("group.start", { group })
      for (const id of ["one", "two"])
        event("subagent.start", {
          childSessionId: id,
          groupId: group.id,
          title: id,
          prompt: "work",
          model: { provider: "mock", model: "m1" },
          depth: 1,
          cwd: "/work",
          context: "fresh",
          queued: false,
        })
      view.render()
      expect(text()).toMatch(
        /^└ ⠋ in the background\n {2}└ ⠋ working workflow demo · 2 working · 0 tok · Explore · 0\/2 agents$/m,
      )
      expect(text().match(/workflow demo/g)).toHaveLength(1)
      group.agents = { total: 2, working: 0, queued: 0, idle: 2, ended: 0 }
      group.status = "Waiting"
      event("group.update", { group })
      for (const childSessionId of ["one", "two"])
        event("subagent.state", { childSessionId, state: "idle", turns: 1 })
      view.render()
      expect(text()).toContain("└ ○ in the background")
      expect(text()).toContain("2 idle")
    } finally {
      view.stop()
      clock.mockRestore()
    }
  })
}

test("fullscreen: compact failed and idle-only groups never acquire successful root marks", () => {
  const { view, event, text } = setup("fullscreen")
  const group: SpawnGroupInfo = {
    id: "workflow",
    name: "workflow",
    parentSessionId: "main",
    state: "active",
    limits: {},
    compact: true,
    usage: emptyUsage(),
    tokens: 0,
    agents: { total: 1, working: 1, queued: 0, idle: 0, ended: 0 },
    outcomes: { done: 0, failed: 0, stopped: 0 },
  }
  try {
    event("group.start", { group })
    event("subagent.start", {
      childSessionId: "member",
      groupId: group.id,
      prompt: "work",
      title: "member",
      model: { provider: "mock", model: "m1" },
      depth: 1,
      cwd: "/work",
      context: "fresh",
      queued: false,
    })
    event("subagent.state", { childSessionId: "member", state: "idle", turns: 1 })
    const idle = { ...group, agents: { ...group.agents, working: 0, idle: 1 } }
    event("group.update", { group: idle })
    view.render()
    expect(text()).toMatch(/^└ ○ in the background\n {2}└ ○ idle {4}workflow · 1 idle · 0 tok$/m)
    event("subagent.end", {
      childSessionId: "member",
      status: "error",
      error: "failed child",
      usage: emptyUsage(),
      durationMs: 1,
    })
    event("group.end", {
      group: {
        ...group,
        state: "ended",
        agents: { ...group.agents, working: 0, ended: 1 },
        outcomes: { done: 0, failed: 1, stopped: 0 },
      },
    })
    view.render()
    expect(text()).toMatch(/^└ ✗ in the background\n {2}└ ✗ failed {2}workflow · 1 failed · 0 tok$/m)
    expect(text()).not.toContain("1/1 done")
  } finally {
    view.stop()
  }
})

test("fullscreen: adding a sibling invalidates a finished group's cached arm and continuation", () => {
  const clock = spyOn(Date, "now").mockReturnValue(at)
  const { view, start, event, text } = setup("fullscreen")
  try {
    start("First task")
    event("subagent.end", {
      childSessionId: "First task",
      status: "done",
      usage: emptyUsage(),
      durationMs: 0,
    })
    view.render()
    view.render()
    start("Last task")
    view.render()
    expect(text()).toContain("├ ✓ started by a command · in the background\n│ └ ✓ done    First task")
    view.replyDelta("A reply ends the tree.")
    view.replyEnd([])
    view.render()
    expect(text()).toContain("  └ ⠋ working Last task")
  } finally {
    view.stop()
    clock.mockRestore()
  }
})

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: background working badges animate without a parent turn timer`, async () => {
    const { view, start, event, spinner, text } = setup(mode)
    try {
      expect(spinner.running).toBe(false)
      start("Background task")
      view.render()
      expect(text()).toContain("⠋ working Background task")
      await Bun.sleep(Spinner.INTERVAL_MS * 2)
      view.render()
      expect(spinner.glyph).not.toBe("⠋")
      expect(text()).toContain(`${spinner.glyph} working Background task`)
      for (const state of ["paused", "queued", "idle"] as const) {
        event("subagent.state", { childSessionId: "Background task", state, turns: 1 })
        const frame = spinner.glyph
        await Bun.sleep(Spinner.INTERVAL_MS * 2)
        expect(spinner.glyph).toBe(frame)
      }
    } finally {
      view.stop()
    }
  })
}

test("group rails use gray and reserve their full width before clipping children", () => {
  const env: BlockEnv = {
    theme: defaultTheme,
    width: 30,
    now: at,
    spinner: "⠋",
    detail: "summary",
    presenters: undefined,
    hyperlinks: false,
    nodes: new Map([
      [
        "one",
        {
          id: "one",
          parent: "main",
          title: "A long title to truncate",
          role: "explorer",
          depth: 1,
          startedAt: at,
          tokens: 0,
        },
      ],
    ]),
  }
  const block = new SubagentGroupBlock("one")
  block.last = false
  const rows = block.lines(env)
  expect(rows[0]).toContain(defaultTheme.muted("├"))
  expect(rows[1]).toStartWith(`${defaultTheme.muted("│")} ${defaultTheme.muted("└")}`)
  expect(rows.every((row) => visibleWidth(row) <= env.width)).toBe(true)
  expect(stripAnsi(rows[1]!)).toStartWith("│ └ ⠋ ")
  block.last = true
  const lastRows = block.lines(env)
  expect(lastRows[1]).toStartWith(`  ${defaultTheme.muted("└")}`)
  expect(stripAnsi(lastRows[1]!)).toStartWith("  └ ⠋ ")
})
