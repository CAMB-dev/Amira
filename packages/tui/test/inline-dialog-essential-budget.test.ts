import { expect, test } from "bun:test"
import { defineTool, textResult } from "@amira/api"
import { parallel, setup, waitFor } from "./app-harness.ts"

for (const [rows, toolCount] of [
  [7, 2],
  [8, 3],
] as const) {
  for (const cols of [50, 80, 120]) {
    for (const margin of [0, 3]) {
      test(`inline: pending dialog essentials precede ${toolCount} live tools at ${cols}x${rows}/${margin}`, async () => {
        const hold = Promise.withResolvers<void>()
        let started = 0
        const app = await setup(
          [
            { toolCalls: Array.from({ length: toolCount }, () => ({ name: "slow", args: {} })) },
            { text: "done" },
          ],
          { cols, rows, settings: { mode: "inline", margin, marginRows: 0 } },
        )
        app.agent.tools.register(
          defineTool({
            name: "slow",
            ...parallel,
            execute: async () => {
              started++
              await hold.promise
              return textResult("slow result")
            },
          }),
          "test",
        )
        let answer: Promise<string | undefined> | undefined
        const assertEssentials = (selected: string) => {
          const lines = app.screen.lines
          const title = lines.findIndex((row) => row.includes("Model"))
          expect(title).toBeGreaterThanOrEqual(0)
          expect(lines[title + 1]).toMatch(new RegExp(`› ?${selected}`))
          const footer = lines.findIndex((row) => row.includes("enter choose"))
          expect(footer).toBeGreaterThan(title + 1)
          expect(lines[footer]).toContain("esc cancel")
          expect(app.live()).toContain("slow")
          expect(app.agent.status).toBe("working")
        }
        try {
          app.terminal.send("go\r")
          await waitFor(() => started === toolCount && app.live().includes("slow"), "held live tools")
          answer = app.host.ui.api().select("Model", ["first", "second"])
          await waitFor(() => app.live().includes("enter choose"), "pending dialog footer")
          assertEssentials("1 first")
          app.terminal.send("\x1b[B")
          await waitFor(() => /› ?2 second/.test(app.live()), "second selected")
          assertEssentials("2 second")
          app.terminal.send("\r")
          expect(await answer).toBe("second")
          // With the dialog closed, restore room for the normal composer/tool transcript.
          app.screen.resize(cols, 24)
          app.terminal.setSize(cols, 24)
          app.terminal.send("next")
          await waitFor(() => app.live().includes("│›next"), "composer focus restored")
          expect(app.screen.y).toBe(app.screen.lines.findIndex((row) => row.includes("│›next")))
          expect(app.screen.lines.filter((row) => row.includes("slow"))).toHaveLength(toolCount)
          expect(app.agent.status).toBe("working")
        } finally {
          app.host.ui.cancelAll()
          if (answer) await answer
          hold.resolve()
          app.agent.abort()
          await app.idle()
          app.terminal.send("\x1b[27u\x03\x03")
          await app.exited
        }
      })
    }
  }
}
