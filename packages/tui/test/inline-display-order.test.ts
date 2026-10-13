import { expect, test } from "bun:test"
import type { ToolDetailLevel } from "@amira/api"
import { FakeTerminal, Spinner } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { createInlineView } from "../src/inline-view.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"

for (const suspended of [false, true]) {
  for (const margin of [0, 3]) {
    test(`inline display order and identity survive overlay=${suspended}, margin=${margin}`, () => {
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
        settings: { margin, marginRows: 0 },
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
      const output = () =>
        [...screen.scrollback, ...screen.lines].flatMap((line) => {
          for (const text of [
            "same head",
            "intervening output",
            "first details",
            "second details",
            "after",
          ]) {
            if (line.includes(text)) return [text]
          }
          return []
        })
      try {
        view.start()
        if (suspended) view.openOverlay()
        view.notice("info", "same head")
        view.notice("info", "intervening output")
        view.display("info", "same head", { details: "first details" })
        view.notice("info", "after")
        view.display("info", "same head", { details: "second details" })
        if (suspended) view.closeOverlay()
        view.render()
        const summary = ["same head", "intervening output", "same head", "after", "same head"]
        expect(output()).toEqual(summary)
        detail = "full"
        view.requestRender()
        view.render()
        expect(output()).toEqual([
          "same head",
          "intervening output",
          "same head",
          "first details",
          "after",
          "same head",
          "second details",
        ])
        const head = screen.lines.find((line) => line.includes("same head"))!
        expect(head.startsWith(" ".repeat(margin))).toBe(true)
        detail = "summary"
        view.requestRender()
        view.render()
        expect(output()).toEqual(summary)
      } finally {
        view.stop()
      }
    })
  }
}
