import { expect, test } from "bun:test"
import { closeImageApp, inputImage, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

const F6 = "\x1b[17~"

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: main stays working and interrupt only stops the focused conversation`, async () => {
    const s = await focusFixture(mode, [
      { text: "Main keeps working", delayMs: 150 },
      { text: "Owned keeps working", delayMs: 500 },
    ])
    let main: Promise<unknown> | undefined
    try {
      main = s.agent.prompt("Background main")
      await waitFor(() => s.agent.status !== "idle", "main working")
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("main working"), "main working indicator")
      s.terminal.send("Owned prompt\r")
      await waitFor(() => s.owned.status !== "idle", "owned working")
      s.terminal.send("\x03")
      await waitFor(() => s.stops() === 1 && s.owned.status === "idle", "owned stop")
      expect(s.agent.status).not.toBe("idle")
      expect(s.live()).toContain("Design · fixture")
      await main
      await s.bus.flush()
      await waitFor(() => s.live().includes("main idle"), "main status completed")
      expect(s.owned.status).toBe("idle")
      s.terminal.send(F6)
      await s.shows("Main keeps working")
      s.mock.push({ text: "Another owned turn", delayMs: 500 })
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      s.terminal.send("Again\r")
      await waitFor(() => s.owned.status !== "idle", "second owned working")
      s.terminal.send("\x1b")
      await waitFor(() => s.stops() === 2 && s.owned.status === "idle", "Esc owned stop")
      expect(s.live()).toContain("Design · fixture")
    } finally {
      s.owned.abort()
      s.agent.abort()
      await main
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  test(`${mode}: main approval stays announced and focused questions use the normal dialog`, async () => {
    const s = await focusFixture(mode)
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "focus")
      const mainAnswer = s.host.ui.ask(
        { kind: "confirm", title: "Approve main operation?" },
        { source: "approval" },
      )
      await s.bus.flush()
      await waitFor(() => s.live().includes("1 pending"), "main pending indicator")
      expect(s.live()).not.toContain("Approve main operation?")
      const ownedAnswer = s.host.ui
        .api("test-owned")
        .ask([{ question: "Which design?", options: [{ label: "Simple" }, { label: "Detailed" }] }], {
          sessionId: s.conversation.id,
        })
      await s.bus.flush()
      await s.shows("Which design?")
      s.terminal.send("\r")
      expect(await ownedAnswer).toEqual([{ selected: ["Simple"] }])
      expect(s.live()).toContain("1 pending")
      s.terminal.send(F6)
      await s.shows("Approve main operation?")
      s.terminal.send("\x1b[B\r")
      expect(await mainAnswer).toBe(true)
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      await waitFor(() => s.live().includes("main idle"), "refocus")
      expect(s.live()).not.toContain("1 pending")
    } finally {
      s.host.ui.cancelAll()
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  test(`${mode}: image-only sends do not leak into the main history`, async () => {
    const s = await focusFixture(mode)
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "focus")
      s.terminal.send("\x1bv")
      await s.shows("[image 1: photo.png 68 B]")
      s.terminal.send("\r")
      await waitFor(
        () => s.owned.messages.some((m) => m.role === "user" && m.content.some((b) => b.type === "image")),
        "owned image send",
      )
      await s.ownedBus.flush()
      const message = s.owned.messages.findLast((m) => m.role === "user")!
      expect(message.content).toEqual([{ type: "image", ...inputImage() }])
      expect(s.mock.requests[0]?.messages.at(-1)?.content).toEqual([{ type: "image", ...inputImage() }])
      expect(
        s.agent.messages.some((m) => m.role === "user" && m.content.some((b) => b.type === "image")),
      ).toBe(false)
    } finally {
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })
}
