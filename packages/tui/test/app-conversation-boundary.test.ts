import { expect, test } from "bun:test"
import { closeImageApp, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

const F6 = "\x1b[17~"

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: context focus and F6 place named boundaries ahead of hidden conversation output`, async () => {
    const s = await focusFixture(mode)
    const design = "— Design · fixture —"
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("main idle"), "owned focus")
      const focused = s.live()
      expect(focused).toContain(design)
      expect(focused).not.toContain(s.conversation.id)
      s.bus.emit(
        "command.output",
        { command: "background", level: "info", text: "Main background boundary output" },
        { sessionId: s.agent.sessionId },
      )
      await s.bus.flush()
      s.terminal.send(F6)
      await s.shows("Main background boundary output")
      let displayed = s.live()
      expect(displayed).toContain("— main —")
      expect(displayed.lastIndexOf("— main —")).toBeLessThan(
        displayed.indexOf("Main background boundary output"),
      )
      s.ownedBus.emit(
        "command.output",
        { command: "background", level: "info", text: "Owned hidden boundary output" },
        { sessionId: s.conversation.id },
      )
      await s.ownedBus.flush()
      s.screen.resize(100, 30)
      s.terminal.setSize(100, 30)
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      await s.shows("Owned hidden boundary output")
      displayed = s.live()
      expect(displayed.lastIndexOf(design)).toBeLessThan(displayed.indexOf("Owned hidden boundary output"))
      expect(displayed).not.toContain(s.conversation.id)
      expect(displayed).toContain("Design history")
      s.terminal.send(F6)
      await waitFor(() => !s.live().includes("main idle"), "second return")
    } finally {
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })
}
