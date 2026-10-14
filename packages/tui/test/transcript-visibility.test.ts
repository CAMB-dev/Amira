import { expect, test } from "bun:test"
import { userMessage } from "@amira/ai"
import { EventBus } from "@amira/core"
import { defaultGlyphs, FakeTerminal, modes, Spinner } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { createFullscreenView } from "../src/fullscreen-view.ts"
import { createInlineView } from "../src/inline-view.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"
import type { ViewHost } from "../src/view.ts"

function setup() {
  const terminal = new FakeTerminal(100, 30)
  const screen = new VirtualScreen(100, 30)
  const write = terminal.write.bind(terminal)
  terminal.write = (data) => {
    write(data)
    screen.write(data)
  }
  const host = (sessionId: string): ViewHost => ({
    terminal,
    theme: plain.theme,
    capabilities: {
      win32InputMode: false,
      kittyKeyboard: true,
      synchronizedOutput: false,
      shiftEnter: true,
    },
    settings: { margin: 0, marginRows: 0 },
    presenters: undefined,
    hyperlinks: false,
    renders: new ReplyRenderers(undefined),
    keys: new Keybindings(defaultKeys({ vscode: false })),
    spinner: new Spinner(),
    sessionId: () => sessionId,
    detail: () => "summary",
    bottom: () => [`${sessionId} input`],
    overlay: { render: () => [`${sessionId} overlay`] },
    editorEmpty: () => true,
    showNote: () => {},
  })
  return { terminal, screen, host }
}

for (const [mode, create] of [
  ["inline", createInlineView],
  ["fullscreen", createFullscreenView],
] as const) {
  test(`${mode}: retained conversations hold background output and only the visible view draws`, async () => {
    const { terminal, screen, host } = setup()
    const main = create(host("main"))
    const owned = create(host("owned"))
    try {
      main.user(userMessage("main history"))
      main.start()
      main.setVisible(false)
      owned.user(userMessage("owned history"))
      owned.start()
      terminal.clearWrites()
      main.notice("info", "main background output")
      main.render()
      main.redraw()
      main.requestRender()
      main.setTheme(plain.theme, defaultGlyphs)
      terminal.setSize(90, 28)
      owned.render()
      terminal.clearWrites()
      await Bun.sleep(40)
      expect(terminal.output).toBe("")
      expect(screen.text).toContain("owned input")
      expect(screen.text).not.toContain("main background output")

      owned.setVisible(false)
      terminal.clearWrites()
      main.setVisible(true)
      expect(screen.text).toContain("main input")
      expect(screen.text).toContain("main background output")
      if (mode === "inline") expect(terminal.output).not.toContain("main history")
      else expect(screen.text).toContain("main history")
      expect(terminal.output).not.toContain(modes.altScreen.off)

      // Pausing and resuming the same views again never replays old inline commits.
      main.setVisible(false)
      owned.setVisible(true)
      owned.setVisible(false)
      terminal.clearWrites()
      main.setVisible(true)
      if (mode === "inline") {
        expect(terminal.output).not.toContain("main history")
        expect(terminal.output).not.toContain("main background output")
      }
      terminal.clearWrites()
      owned.stop()
      expect(terminal.output).toBe("")
      expect(screen.inAltScreen).toBe(mode === "fullscreen")
    } finally {
      owned.stop()
      main.stop()
    }
    if (mode === "fullscreen") {
      expect(screen.inAltScreen).toBe(false)
      expect(screen.mainText).toContain("main history")
      expect(screen.mainText).not.toContain("owned history")
    }
  })

  test(`${mode}: a hidden view can start and close overlays without drawing`, () => {
    const { terminal, screen, host } = setup()
    const main = create(host("main"))
    const owned = create(host("owned"))
    try {
      main.start()
      terminal.clearWrites()
      owned.setVisible(false)
      owned.start()
      owned.notice("info", "held output")
      owned.openOverlay(true)
      owned.renderOverlay()
      owned.closeOverlay()
      owned.render()
      expect(terminal.output).toBe("")
      expect(screen.text).toContain("main input")
      owned.stop()
      expect(terminal.output).toBe("")
    } finally {
      owned.stop()
      main.stop()
    }
  })

  test(`${mode}: hiding pauses sub-agent ticks and showing resumes them`, async () => {
    const { terminal, host } = setup()
    const viewHost = host("main")
    let ticks = 0
    viewHost.spinner.tick = () => {
      ticks++
    }
    const view = create(viewHost)
    const bus = new EventBus()
    try {
      view.start()
      view.subagentEvent(
        bus.emit(
          "subagent.start",
          {
            childSessionId: "child",
            prompt: "work",
            model: { provider: "mock", model: "m1" },
            depth: 1,
            cwd: "/work",
            context: "fresh",
            queued: false,
          },
          { sessionId: "main" },
        ),
      )
      view.setVisible(false)
      terminal.clearWrites()
      await Bun.sleep(Spinner.INTERVAL_MS * 2)
      expect(ticks).toBe(0)
      expect(terminal.output).toBe("")
      view.setVisible(true)
      await Bun.sleep(Spinner.INTERVAL_MS * 2)
      expect(ticks).toBeGreaterThan(0)
    } finally {
      view.stop()
    }
  })
}
