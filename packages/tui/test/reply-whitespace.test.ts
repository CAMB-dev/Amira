import { expect, spyOn, test } from "bun:test"
import { FakeTerminal, Spinner } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { localClock } from "../src/format.ts"
import { createFullscreenView } from "../src/fullscreen-view.ts"
import { createInlineView } from "../src/inline-view.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"

function setup(mode: "inline" | "fullscreen") {
  const terminal = new FakeTerminal(80, 30)
  const screen = new VirtualScreen(80, 30)
  const write = terminal.write.bind(terminal)
  terminal.write = (data) => {
    write(data)
    screen.write(data)
  }
  const view = (mode === "inline" ? createInlineView : createFullscreenView)({
    terminal,
    theme: plain.theme,
    capabilities: { win32InputMode: false, kittyKeyboard: true, synchronizedOutput: false, shiftEnter: true },
    settings: { margin: 0, marginRows: 0 },
    presenters: undefined,
    hyperlinks: false,
    renders: new ReplyRenderers(undefined),
    keys: new Keybindings(defaultKeys({ vscode: false })),
    spinner: new Spinner(),
    sessionId: () => "s",
    detail: () => "summary",
    bottom: () => ["input"],
    overlay: { render: () => [] },
    editorEmpty: () => true,
    showNote: () => {},
  })
  view.start()
  return { view, screen, text: () => screen.lines.join("\n") }
}

const at = new Date(2026, 9, 10, 20, 9, 58).getTime()
const fence = "```ts\n    const answer = 42\n    ```"

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: leading whitespace preserves indented fence rendering across source chunking`, () => {
    const clock = spyOn(Date, "now").mockReturnValue(at)
    const render = (chunks: string[]) => {
      const { view, screen, text } = setup(mode)
      try {
        for (const chunk of chunks) {
          view.replyDelta(chunk)
          view.render()
        }
        expect(view.replyEnd([])).toBe(true)
        view.render()
        const shown = text()
        view.stop()
        return { shown, printed: screen.mainText }
      } finally {
        view.stop()
      }
    }
    try {
      const together = render([`    ${fence}`])
      expect(together.shown).toContain("  │ const answer = 42")
      expect(render(["  ", "  ", fence])).toEqual(together)
    } finally {
      clock.mockRestore()
    }
  })

  test(`${mode}: pending whitespace creates no rows, claims no clock and does not end thinking`, () => {
    const clock = spyOn(Date, "now").mockReturnValue(at)
    const { view, text } = setup(mode)
    try {
      const empty = text()
      view.replyDelta(" \n  ")
      view.render()
      expect(text()).toBe(empty)
      expect(view.replyEnd([])).toBe(false)
      view.reasoningDelta("Consider this.")
      view.render()
      clock.mockReturnValue(at + 4000)
      view.replyDelta("    ")
      view.render()
      expect(text()).toContain("Thinking")
      expect(text()).not.toContain("Thought for")
      expect(text()).not.toContain(localClock(at + 4000))
      view.replyDelta(fence)
      view.replyEnd([])
      view.render()
      expect(text()).toContain("  │ const answer = 42")
      expect(text()).toContain("Thought for 4s")
    } finally {
      view.stop()
      clock.mockRestore()
    }
  })

  test(`${mode}: whitespace after renewed reasoning waits for substantive reply text`, () => {
    const clock = spyOn(Date, "now").mockReturnValue(at)
    const { view, text } = setup(mode)
    try {
      view.replyDelta("Initial answer.\n\n")
      view.render()
      clock.mockReturnValue(at + 1000)
      view.reasoningDelta("Consider this again.")
      view.render()
      clock.mockReturnValue(at + 5000)
      view.replyDelta("    ")
      view.render()
      expect(text()).toContain("Initial answer.")
      expect(text()).toContain("Thinking")
      expect(text()).not.toContain("Thought for")

      clock.mockReturnValue(at + 7000)
      view.replyDelta(fence)
      expect(view.replyEnd([])).toBe(true)
      view.render()
      expect(text()).toContain("Thought for 6s")
      expect(text()).toContain("  │ const answer = 42")
    } finally {
      view.stop()
      clock.mockRestore()
    }
  })

  for (const reset of ["replyEnd", "turnEnd", "leaveSession", "openSession"] as const) {
    test(`${mode}: ${reset} discards whitespace from an unfinished empty reply`, () => {
      const clock = spyOn(Date, "now").mockReturnValue(at)
      const { view, text } = setup(mode)
      try {
        view.replyDelta("    ")
        if (reset === "replyEnd") expect(view.replyEnd([])).toBe(false)
        else if (reset === "turnEnd") view.turnEnd()
        else if (reset === "leaveSession") view.leaveSession()
        else view.openSession({ id: "new", resumed: false }, [], true)
        view.replyDelta(fence)
        view.replyEnd([])
        view.render()
        expect(text()).toContain("  │     const answer = 42")
      } finally {
        view.stop()
        clock.mockRestore()
      }
    })
  }
}
