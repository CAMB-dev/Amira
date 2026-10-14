import { expect, spyOn, test } from "bun:test"
import { userMessage } from "@amira/ai"
import { type AnyEvent, type EventMap, emptyUsage, type SpawnGroupInfo, textResult } from "@amira/api"
import { EventBus } from "@amira/core"
import { FakeTerminal, Spinner } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { createInlineView } from "../src/inline-view.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"

function setup() {
  const terminal = new FakeTerminal(100, 30)
  const screen = new VirtualScreen(100, 30)
  const write = terminal.write.bind(terminal)
  terminal.write = (data) => {
    write(data)
    screen.write(data)
  }
  const spinner = new Spinner()
  const view = createInlineView({
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
    bottom: (width, ctx, _budget, top) => [...(top?.render(width, ctx) ?? []), "input"],
    overlay: { render: () => [] },
    editorEmpty: () => true,
    showNote: () => {},
  })
  const bus = new EventBus()
  const event = <K extends keyof EventMap>(type: K, data: EventMap[K], sessionId = "main") =>
    view.subagentEvent(bus.emit(type, data, { sessionId }) as AnyEvent)
  const group: SpawnGroupInfo = {
    id: "workflow",
    name: "workflow demo",
    parentSessionId: "main",
    state: "active",
    limits: {},
    compact: true,
    usage: emptyUsage(),
    tokens: 0,
    agents: { total: 2, working: 2, queued: 0, idle: 0, ended: 0 },
    outcomes: { done: 0, failed: 0, stopped: 0 },
  }
  const start = (id: string, info = group, toolCallId?: string) =>
    event(
      "subagent.start",
      {
        childSessionId: id,
        groupId: info.id,
        title: id,
        prompt: "work",
        model: { provider: "mock", model: "m1" },
        depth: info.parentSessionId === "main" ? 1 : 2,
        cwd: "/work",
        context: "fresh",
        queued: false,
        ...(toolCallId ? { toolCallId } : {}),
      },
      info.parentSessionId,
    )
  view.start()
  return { view, screen, event, group, start, spinner }
}

test("inline compact failure survives all members leaving before terminal group events", () => {
  const { view, screen, event, group, start } = setup()
  try {
    event("group.start", { group })
    for (const id of ["one", "two"]) start(id)
    view.render()
    expect(screen.text).toContain("workflow demo")
    for (const childSessionId of ["one", "two"])
      event("subagent.end", {
        childSessionId,
        status: "error",
        error: "failed child",
        usage: emptyUsage(),
        durationMs: 1,
      })
    const ended: SpawnGroupInfo = {
      ...group,
      state: "ended",
      agents: { ...group.agents, working: 0, ended: 2 },
      outcomes: { done: 0, failed: 2, stopped: 0 },
    }
    event("group.update", { group: ended })
    event("group.end", { group: ended })
    view.render()
    expect(screen.text).toContain("workflow demo · 2 failed")
    expect(screen.text.match(/workflow demo/g)).toHaveLength(1)
    view.stop()
    expect(screen.mainText).toContain("workflow demo · 2 failed")
  } finally {
    view.stop()
  }
})

test("inline live call preserves clean stopped outcomes when legacy terminal snapshots omit outcomes", () => {
  const { view, screen, event, group, start } = setup()
  try {
    view.toolStart("call", "agent", {}, 0)
    event("group.start", { group })
    start("one", group, "call")
    start("two", group, "call")
    for (const childSessionId of ["one", "two"])
      event("subagent.end", {
        childSessionId,
        status: "done",
        note: "Stopped",
        usage: emptyUsage(),
        durationMs: 1,
      })
    const { outcomes: _outcomes, ...legacy } = group
    const ended: SpawnGroupInfo = {
      ...legacy,
      state: "ended",
      agents: { ...group.agents, working: 0, ended: 2 },
    }
    event("group.update", { group: ended })
    event("group.end", { group: ended })
    view.toolEnd("call", { result: textResult("finished"), durationMs: 1 })
    view.render()
    expect(screen.mainText).toContain("workflow demo · 2 stopped")
    expect(screen.mainText).not.toContain("2 ended")
    expect(screen.mainText.match(/workflow demo/g)).toHaveLength(1)
    view.stop()
    expect(screen.mainText).toContain("workflow demo · 2 stopped")
  } finally {
    view.stop()
  }
})

