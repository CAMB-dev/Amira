import { expect, test } from "bun:test"
import { userMessage } from "@amira/ai"
import { FakeTerminal, Spinner } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { createFullscreenView } from "../src/fullscreen-view.ts"
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
    capabilities: { win32InputMode: false, kittyKeyboard: true, synchronizedOutput: false, shiftEnter: true },
    settings: { margin: 0, marginRows: 0 },
    presenters: undefined,
    hyperlinks: false,
    renders: new ReplyRenderers(undefined),
    keys: new Keybindings(defaultKeys({ vscode: false })),
    spinner: new Spinner(),
    sessionId: () => sessionId,
    detail: () => "summary",
    bottom: () => ["conversation input"],
    overlay: { render: () => ["overlay"] },
    editorEmpty: () => true,
    showNote: () => {},
  })
  return { terminal, screen, host }
}

for (const [mode, create] of [["fullscreen", createFullscreenView]] as const) {
  test(`${mode}: activation names the destination before queued and background output, without replay`, () => {
    const { terminal, screen, host } = setup()
    const main = create(host("main-raw-id"))
    const owned = create(host("owned-raw-id"))
    try {
      main.openSession({ id: "main-raw-id", resumed: true }, [userMessage("main history")], false)
      main.start()
      main.setVisible(false)
      if (mode === "fullscreen") owned.openSession({ id: "owned-raw-id", resumed: true }, [], true)
      owned.notice("info", "owned queued output")
      owned.activate("— design: Design · fixture —")
      terminal.clearWrites()
      owned.start()
      expect(terminal.output).toContain("— design: Design · fixture —")
      expect(terminal.output).not.toContain("owned-raw-id")
      expect(screen.text.indexOf("— design:")).toBeLessThan(screen.text.indexOf("owned queued output"))

      main.notice("info", "main background output")
      main.render()
      main.notice("info", "main queued output")
      owned.setVisible(false)
      terminal.clearWrites()
      main.activate("— main —")
      expect(terminal.output).toBe("")
      main.setVisible(true)
      expect(screen.text).toContain("— main —")
      expect(terminal.output).not.toContain("main-raw-id")
      expect(screen.text.indexOf("— main —")).toBeLessThan(screen.text.indexOf("main background output"))
      expect(screen.text.indexOf("main background output")).toBeLessThan(
        screen.text.indexOf("main queued output"),
      )

      owned.notice("info", "owned hidden output")
      main.setVisible(false)
      screen.resize(80, 28)
      terminal.setSize(80, 28)
      terminal.clearWrites()
      owned.activate("— design: Renamed design —")
      expect(terminal.output).toBe("")
      owned.setVisible(true)
      expect(screen.text).toContain("— design: Renamed design —")
      expect(screen.text.indexOf("— design: Renamed design —")).toBeLessThan(
        screen.text.indexOf("owned hidden output"),
      )
      expect(terminal.output).not.toContain("owned-raw-id")
      expect(screen.text).not.toContain("— design: Design · fixture —")
      terminal.clearWrites()
      main.stop()
      expect(terminal.output).toBe("")
    } finally {
      main.stop()
      owned.stop()
    }
  })

  test(`${mode}: a stopped hidden view restarts with its named boundary after resize`, () => {
    const { terminal, screen, host } = setup()
    const view = create(host("raw-id"))
    try {
      view.start()
      view.setVisible(false)
      terminal.clearWrites()
      view.stop()
      expect(terminal.output).toBe("")
      screen.resize(80, 28)
      terminal.setSize(80, 28)
      view.activate("— main —")
      view.start()
      expect(terminal.output).toBe("")
      view.setVisible(true)
      expect(screen.text).toContain("— main —")
      expect(screen.text).toContain("conversation input")
    } finally {
      view.stop()
    }
  })
}
