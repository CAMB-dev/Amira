import { expect, test } from "bun:test"
import { closeImageApp, paste, userTexts, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

const F6 = "\x1b[17~"

for (const mode of ["fullscreen", "inline"] as const) {
  test(`${mode}: focus chrome uses a non-design conversation name`, async () => {
    const s = await focusFixture(mode, undefined, undefined, {}, "Acceptance · fixture")
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Acceptance · fixture"), "named focus")
      expect(s.all()).not.toContain("— design:")
      if (mode === "inline") expect(s.all()).toContain("— Acceptance · fixture —")
    } finally {
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  test(`${mode}: native focus routes input, recalls scoped history and returns with F6`, async () => {
    const s = await focusFixture(mode)
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "owned focus")
      expect(s.live()).toContain("main idle")
      if (mode === "fullscreen") {
        expect(s.live()).toContain("Design history")
        expect(s.live()).not.toContain("Main history")
      } else {
        expect(s.all()).toContain("— Design · fixture —")
        expect(s.all()).not.toContain("Design history")
      }
      s.terminal.send(`${paste("Design prompt")}\r`)
      await waitFor(() => userTexts(s.owned).includes("Design prompt"), "owned input")
      await s.ownedBus.flush()
      await s.shows("Main reply")
      expect(userTexts(s.agent)).toEqual(["Main history"])
      s.terminal.send("\x1b[A")
      await waitFor(() => s.live().includes("│ › Design prompt"), "owned recall")
      s.terminal.send(F6)
      await waitFor(() => !s.live().includes("main idle"), "return to main")
      if (mode === "fullscreen") expect(s.live()).toContain("Main history")
      else expect(s.all()).toContain("— main —")
      s.terminal.send("Main prompt\r")
      await s.idle()
      expect(userTexts(s.agent)).toEqual(["Main history", "Main prompt"])
      expect(userTexts(s.owned)).toEqual(["Design history", "Design prompt"])
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      await waitFor(() => s.live().includes("│ › Design prompt"), "owned draft restored")
      expect(s.context().unfocusConversation?.()).toBe(true)
      expect(s.context().unfocusConversation?.()).toBe(false)
    } finally {
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  test(`${mode}: slash commands are guarded, Esc returns and released handles restore main`, async () => {
    const s = await focusFixture(mode)
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "focus")
      s.terminal.send("/clear\r")
      await s.shows("Return to main")
      expect(s.all()).not.toContain("CLEARED MAIN")
      expect(userTexts(s.owned)).toEqual(["Design history"])
      s.terminal.send(F6)
      await waitFor(() => !s.live().includes("main idle"), "F6 return")
      s.terminal.send("\r")
      await s.shows("CLEARED MAIN")
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      s.terminal.send("\x1b")
      await waitFor(() => !s.live().includes("main idle"), "empty Esc return")
      expect(s.stops()).toBe(0)
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      s.screen.resize(120, 36)
      s.terminal.setSize(120, 36)
      await waitFor(() => s.live().includes("Design · fixture"), "resize focus")
      s.screen.resize(60, 24)
      s.terminal.setSize(60, 24)
      await waitFor(() => s.live().includes("main idle"), "narrow resize indicator")
      expect(s.live()).toContain("Design · fixture")
      await s.conversation.release()
      await waitFor(() => !s.live().includes("main idle"), "release return")
      expect(s.context().focusConversation?.(s.conversation)).toBe(false)
    } finally {
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })
}
