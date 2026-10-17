import { expect, test } from "bun:test"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { closeImageApp, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: extension unload ends the focus subscription and returns to main`, async () => {
    let release = () => {}
    const s = await focusFixture(mode, [], "/work/design", {
      extensions: [
        (api) => {
          api.onUnload(() => release())
        },
      ],
    })
    release = () => {
      void s.conversation.release()
    }
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "focus")
      s.host.unloadAll()
      await waitFor(() => !s.live().includes("main idle"), "owner unload return")
      expect(s.context().focusConversation?.(s.conversation)).toBe(false)
      s.terminal.send("Main after unload\r")
      await s.idle()
      expect(
        s.agent.messages.some(
          (m) =>
            m.role === "user" && m.content.some((b) => b.type === "text" && b.text === "Main after unload"),
        ),
      ).toBe(true)
    } finally {
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  test(`${mode}: native return uses the remapped view-focus key`, async () => {
    const s = await focusFixture(mode, [], "/work/design", {
      keybindings: new Keybindings({ ...defaultKeys({ vscode: false }), "view.focus": ["alt+z"] }),
    })
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("alt+z main"), "remapped indicator")
      s.terminal.send("\x1b[17~")
      await Bun.sleep(30)
      expect(s.live()).toContain("Design · fixture")
      s.terminal.send("\x1bz")
      await waitFor(() => !s.live().includes("main idle"), "remapped return")
    } finally {
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  test(`${mode}: first focus during an owned stream recovers the authoritative complete reply`, async () => {
    const held = Promise.withResolvers<void>()
    const text = "prefix__complete design reply"
    const s = await focusFixture(mode, [{ text, hold: { chunks: 1, until: held.promise } }])
    let firstChunk = false
    const off = s.ownedBus.subscribe((event) => {
      if (event.type === "message.delta" && event.data.kind === "text") firstChunk = true
    })
    let turn: Promise<unknown> | undefined
    try {
      turn = s.conversation.send("Already running")
      await waitFor(() => firstChunk, "reply prefix before focus")
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "late focus")
      held.resolve()
      await turn
      await s.ownedBus.flush()
      await s.shows(text)
      const displayed = mode === "fullscreen" ? s.live() : s.all()
      expect(displayed.split(text)).toHaveLength(2)
      if (mode === "fullscreen") expect(displayed).not.toContain("Complete reply (earlier")
      else expect(displayed).toContain("Complete reply (earlier live output was partial):")
    } finally {
      held.resolve()
      s.owned.abort()
      await turn
      off()
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })
}
