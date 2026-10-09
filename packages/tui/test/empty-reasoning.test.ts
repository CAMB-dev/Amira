import { expect, test } from "bun:test"
import type { AssistantMessage, ToolDetailLevel } from "@amira/api"
import { FakeTerminal, Spinner } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { createFullscreenView } from "../src/fullscreen-view.ts"
import { createInlineView } from "../src/inline-view.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"

function setup(mode: "inline" | "fullscreen", detail: ToolDetailLevel) {
  const terminal = new FakeTerminal(100, 30)
  const screen = new VirtualScreen(100, 30)
  const write = terminal.write.bind(terminal)
  terminal.write = (data) => {
    write(data)
    screen.write(data)
  }
  const create = mode === "inline" ? createInlineView : createFullscreenView
  const view = create({
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
    sessionId: () => "s",
    detail: () => detail,
    bottom: () => ["input"],
    overlay: { render: () => [] },
    editorEmpty: () => true,
    showNote: () => {},
  })
  view.start()
  return { view, screen, text: () => screen.lines.join("\n") }
}

for (const mode of ["inline", "fullscreen"] as const) {
  for (const detail of ["summary", "full"] as const) {
    test(`${mode} ${detail}: an empty reasoning delta never creates a thinking row`, () => {
      const { view, screen, text } = setup(mode, detail)
      try {
        view.reasoningDelta("")
        expect(view.replyEnd([])).toBe(false)
        view.replyDelta("Answer.")
        view.replyEnd([])
        view.render()
        expect(text()).toContain("Answer.")
        expect(text()).not.toContain("Thought")
      } finally {
        view.stop()
      }
      expect(screen.mainText).not.toContain("Thought")
    })

    test(`${mode} ${detail}: saved omitted thinking stays invisible; redacted history stays unchanged`, () => {
      const { view, text } = setup(mode, detail)
      const message: AssistantMessage = {
        role: "assistant",
        model: { provider: "anth", model: "claude" },
        content: [
          { type: "thinking", text: "", signature: { dialect: "anthropic-messages", value: "sig" } },
          { type: "text", text: "Answer." },
        ],
      }
      try {
        view.openSession({ id: "s", resumed: true }, [message], true)
        view.render()
        expect(text()).toContain("Answer.")
        expect(text()).not.toContain("Thought")
        const redacted: AssistantMessage = {
          ...message,
          content: [
            {
              type: "thinking",
              text: "",
              redacted: true,
              signature: { dialect: "anthropic-messages", value: "sig" },
            },
            { type: "text", text: "Answer." },
          ],
        }
        view.openSession({ id: "s", resumed: true }, [redacted], true)
        view.render()
        expect(text()).toContain("Thought")
      } finally {
        view.stop()
      }
    })
  }
}
