import { expect, test } from "bun:test"
import { closeImageApp, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

const F6 = "\x1b[17~"

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: F6 detaches an owned form and restores its pending dialog when refocused`, async () => {
    const s = await focusFixture(mode)
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "focus")
      const answer = s.host.ui.api("test-owned").form(
        {
          title: "Owned design form",
          fields: [{ type: "text", id: "name", label: "Design name" }],
        },
        { sessionId: s.conversation.id },
      )
      await s.shows("Owned design form")
      const request = s.host.ui.pending.find((r) => r.title === "Owned design form")!
      expect(request).toBeDefined()
      s.terminal.send(F6)
      await waitFor(() => !s.live().includes("Owned design form"), "main after form")
      expect(s.host.ui.requestState(request.requestId)).toBe("pending")
      s.terminal.send("Main after form\r")
      await s.idle()
      expect(
        s.agent.messages.some(
          (m) =>
            m.role === "user" && m.content.some((b) => b.type === "text" && b.text === "Main after form"),
        ),
      ).toBe(true)
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      await waitFor(() => s.live().includes("Owned design form"), "pending owned form restored")
      s.host.ui.cancel(request.requestId)
      expect(await answer).toBeUndefined()
      await waitFor(() => s.live().includes("Design · fixture"), "owned transcript restored")
      s.terminal.send("Usable owned composer")
      await waitFor(() => s.live().includes("│ › Usable owned composer"), "composer not stuck in overlay")
    } finally {
      s.host.ui.cancelAll()
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  test(`${mode}: F6 closes the owned key reference without trapping the main composer`, async () => {
    const s = await focusFixture(mode)
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "focus")
      s.terminal.send("?")
      await s.shows("Keys")
      s.terminal.send(F6)
      await waitFor(() => !s.live().includes("main idle"), "main after key reference")
      s.terminal.send("Main draft")
      await waitFor(() => s.live().includes("│ › Main draft"), "main composer usable")
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      s.terminal.send("Owned draft")
      await waitFor(() => s.live().includes("│ › Owned draft"), "owned composer usable")
    } finally {
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })
}
