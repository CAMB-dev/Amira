import { expect, test } from "bun:test"
import { ALT_ENTER, closeImageApp, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

const F6 = "\x1b[17~"

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: real queued main and background owned replies drain after their activation divider`, async () => {
    const mainGate = Promise.withResolvers<void>()
    const ownedGate = Promise.withResolvers<void>()
    const s = await focusFixture(
      mode,
      [
        { text: "MAIN_BACKGROUND_REPLY", hold: { chunks: 1, until: mainGate.promise } },
        { text: "MAIN_QUEUED_REPLY" },
        { text: "OWNED_BACKGROUND_REPLY", hold: { chunks: 1, until: ownedGate.promise } },
      ],
      "/work/design",
      { cols: 120, rows: 36 },
    )
    let mainChunk = false
    let ownedChunk = false
    const offMain = s.bus.subscribe((event) => {
      if (event.type === "message.delta" && event.data.kind === "text") mainChunk = true
    })
    const offOwned = s.ownedBus.subscribe((event) => {
      if (event.type === "message.delta" && event.data.kind === "text") ownedChunk = true
    })
    try {
      s.terminal.send("Main running\r")
      await waitFor(() => mainChunk, "main streamed prefix")
      s.terminal.send(`Main queued${ALT_ENTER}`)
      await s.shows("queued")
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("main working"), "focus while main runs")
      mainGate.resolve()
      await waitFor(
        () => s.mock.requests.length === 2 && s.agent.status === "idle",
        "queued main finished in background",
      )
      await s.bus.flush()
      s.terminal.send(F6)
      await s.shows("MAIN_QUEUED_REPLY")
      const main = s.live()
      expect(main).toContain("MAIN_BACKGROUND_REPLY")
      expect(main.lastIndexOf("— main —")).toBeLessThan(main.indexOf("MAIN_BACKGROUND_REPLY"))
      expect(main.indexOf("MAIN_BACKGROUND_REPLY")).toBeLessThan(main.indexOf("MAIN_QUEUED_REPLY"))
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("main idle"), "owned refocus")
      s.terminal.send("Owned running\r")
      await waitFor(() => ownedChunk, "owned prefix")
      s.terminal.send(F6)
      ownedGate.resolve()
      await waitFor(() => s.owned.status === "idle", "owned finished while hidden")
      await s.ownedBus.flush()
      s.terminal.send("/design\r")
      await s.shows("OWNED_BACKGROUND_REPLY")
      const owned = s.live()
      expect(owned.lastIndexOf("— design: Design · fixture —")).toBeLessThan(
        owned.indexOf("OWNED_BACKGROUND_REPLY"),
      )
      expect(owned.split("OWNED_BACKGROUND_REPLY")).toHaveLength(2)
    } finally {
      mainGate.resolve()
      ownedGate.resolve()
      s.agent.abort()
      s.owned.abort()
      offMain()
      offOwned()
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })
}
