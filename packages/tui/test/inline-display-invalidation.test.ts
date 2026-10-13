import { expect, test } from "bun:test"
import type { ToolDetailLevel } from "@amira/api"
import { defaultGlyphs, FakeTerminal, Spinner } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { createInlineView } from "../src/inline-view.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"

for (const change of ["detail", "theme"] as const) {
  test(`inline semantic history retains ${change} invalidation while covered by an overlay`, () => {
    const terminal = new FakeTerminal(80, 40)
    const screen = new VirtualScreen(80, 40)
    const write = terminal.write.bind(terminal)
    terminal.write = (data) => {
      write(data)
      screen.write(data)
    }
    let detail: ToolDetailLevel = "summary"
    const view = createInlineView({
      terminal,
      theme: plain.theme,
      capabilities: {
        win32InputMode: false,
        kittyKeyboard: true,
        synchronizedOutput: false,
        shiftEnter: true,
      },
      settings: { margin: 3, marginRows: 0 },
      presenters: undefined,
      hyperlinks: false,
      renders: new ReplyRenderers(undefined),
      keys: new Keybindings(defaultKeys({ vscode: false })),
      spinner: new Spinner(),
      sessionId: () => "session",
      detail: () => detail,
      bottom: () => ["input"],
      overlay: { render: () => ["cover"] },
      editorEmpty: () => true,
      showNote: () => {},
    })
    try {
      view.start()
      view.display("info", "head", { details: "expanded details" })
      view.render()
      expect(screen.text).toContain("head")
      expect(screen.text).not.toContain("expanded details")
      view.openOverlay()
      if (change === "detail") {
        detail = "full"
        view.requestRender()
      } else {
        view.setTheme({ ...plain.theme, muted: (text) => `changed ${text}` }, defaultGlyphs)
      }
      view.closeOverlay()
      view.render()
      expect(screen.text).toContain(change === "detail" ? "expanded details" : "changed head")
      view.requestRender()
      view.render()
      expect(screen.text).toContain(change === "detail" ? "expanded details" : "changed head")
    } finally {
      view.stop()
    }
  })
}
