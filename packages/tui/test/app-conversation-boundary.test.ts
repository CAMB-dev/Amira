import { expect, test } from "bun:test"
import { closeImageApp, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

const F6 = "\x1b[17~"

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: context focus and F6 place named boundaries ahead of hidden conversation output`, async () => {
    const s = await focusFixture(mode)
    const design = "— design: Design · fixture —"
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("main idle"), "owned focus")
      const focused = mode === "inline" ? s.all() : s.live()
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
      let displayed = mode === "inline" ? s.all() : s.live()
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
      displayed = mode === "inline" ? s.all() : s.live()
      expect(displayed.lastIndexOf(design)).toBeLessThan(displayed.indexOf("Owned hidden boundary output"))
      expect(displayed).not.toContain(s.conversation.id)
      if (mode === "inline") {
        expect(displayed.split(design)).toHaveLength(3)
        expect(displayed.split("Main background boundary output")).toHaveLength(2)
        expect(displayed).not.toContain("Design history")
      } else expect(displayed).toContain("Design history")
      s.terminal.send(F6)
      await waitFor(() => !s.live().includes("main idle"), "second return")
    } finally {
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })
}