const cases: {
  name: string
  ends: { status: "done" | "error" | "aborted"; note?: string }[]
  outcomes: NonNullable<SpawnGroupInfo["outcomes"]>
  summary: string
}[] = [
  {
    name: "failed",
    ends: [{ status: "error" }, { status: "error" }],
    outcomes: { done: 0, failed: 2, stopped: 0 },
    summary: "2 failed",
  },
  {
    name: "aborted",
    ends: [{ status: "aborted" }, { status: "aborted" }],
    outcomes: { done: 0, failed: 0, stopped: 2 },
    summary: "2 stopped",
  },
  {
    name: "clean stopped",
    ends: [
      { status: "done", note: "Stopped" },
      { status: "done", note: "Turn limit" },
    ],
    outcomes: { done: 0, failed: 0, stopped: 2 },
    summary: "2 stopped",
  },
  {
    name: "done",
    ends: [{ status: "done" }, { status: "done" }],
    outcomes: { done: 2, failed: 0, stopped: 0 },
    summary: "2/2 done",
  },
  {
    name: "mixed",
    ends: [{ status: "done" }, { status: "error" }, { status: "aborted" }],
    outcomes: { done: 1, failed: 1, stopped: 1 },
    summary: "1/3 done · 1 failed · 1 stopped",
  },
]

for (const scenario of cases) {
  for (const placement of ["command", "committed call", "live call"] as const) {
    test(`inline compact ${scenario.name} commits once after its ${placement}`, () => {
      const { view, screen, event, group, start } = setup()
      try {
        const count = scenario.ends.length
        const active = { ...group, agents: { ...group.agents, total: count, working: count } }
        if (placement !== "command") view.toolStart("call", "agent", {}, 0)
        event("group.start", { group: active })
        for (let i = 0; i < count; i++)
          start(`member-${i}`, active, placement === "command" ? undefined : "call")
        if (placement === "committed call")
          view.toolEnd("call", { result: textResult("started"), durationMs: 1 })
        view.render()
        for (const [i, end] of scenario.ends.entries())
          event("subagent.end", { childSessionId: `member-${i}`, ...end, usage: emptyUsage(), durationMs: 1 })
        const terminal: SpawnGroupInfo = {
          ...active,
          state: "ended",
          agents: { ...active.agents, working: 0, ended: count },
          outcomes: scenario.outcomes,
        }
        event("group.update", { group: terminal })
        view.render()
        expect(screen.text).toContain(`workflow demo · ${scenario.summary}`)
        event("group.end", { group: terminal })
        if (placement === "live call") view.toolEnd("call", { result: textResult("finished"), durationMs: 1 })
        view.turnEnd()
        view.render()
        expect(screen.text.match(/workflow demo/g)).toHaveLength(1)
        expect(screen.text).not.toContain("working")
        expect(screen.text).not.toContain("running in background")
        expect(screen.text).not.toContain("member-")
        // Force the committed summary into native scrollback, not just the current screen.
        for (let i = 0; i < 40; i++) view.commandOutput("info", `later output ${i}`)
        view.render()
        expect(screen.scrollback.join("\n")).toContain(`workflow demo · ${scenario.summary}`)
        expect(screen.mainText.match(/workflow demo/g)).toHaveLength(1)
        view.stop()
        expect(screen.mainText.match(/workflow demo/g)).toHaveLength(1)
      } finally {
        view.stop()
      }
    })
  }
}

