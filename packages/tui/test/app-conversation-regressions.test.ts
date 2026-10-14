import { expect, test } from "bun:test"
import { closeImageApp, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

const F6 = "\x1b[17~"

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: dropped main steering restores only into the main draft`, async () => {
    const s = await focusFixture(mode)
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "focus")
      s.terminal.send("Owned draft")
      await waitFor(() => s.live().includes("│›Owned draft"), "owned draft")
      s.bus.emit(
        "turn.steer",
        { message: { role: "user", content: [{ type: "text", text: "Main steering" }] }, state: "dropped" },
        { sessionId: s.agent.sessionId },
      )
      await s.bus.flush()
      await Bun.sleep(30)
      expect(s.live()).toContain("│›Owned draft")
      expect(s.live()).not.toContain("Main steering")
      s.terminal.send(F6)
      await waitFor(() => s.live().includes("│›Main steering"), "main recovery")
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      await waitFor(() => s.live().includes("│›Owned draft"), "owned draft preserved")
    } finally {
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  for (const returnBeforeFailure of [false, true]) {
    test(`${mode}: failed owned send preserves the newer draft, returned=${returnBeforeFailure}`, async () => {
      const s = await focusFixture(mode)
      const pending = Promise.withResolvers<void>()
      s.conversation.send = () => pending.promise
      try {
        s.terminal.send("/design\r")
        await waitFor(() => s.live().includes("Design · fixture"), "focus")
        s.terminal.send("Failed prompt\rNew draft")
        await waitFor(() => s.live().includes("│›New draft"), "newer draft")
        if (returnBeforeFailure) s.terminal.send(F6)
        pending.reject(new Error("Failed owned send"))
        await Bun.sleep(50)
        if (returnBeforeFailure) expect(s.context().focusConversation?.(s.conversation)).toBe(true)
        await waitFor(() => s.live().includes("│›New draft"), "preserved newer draft")
        expect(s.live()).not.toContain("│›Failed prompt")
      } finally {
        pending.resolve()
        s.context()?.unfocusConversation?.()
        await s.conversation.release()
        await closeImageApp(s)
      }
    })
  }

  for (const key of ["\r", "\x1b", "\x03", "\x1bc"]) {
    test(`${mode}: released accessors during delayed cleanup return safely, key=${JSON.stringify(key)}`, async () => {
      const s = await focusFixture(mode)
      try {
        s.terminal.send("/design\r")
        await waitFor(() => s.live().includes("Design · fixture"), "focus")
        s.terminal.send("Unsent owned draft")
        await waitFor(() => s.live().includes("│›Unsent owned draft"), "draft")
        // Production release invalidates accessors before its iterator finishes draining.
        s.conversation.status = () => {
          throw new Error("released")
        }
        s.conversation.history = () => {
          throw new Error("released")
        }
        s.terminal.send(key)
        await waitFor(() => !s.live().includes("main idle"), "safe main return")
        expect(s.context().focusConversation?.(s.conversation)).toBe(false)
        expect(s.agent.messages).toHaveLength(2)
      } finally {
        s.context()?.unfocusConversation?.()
        await s.conversation.release()
        await closeImageApp(s)
      }
    })
  }
}
