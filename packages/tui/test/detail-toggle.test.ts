import { expect, test } from "bun:test"
import { setup, testCommands, waitFor } from "./app-harness.ts"

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: Ctrl+O leaves collapsed at summary; /verbose still cycles all three levels`, async () => {
    const app = await setup([], {
      commands: testCommands([]),
      tuiCommands: true,
      settings: { mode },
      cols: 120,
      rows: 40,
    })
    try {
      app.terminal.send("/verbose collapsed\r")
      await waitFor(() => app.live().includes("Tool output: collapsed"), "collapsed detail")
      app.terminal.send("\x0f")
      await waitFor(() => app.live().includes("Tool output: summary"), "key restores summary")
      expect(app.live()).toContain("ctrl+o toggles summary/full")
      const commandLevels = () =>
        [...app.all().matchAll(/› \/verbose\n +└ Tool output: (\w+)/g)].map((match) => match[1])
      for (const level of ["full", "collapsed", "summary"] as const) {
        const before = commandLevels().length
        app.terminal.send("/verbose\r")
        await waitFor(() => commandLevels().length > before, "command result")
        expect(commandLevels().at(-1)).toBe(level)
      }
    } finally {
      app.terminal.send("\x03\x03")
      expect(await app.exited).toBe(0)
    }
  })
}
