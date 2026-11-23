import { expect, spyOn, test } from "bun:test"
import { Spinner } from "@amira/tui-kit"
import { setup, waitFor } from "./app-harness.ts"

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: command animation sleeps when its row is clipped and restarts when visible`, async () => {
    let release = () => {}
    let started = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const app = await setup([], {
      cols: 60,
      rows: 5,
      settings: { mode },
      commands: [
        {
          name: "slow",
          description: "Fixture",
          run: async () => {
            started = true
            await gate
          },
        },
      ],
    })
    const tick = spyOn(Spinner.prototype, "tick")
    try {
      app.terminal.send("/slow\r")
      await waitFor(() => started, "command started")
      await Bun.sleep(150)
      expect(app.live()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \/slow/)
      const before = tick.mock.calls.length
      await Bun.sleep(Spinner.INTERVAL_MS * 3)
      expect(tick.mock.calls.length).toBe(before)
      app.screen.resize(60, 32)
      app.terminal.setSize(60, 32)
      await waitFor(() => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \/slow/.test(app.live()), "command row visible")
      const visible = tick.mock.calls.length
      await Bun.sleep(Spinner.INTERVAL_MS * 2)
      expect(tick.mock.calls.length).toBeGreaterThan(visible)
    } finally {
      tick.mockRestore()
      release()
      await Bun.sleep(30)
      app.terminal.send("\x03\x03")
      await app.exited
    }
  })

  test(`${mode}: a visible extension progress panel animates its spinner and adapts glyphs`, async () => {
    let release = () => {}
    let started = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const app = await setup([], {
      cols: 60,
      rows: 20,
      settings: { mode },
      commands: [
        {
          name: "extwork",
          description: "Fixture",
          run: async () => {
            started = true
            await gate
          },
        },
      ],
    })
    app.host.panels.register({
      id: "ext-progress-fixture",
      render: (opts) =>
        started ? [{ kind: "accent", text: `${opts.spinner ? `${opts.spinner} ` : ""}pkg · fetching` }] : [],
    })
    try {
      app.terminal.send("/extwork\r")
      await waitFor(() => started && app.live().includes("pkg · fetching"), "panel visible")
      const frame = () => app.live().match(/([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) pkg · fetching/)?.[1]
      const first = frame()
      expect(first).toBeDefined()
      await waitFor(() => frame() !== first, "panel spinner advances", 600)
    } finally {
      release()
      await Bun.sleep(30)
      app.terminal.send("\x03\x03")
      await app.exited
    }
  })
}
