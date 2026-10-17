import { expect, spyOn, test } from "bun:test"
import { Spinner } from "@amira/tui-kit"
import { setup, waitFor } from "./app-harness.ts"

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: short dialogs keep essential rows while only visible working badges animate`, async () => {
    const app = await setup([], {
      cols: 50,
      rows: 7,
      settings: { mode, margin: 3, marginRows: 0 },
    })
    let status: "done" | "working" | "paused" = "done"
    const tick = spyOn(Spinner.prototype, "tick")
    const answer = app.host.ui.api().choose("Model", ["Task"], {
      sections: [],
      live: () => ({ optionStatuses: [status] }),
    })
    const assertEssentials = () => {
      const title = app.screen.lines.findIndex((row) => row.includes("Model"))
      expect(title).toBeGreaterThanOrEqual(0)
      expect(app.screen.lines[title + 1]).toContain("Task")
      const footer = app.screen.lines.findIndex((row) => row.includes("enter choose"))
      expect(footer).toBeGreaterThan(title + 1)
      expect(app.screen.lines[footer]).toContain("esc cancel")
    }
    const update = async (next: typeof status) => {
      status = next
      app.bus.emit(
        "subagent.state",
        { childSessionId: "fixture", state: "idle", turns: 1 },
        { sessionId: app.agent.sessionId },
      )
      await waitFor(() => app.live().includes(next), `dialog state ${next}`)
      await Bun.sleep(100)
      assertEssentials()
    }
    try {
      await waitFor(() => app.live().includes("enter choose"), "dialog footer")
      await update("done")
      const done = tick.mock.calls.length
      await Bun.sleep(180)
      expect(tick.mock.calls.length).toBe(done)
      await update("working")
      const working = tick.mock.calls.length
      await Bun.sleep(180)
      expect(tick.mock.calls.length).toBeGreaterThan(working)
      await update("paused")
      const paused = tick.mock.calls.length
      await Bun.sleep(180)
      expect(tick.mock.calls.length).toBe(paused)
      assertEssentials()
    } finally {
      tick.mockRestore()
      app.host.ui.cancelAll()
      await answer
      app.terminal.send("\x1b[27u\x03\x03")
      await app.exited
    }
  })
}
