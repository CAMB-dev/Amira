import { expect, test } from "bun:test"
import type { ClipboardContent } from "../src/image-input.ts"
import { closeImageApp, userTexts, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: pending clipboard submission warns in the visible owned transcript and keeps its draft`, async () => {
    const pending = Promise.withResolvers<ClipboardContent>()
    let reading = false
    const s = await focusFixture(mode, [{ text: "Owned received" }], "/work/design", {
      clipboard: () => {
        reading = true
        return pending.promise
      },
    })
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("main idle"), "owned focus")
      s.terminal.send("OWNED_DRAFT\x1bv")
      await waitFor(() => reading, "clipboard still loading")
      s.terminal.send("\r")
      await s.shows("Clipboard paste is still loading")
      expect(s.live()).toContain("│›OWNED_DRAFT")
      expect(userTexts(s.agent)).toEqual(["Main history"])
      expect(userTexts(s.owned)).toEqual(["Design history"])
      pending.resolve({ type: "text", text: "_PASTE" })
      await waitFor(() => s.live().includes("│›OWNED_DRAFT_PASTE"), "loaded clipboard retains correct draft")
      s.terminal.send("\r")
      await waitFor(() => userTexts(s.owned).length === 2, "owned send after paste")
      expect(userTexts(s.owned)).toEqual(["Design history", "OWNED_DRAFT_PASTE"])
      expect(userTexts(s.agent)).toEqual(["Main history"])
    } finally {
      pending.resolve({ type: "empty" })
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })
}