for (const scenario of cases) {
  for (const route of [
    "live call",
    "committed call",
    "tool before snapshot",
    "own head",
    "on stop",
  ] as const) {
    test(`inline legacy compact ${scenario.name} retains outcomes through ${route}`, () => {
      const { view, screen, event, group, start } = setup()
      try {
        const { outcomes: _outcomes, ...legacy } = group
        const count = scenario.ends.length
        const active = { ...legacy, agents: { ...group.agents, total: count, working: count } }
        if (route !== "own head") view.toolStart("call", "agent", {}, 0)
        event("group.start", { group: active })
        for (let i = 0; i < count; i++)
          start(`member-${i}`, active, route === "own head" ? undefined : "call")
        if (route === "committed call") view.toolEnd("call", { result: textResult("started"), durationMs: 1 })
        for (const [i, end] of scenario.ends.entries())
          event("subagent.end", { childSessionId: `member-${i}`, ...end, usage: emptyUsage(), durationMs: 1 })
        if (route === "tool before snapshot")
          view.toolEnd("call", { result: textResult("members finished"), durationMs: 1 })
        const ended: SpawnGroupInfo = {
          ...active,
          state: "ended",
          agents: { ...active.agents, working: 0, ended: count },
        }
        event("group.update", { group: ended })
        event("group.end", { group: ended })
        event("group.end", { group: ended })
        if (route === "live call") view.toolEnd("call", { result: textResult("finished"), durationMs: 1 })
        if (route === "on stop") view.stop()
        else {
          view.turnEnd()
          view.render()
        }
        expect(screen.mainText).toContain(`workflow demo · ${scenario.summary}`)
        expect(screen.mainText.match(/workflow demo/g)).toHaveLength(1)
        expect(screen.mainText).not.toContain(" ended")
      } finally {
        view.stop()
      }
    })
  }
}

test("inline nested compact groups keep resumed history and settle after their parent leaves", () => {
  const { view, screen, event, group, start } = setup()
  try {
    view.openSession({ resumed: true }, [userMessage("Restored prompt")], true)
    event("group.start", { group })
    start("parent")
    const nested: SpawnGroupInfo = {
      ...group,
      id: "nested",
      name: "nested workflow",
      parentSessionId: "parent",
      agents: { ...group.agents, total: 1, working: 1 },
    }
    event("group.start", { group: nested }, "parent")
    start("nested member", nested)
    view.render()
    expect(screen.text).toContain("Restored prompt")
    expect(screen.text.match(/workflow demo/g)).toHaveLength(1)
    expect(screen.text.match(/nested workflow/g)).toHaveLength(1)
    expect(screen.text).toMatch(/ {4}└ .*nested workflow/)
    event("subagent.end", { childSessionId: "parent", status: "error", usage: emptyUsage(), durationMs: 1 })
    event(
      "subagent.end",
      { childSessionId: "nested member", status: "error", usage: emptyUsage(), durationMs: 1 },
      "parent",
    )
    const terminal: SpawnGroupInfo = {
      ...nested,
      state: "ended",
      agents: { ...nested.agents, working: 0, ended: 1 },
      outcomes: { done: 0, failed: 1, stopped: 0 },
    }
    expect(event("group.update", { group: terminal }, "parent")).toBe(true)
    expect(event("group.end", { group: terminal }, "parent")).toBe(true)
    event("group.end", {
      group: {
        ...group,
        state: "ended",
        agents: { ...group.agents, working: 0, ended: 2 },
        outcomes: { done: 0, failed: 2, stopped: 0 },
      },
    })
    view.render()
    view.openOverlay()
    view.renderOverlay()
    view.closeOverlay()
    view.render()
    expect(screen.mainText).toContain("Restored prompt")
    expect(screen.mainText).toContain("nested workflow · 1 failed")
    expect(screen.mainText).toContain("workflow demo · 2 failed")
    expect(screen.mainText.match(/nested workflow/g)).toHaveLength(1)
    expect(screen.mainText.match(/workflow demo/g)).toHaveLength(1)
    view.stop()
    expect(screen.mainText).toContain("nested workflow · 1 failed")
  } finally {
    view.stop()
  }
})

test("inline legacy compact groups leave unobserved terminal outcomes neutral", () => {
  const { view, screen, event, group, start } = setup()
  try {
    const { outcomes: _outcomes, ...legacy } = group
    event("group.start", { group: legacy })
    start("known", legacy)
    start("unknown", legacy)
    event("subagent.end", {
      childSessionId: "known",
      status: "done",
      note: "Stopped",
      usage: emptyUsage(),
      durationMs: 1,
    })
    event("group.end", {
      group: { ...legacy, state: "ended", agents: { ...legacy.agents, working: 0, ended: 2 } },
    })
    view.render()
    expect(screen.mainText).toContain("workflow demo · 1 stopped · 1 ended")
    expect(screen.mainText).not.toContain("done")
  } finally {
    view.stop()
  }
})

