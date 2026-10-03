import { expect, test } from "bun:test"
import { emptyUsage, userMessage } from "@amira/ai"
import type { AnyEvent, EventMap, SpawnGroupInfo, ToolDetailLevel } from "@amira/api"
import { EventBus } from "@amira/core"
import { FakeTerminal, type KeyEvent, Spinner } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { createFullscreenView } from "../src/fullscreen-view.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"

function setup(detail: ToolDetailLevel = "summary") {
  const terminal = new FakeTerminal(100, 30)
  const screen = new VirtualScreen(100, 30)
  const write = terminal.write.bind(terminal)
  terminal.write = (data) => {
    write(data)
    screen.write(data)
  }
  let sessionId = "old-session"
  const view = createFullscreenView({
    terminal,
    theme: plain.theme,
    capabilities: {
      win32InputMode: false,
      kittyKeyboard: true,
      synchronizedOutput: false,
      shiftEnter: true,
    },
    settings: {},
    presenters: undefined,
    hyperlinks: false,
    renders: new ReplyRenderers(undefined),
    keys: new Keybindings(defaultKeys({ vscode: false })),
    spinner: new Spinner(),
    sessionId: () => sessionId,
    detail: () => detail,
    bottom: () => ["input"],
    overlay: { render: () => [] },
    editorEmpty: () => true,
    showNote: () => {},
  })
  const key = (name: KeyEvent["name"], ctrl = false) =>
    view.handleInput({ type: "key", name, ctrl, alt: false, shift: false })
  const bus = new EventBus()
  const event = <K extends keyof EventMap>(type: K, data: EventMap[K], id = sessionId) =>
    view.subagentEvent(bus.emit(type, data, { sessionId: id }) as AnyEvent)
  view.banner("banner")
  view.start()
  return {
    view,
    screen,
    key,
    event,
    text: () => screen.lines.join("\n"),
    switchTo: (id: string) => {
      view.leaveSession()
      sessionId = id
    },
  }
}

for (const command of ["clear", "resume", "fork"]) {
  test(`${command}: fullscreen discards old sub-agent blocks, groups and event ownership`, () => {
    const { view, screen, event, text, switchTo } = setup()
    const group: SpawnGroupInfo = {
      id: "reused-group",
      name: "old workflow",
      parentSessionId: "old-session",
      state: "active",
      limits: {},
      compact: true,
      usage: emptyUsage(),
      tokens: 0,
      agents: { total: 1, working: 1, queued: 0, idle: 0, ended: 0 },
    }
    const child = (id: string): EventMap["subagent.start"] => ({
      childSessionId: id,
      groupId: group.id,
      prompt: "work",
      model: { provider: "mock", model: "m1" },
      depth: 1,
      cwd: "/work",
      context: "fresh",
      queued: false,
    })
    try {
      event("group.start", { group })
      event("subagent.start", child("old-child"))
      view.toolStart("reused-call", "old-call", {}, 0)
      view.render()
      expect(text()).toContain("old workflow")
      expect(text()).toContain("old-call")

      switchTo("new-session")
      const messages = command === "clear" ? [] : [userMessage("kept history")]
      view.openSession({ id: "new-session", resumed: messages.length > 0 }, messages, true)
      expect(
        event("subagent.state", { childSessionId: "old-child", state: "paused", turns: 1 }, "old-session"),
      ).toBe(false)
      expect(event("subagent.start", child("old-grandchild"), "old-child")).toBe(false)
      expect(event("group.update", { group: { ...group, status: "stale update" } }, "old-session")).toBe(
        false,
      )
      event("group.start", { group: { ...group, parentSessionId: "new-session", name: "new workflow" } })
      event("subagent.start", child("new-child"))
      view.toolStart("reused-call", "new-call", {}, 0)
      view.render()
      expect(text()).not.toContain("old workflow")
      expect(text()).not.toContain("old-call")
      expect(text()).not.toContain("stale update")
      expect(text()).toContain("new workflow")
      expect(text()).toContain("new-call")
      if (command !== "clear") expect(text()).toContain("kept history")
    } finally {
      view.stop()
    }
    expect(screen.mainText).not.toContain("old workflow")
    expect(screen.mainText).toContain("new workflow")
  })
}

test("find bar counts subsequent streamed text in the same frame without another keypress", async () => {
  const { view, key, text } = setup()
  try {
    view.replyDelta("needle")
    view.render()
    key("f", true)
    view.handleInput({ type: "paste", text: "needle" })
    view.render()
    expect(text()).toContain("1/1")
    view.replyDelta(" and another needle")
    // Keep streaming: live matches refresh on the pane's 250 ms stamp, not replyEnd's version bump.
    await Bun.sleep(275)
    view.render()
    expect(text()).toContain("1/2")
  } finally {
    view.stop()
  }
})

for (const detail of ["summary", "full"] as const) {
  test(`exit keeps manually ${detail === "summary" ? "unfolded" : "folded"} thinking`, () => {
    const { view, screen, key, text } = setup(detail)
    try {
      view.reasoningDelta("Thinking text to preserve.")
      view.replyEnd([])
      view.render()
      key("up", true)
      key("enter")
      view.render()
      expect(text().includes("Thinking text to preserve.")).toBe(detail === "summary")
    } finally {
      view.stop()
    }
    expect(screen.mainText.includes("Thinking text to preserve.")).toBe(detail === "summary")
  })
}
