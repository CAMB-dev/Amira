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
import { createInlineView } from "../src/inline-view.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"

const at = 1000

function setup(mode: "inline" | "fullscreen") {
  const terminal = new FakeTerminal(100, 40)
  const screen = new VirtualScreen(100, 40)
  const write = terminal.write.bind(terminal)
  terminal.write = (data) => {
    write(data)
    screen.write(data)
  }
  const view = (mode === "inline" ? createInlineView : createFullscreenView)({
    terminal,
    theme: plain.theme,
    capabilities: { win32InputMode: false, kittyKeyboard: true, synchronizedOutput: false, shiftEnter: true },
    settings: {},
    presenters: undefined,
    hyperlinks: false,
    renders: new ReplyRenderers(undefined),
    keys: new Keybindings(defaultKeys({ vscode: false })),
    spinner: new Spinner(),
    sessionId: () => "main",
    detail: () => "summary",
    bottom: (width, ctx, _budget, top) => [...(top?.render(width, ctx) ?? []), "input"],
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
  return { view, screen, event, start, text: () => screen.lines.join("\n") }
}

function guides(ascii: boolean) {
  return ascii
    ? { branch: "|-", last: "`-", first: "  |   ", final: "      ", activity: "         " }
    : { branch: "├", last: "└", first: "  │  ", final: "     ", activity: "       " }
}

for (const ascii of [false, true]) {
  for (const mode of ["inline", "fullscreen"] as const) {
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
        expect(rows[first - 1]).toStartWith(`  ${g.branch} ⠋ `)
        expect(rows[first]).toBe(`${g.first}${g.last} ⠋ First task · explorer · 0s · 0 tok`)
        expect(rows[last - 1]).toStartWith(`  ${g.last} ⠋ `)
        expect(rows[last]).toBe(`${g.final}${g.last} ⠋ Last task · explorer · 0s · 0 tok`)
        expect(rows[last + 1]).toBe(`${g.activity}${g.last} ⠋ bash ls src`)
        expect(text()).toContain("Restored prompt")
        // /agents temporarily covers the transcript; restoring it uses the same group routes.
        view.openOverlay()
        view.renderOverlay()
        view.closeOverlay()
        view.render()
        expect(text()).toContain(`${g.first}${g.last} ⠋ First task`)
        expect(text()).toContain(`${g.final}${g.last} ⠋ Last task`)
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
        `  ${g.branch} ⠋ started by a command · in the background\n${g.first}${g.last} ⠋ First task`,
      )
      expect(screen.mainText).toContain(
        `  ${g.last} ⠋ started by a command · in the background\n${g.final}${g.last} ⠋ Last task`,
      )
      expect(screen.mainText).toContain("Restored prompt")
    } finally {
      view.stop()
      setGlyphs()
      clock.mockRestore()
    }
  })
}

for (const mode of ["inline", "fullscreen"] as const) {
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
      expect(text()).toContain("  └ ⠋ in the background\n     └ ⠋ workflow demo · Explore · 0/2 agents")
      expect(text().match(/workflow demo/g)).toHaveLength(1)
    } finally {
      view.stop()
      clock.mockRestore()
    }
  })
}

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
    expect(text()).toContain("  ├ ✓ started by a command · in the background\n  │  └ ✓ First task")
    view.replyDelta("A reply ends the tree.")
    view.replyEnd([])
    view.render()
    expect(text()).toContain("     └ ⠋ Last task")
  } finally {
    view.stop()
    clock.mockRestore()
  }
})

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
  expect(rows[1]).toStartWith(`  ${defaultTheme.muted("│")}${defaultTheme.muted("  └")}`)
  expect(rows.every((row) => visibleWidth(row) <= env.width)).toBe(true)
  expect(stripAnsi(rows[1]!)).toStartWith("  │  └ ⠋ ")
  block.last = true
  const lastRows = block.lines(env)
  expect(lastRows[1]).toStartWith(`   ${defaultTheme.muted("  └")}`)
  expect(stripAnsi(lastRows[1]!)).toStartWith("     └ ⠋ ")
})
