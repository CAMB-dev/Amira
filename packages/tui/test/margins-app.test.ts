import { expect, test } from "bun:test"
import { visibleWidth } from "@amira/tui-kit"
import { fakePayload } from "../../tui-kit/test/fake-images.ts"
import { setup, testCommands, waitFor } from "./app-harness.ts"

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: images use the content's left coordinate in the real app and exit printout`, async () => {
    const app = await setup([{ text: "before\n\n![chart](https://img.test/chart.png)\n\nafter" }], {
      cols: 70,
      rows: 30,
      settings: { mode, margin: 3, marginRows: 1 },
      env: { WT_SESSION: "1" },
      graphics: { answered: true, sixel: true, kitty: false },
      images: {
        id: "margin-image",
        open: async () => ({ width: 30, height: 40, encode: async (request) => fakePayload(request) }),
      },
    })
    try {
      app.terminal.send("draw\r")
      await app.shows("after")
      await app.idle()
      await waitFor(() => app.screen.images.length > 0, "margin image")
      expect(app.screen.images[0]).toMatchObject({ protocol: "sixel", col: 5, rows: 2, cols: 3 })
      if (mode === "fullscreen") {
        const y = app.screen.lines.findIndex((line) => line.includes("▓▓▓"))
        expect(app.screen.images[0]!.screenRow).toBe(y)
        expect(y).toBeGreaterThan(0)
        expect(y + 2).toBeLessThan(29)
      }
    } finally {
      app.terminal.send("\x03\x03")
      await app.exited
    }
    expect(app.screen.images.every((image) => image.col === 5)).toBe(true)
    for (const row of [...app.screen.scrollback, ...app.screen.lines]) {
      if (row) expect(row).toStartWith("   ")
      expect(visibleWidth(row)).toBeLessThanOrEqual(67)
    }
  })

  test(`${mode}: command popup and real bottom dialog stay within content columns`, async () => {
    const app = await setup([], {
      cols: 70,
      rows: 30,
      settings: { mode, margin: 3, marginRows: 1 },
      commands: testCommands([]),
    })
    const check = () => {
      for (const row of app.screen.lines) {
        if (row) expect(row).toStartWith("   ")
        expect(visibleWidth(row)).toBeLessThanOrEqual(67)
      }
    }
    try {
      app.terminal.send("/mo")
      await waitFor(() => app.live().includes("Switch the model"), "command popup")
      check()
      app.terminal.send("\r")
      await waitFor(() => app.live().includes("deepseek/deepseek-flash"), "model picker")
      check()
      app.terminal.send("\r")
      await app.shows("Model: deepseek/deepseek-flash")
      check()
    } finally {
      app.terminal.send("\x03\x03")
      await app.exited
    }
  })
}
