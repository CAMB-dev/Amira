import { expect, test } from "bun:test"
import { visibleWidth } from "@amira/tui-kit"
import { closeImageApp, setup, testCommands, waitFor } from "./app-harness.ts"

for (const mode of ["fullscreen"] as const) {
  for (const [cols, rows] of [
    [7, 30],
    [8, 30],
    [60, 6],
    [60, 30],
  ] as const) {
    test(`${mode}: popup follows the composer's framed or bare text column at ${cols}x${rows}`, async () => {
      const app = await setup([], {
        cols,
        rows,
        settings: { mode },
        commands: [{ name: "go", description: "", run: () => {} }],
      })
      try {
        app.terminal.send("/g")
        await waitFor(() => app.live().includes("/go"), "command candidate")
        const framed = cols >= 8 && rows >= 10
        const option = app.screen.lines.find((row) => row.includes("/go"))!
        expect(option.indexOf("/go")).toBe(framed ? 4 : 2)
        expect(app.screen.lines.some((row) => row.startsWith("│ › /g"))).toBe(framed)
        expect(app.screen.lines.every((row) => visibleWidth(row) <= cols)).toBe(true)
      } finally {
        await closeImageApp(app)
      }
    })
  }

  test(`${mode}: command usage, no-match text and history search follow the padded text column`, async () => {
    const app = await setup([], { settings: { mode }, commands: testCommands([]) })
    try {
      app.terminal.send("/help ")
      await waitFor(() => app.live().includes("/help  List"), "command usage")
      expect(app.screen.lines.find((row) => row.includes("/help  List"))!.indexOf("/help")).toBe(4)
      app.terminal.send("\x15/nothing-matches")
      await waitFor(() => app.live().includes("no command matches"), "no matches")
      expect(app.screen.lines.find((row) => row.includes("no command matches"))!.indexOf("no command")).toBe(
        4,
      )
      app.terminal.send("\x15\x12")
      await waitFor(() => app.live().includes("search history"), "history search")
      expect(app.screen.lines.find((row) => row.includes("search history"))!.indexOf("search history")).toBe(
        4,
      )
    } finally {
      await closeImageApp(app)
    }
  })
}
