import { expect, test } from "bun:test"
import { closeImageApp, paste, setup, waitFor } from "./app-harness.ts"

for (const cols of [40, 24]) {
  test(`inline: a long answered input leaves the next question visible at ${cols} columns`, async () => {
    let second = false
    const s = await setup([], {
      cols,
      rows: 12,
      settings: { mode: "inline" },
      commands: [
        {
          name: "questions",
          description: "Ask questions",
          async run(_args, ctx) {
            await ctx.ui.input("First question?")
            second = true
            await ctx.ui.input("Second question?")
            ctx.print("Finished")
          },
        },
      ],
    })
    try {
      s.terminal.send("/questions\r")
      await waitFor(() => s.live().includes("First question?"), "first input")
      s.terminal.send(`${paste("a".repeat(500))}\r`)
      await waitFor(() => second, "first input answered")
      await waitFor(() => s.live().includes("Second question?"), "next question visible")
      s.terminal.send("answer\r")
      await s.shows("Finished")
      await s.idle()
      expect(s.all()).toContain("First question?")
      expect(s.all()).toContain("Second question?")
    } finally {
      s.host.ui.cancelAll()
      await s.idle()
      await closeImageApp(s)
    }
  })
}
