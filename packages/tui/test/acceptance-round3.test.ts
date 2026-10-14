import { expect, test } from "bun:test"
import type { CommandDefinition } from "@amira/api"
import { setup, waitFor } from "./app-harness.ts"

const commands: CommandDefinition[] = Array.from({ length: 12 }, (_, i) => ({
  name: `candidate${String(i).padStart(2, "0")}`,
  description: "candidate command",
  run: () => {},
}))

for (const mode of ["fullscreen", "inline"] as const) {
  for (const cols of [50, 80, 120]) {
    for (const margin of [0, 3]) {
      test(`file completion windows selected files below the composer: ${mode} ${cols}/${margin}`, async () => {
        const files = Array.from({ length: 12 }, (_, i) => `file${String(i).padStart(2, "0")}.ts`)
        const app = await setup([], { cols, rows: 12, files, settings: { mode, margin, marginRows: 0 } })
        try {
          app.terminal.send("@")
          await waitFor(() => app.live().includes("› file00.ts"), "file list")
          for (let i = 0; i < 12; i++) {
            if (i) {
              app.terminal.send("\x1b[B")
              await Bun.sleep(25)
            }
            expect(app.live()).toContain(`› file${String(i).padStart(2, "0")}.ts`)
            const composer = app.screen.lines.findIndex((row) => row.trimStart().startsWith("│›@"))
            expect(composer).toBeGreaterThan(0)
            expect(app.screen.lines[composer - 1]).toMatch(/╭─+╮/)
            expect(app.screen.lines[composer + 1]).toMatch(/╰─+╯/)
            expect(app.screen.lines[composer + 2]).toContain("m1 · auto")
            expect(app.live()).toContain("insert")
            expect(app.live()).toContain("esc close")
            expect(app.screen.y).toBe(composer)
          }
          app.terminal.send("\t")
          await waitFor(() => app.live().includes("│›@file11.ts"), "file inserted")
        } finally {
          app.terminal.send("\x1b[27u\x03\x03")
          await app.exited
        }
      })

      test(`completion keeps composer, selected option and hint: ${mode} ${cols}/${margin}`, async () => {
        const app = await setup([], { cols, rows: 12, commands, settings: { mode, margin, marginRows: 0 } })
        try {
          app.terminal.send("/")
          await waitFor(() => app.live().includes("enter run"), "command popup")
          app.terminal.send("\x1b[B")
          await Bun.sleep(30)
          for (let i = 0; i < 12; i++) {
            if (i) {
              app.terminal.send("\x1b[B")
              await Bun.sleep(25)
            }
            const selected = `› /candidate${String(i).padStart(2, "0")}`
            expect(app.live()).toContain(selected)
            const rows = app.screen.lines
            const composer = rows.findIndex((row) => row.trimStart().startsWith("│›/"))
            expect(composer).toBeGreaterThan(0)
            expect(rows[composer - 1]).toMatch(/╭─+╮/)
            expect(rows[composer + 1]).toMatch(/╰─+╯/)
            expect(rows[composer + 2]).toContain("m1 · auto")
            const option = rows.findIndex((row) => row.includes(selected))
            expect(option).toBeGreaterThan(composer + 2)
            expect(rows.at(-1)).toContain("tab complete")
            expect(rows.at(-1)).toContain("enter run")
            expect(rows.at(-1)).toContain("esc close")
            expect(app.screen.y).toBe(composer)
          }
          app.terminal.send("\t")
          await waitFor(() => app.live().includes("│›/candidate11"), "completion inserted")
          expect(app.live()).toContain("/candidate11  candidate command")
          expect(app.live()).toContain("esc close")
        } finally {
          app.terminal.send("\x1b[27u\x03\x03")
          await app.exited
        }
      })
    }
  }
}