test("inline nested legacy groups retain ancestor outcomes after parent rows leave", () => {
  const { view, screen, event, group, start } = setup()
  try {
    const { outcomes: _outcomes, ...legacy } = group
    event("group.start", { group: legacy })
    start("parent", legacy)
    const nested: SpawnGroupInfo = {
      ...legacy,
      id: "nested",
      name: "nested workflow",
      parentSessionId: "parent",
      agents: { ...legacy.agents, total: 1, working: 1 },
    }
    event("group.start", { group: nested }, "parent")
    start("child", nested)
    event("subagent.end", { childSessionId: "parent", status: "error", usage: emptyUsage(), durationMs: 1 })
    event(
      "subagent.end",
      { childSessionId: "child", status: "done", note: "Stopped", usage: emptyUsage(), durationMs: 1 },
      "parent",
    )
    for (const info of [nested, legacy])
      event(
        "group.end",
        {
          group: {
            ...info,
            state: "ended",
            agents: { ...info.agents, working: 0, ended: info.agents.total },
          },
        },
        info.parentSessionId,
      )
    view.stop()
    expect(screen.mainText).toContain("nested workflow · 1 stopped")
    expect(screen.mainText).toContain("workflow demo · 1 failed · 1 stopped")
    expect(screen.mainText.match(/workflow demo/g)).toHaveLength(1)
    expect(screen.mainText.match(/nested workflow/g)).toHaveLength(1)
  } finally {
    view.stop()
  }
})

test("a terminal compact snapshot removes stale working rows and stops spinner redraws", async () => {
  const { view, screen, event, group, start, spinner } = setup()
  const tick = spyOn(spinner, "tick")
  try {
    event("group.start", { group })
    start("one")
    start("two")
    view.render()
    // A final snapshot is definitive even if a legacy source omits the individual end events.
    event("group.end", {
      group: {
        ...group,
        state: "ended",
        agents: { ...group.agents, working: 0, ended: 2 },
        outcomes: { done: 0, failed: 0, stopped: 2 },
      },
    })
    view.render()
    expect(screen.text).toContain("workflow demo · 2 stopped")
    expect(screen.text).not.toContain("working")
    expect(screen.text).not.toContain("in the background")
    tick.mockClear()
    await Bun.sleep(Spinner.INTERVAL_MS * 2 + 20)
    expect(tick).not.toHaveBeenCalled()
  } finally {
    view.stop()
    tick.mockRestore()
  }
})

for (const boundary of ["tool before snapshot", "dropped turn", "session switch", "view stops"] as const) {
  test(`inline compact failure survives a ${boundary} boundary`, () => {
    const { view, screen, event, group, start } = setup()
    try {
      view.toolStart("call", "agent", {}, 0)
      event("group.start", { group })
      start("one", group, "call")
      start("two", group, "call")
      for (const childSessionId of ["one", "two"])
        event("subagent.end", { childSessionId, status: "error", usage: emptyUsage(), durationMs: 1 })
      if (boundary === "tool before snapshot")
        view.toolEnd("call", { result: textResult("members finished"), durationMs: 1 })
      event("group.end", {
        group: {
          ...group,
          state: "ended",
          agents: { ...group.agents, working: 0, ended: 2 },
          outcomes: { done: 0, failed: 2, stopped: 0 },
        },
      })
      if (boundary === "session switch") view.leaveSession()
      else if (boundary !== "view stops") view.turnEnd()
      view.render()
      expect(screen.text).toContain("workflow demo · 2 failed")
      expect(screen.text.match(/workflow demo/g)).toHaveLength(1)
      expect(screen.text).not.toContain("working")
      expect(screen.text).not.toContain("running in background")
      view.stop()
      expect(screen.mainText).toContain("workflow demo · 2 failed")
    } finally {
      view.stop()
    }
  })
}
