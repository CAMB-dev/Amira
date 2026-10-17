import { expect, test } from "bun:test"
import { animationProbe } from "./animation-visibility-harness.ts"
import { closeImageApp, setup, waitFor } from "./app-harness.ts"

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: final app dock fitting stops all animation wakes and restarts on resize`, async () => {
    let writes = 0
    let state: "working" | "done" = "working"
    let requestRender = () => {}
    const app = await setup([], {
      rows: 32,
      settings: { mode },
      onWrite: () => writes++,
      extensions: [
        (api) => {
          requestRender = () => api.requestRender()
          api.registerView({
            kind: "fitted-badge",
            title: () => "Fitted badge",
            ui: (_data, opts) => ({
              type: "tree",
              id: "agents",
              items: [
                {
                  key: "child",
                  row: [...opts.statusBadge!(state), { kind: "text", text: " Fitted child" }],
                },
              ],
            }),
          })
          api.registerCommand({
            name: "fitted-badge",
            description: "Fixture",
            run: (_args, ctx) => {
              ctx.openView?.({ kind: "fitted-badge", placement: "dock", maxHeight: 8 })
            },
          })
        },
      ],
    })
    const probe = animationProbe()
    try {
      app.terminal.send("/fitted-badge\r")
      await waitFor(() => app.live().includes("working Fitted child"), "visible dock badge")
      expect(probe.sample().intervals).toBe(1)
      const visible = probe.sample()
      await Bun.sleep(1200)
      expect(probe.sample().wakes).toBeGreaterThan(visible.wakes)
      expect(probe.sample().requests).toBeGreaterThan(visible.requests)

      app.screen.resize(60, 5)
      app.terminal.setSize(60, 5)
      await Bun.sleep(160)
      expect(app.live()).not.toContain("Fitted child")
      const hidden = probe.sample()
      const hiddenWrites = writes
      await Bun.sleep(1200)
      expect(probe.sample()).toEqual({ ...hidden, intervals: 0 })
      expect(writes).toBe(hiddenWrites)

      app.screen.resize(60, 32)
      app.terminal.setSize(60, 32)
      await waitFor(() => app.live().includes("working Fitted child"), "restored dock badge")
      expect(probe.sample().intervals).toBe(1)
      const restored = probe.sample()
      await Bun.sleep(1200)
      expect(probe.sample().wakes).toBeGreaterThan(restored.wakes)
      expect(probe.sample().requests).toBeGreaterThan(restored.requests)
      state = "done"
      requestRender()
      await waitFor(() => app.live().includes("done Fitted child"), "finished badge")
      await Bun.sleep(160)
      const done = probe.sample()
      await Bun.sleep(1200)
      expect(probe.sample()).toEqual({ ...done, intervals: 0 })
    } finally {
      await closeImageApp(app)
      probe.restore()
    }
  }, 15000)
}
