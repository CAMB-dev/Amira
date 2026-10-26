import { expect, test } from "bun:test"
import type { CommandDefinition } from "@amira/api"
import { setup, waitFor } from "./app-harness.ts"

const commands: CommandDefinition[] = Array.from({ length: 12 }, (_, i) => ({
  name: `candidate${String(i).padStart(2, "0")}`,
  description: "candidate command",
  run: () => {},
}))

for (const mode of ["fullscreen"] as const) {
  for (const cols of [50, 80, 120]) {
    for (const margin of [0, 3]) {
      for (const working of [false, true]) {
        test(`small-height dialog keeps title before optional chrome: ${mode} ${cols}/${margin}, working ${working}`, async () => {
          const app = await setup(working ? [{ text: "reply".repeat(100), delayMs: 50 }] : [], {
            cols,
            rows: working ? 8 : 7,
            settings: { mode, margin, marginRows: 0 },
          })
          try {
            if (working) {
              app.terminal.send("go\r")
              await waitFor(
                () => app.agent.status === "working" && app.live().includes("stop"),
                "working turn",
              )
            }
            app.bus.emit(
              "ui.request",
              { requestId: "short-model", kind: "select", title: "Model", options: ["first", "second"] },
              { sessionId: app.agent.sessionId },
            )
            await waitFor(() => app.live().includes("enter choose"), "dialog footer")
            const title = app.screen.lines.findIndex((row) => row.includes("Model"))
            expect(title).toBeGreaterThanOrEqual(0)
            expect(app.screen.lines[title + 1]).toMatch(/› ?1 {1,2}first/)
            const footer = app.screen.lines.findIndex((row) => row.includes("enter choose"))
            expect(footer).toBeGreaterThan(title + 1)
            expect(app.screen.lines[footer]).toContain("esc cancel")
            app.terminal.send("\x1b[B")
            await waitFor(() => /› ?2 {1,2}second/.test(app.live()), "second selected")
            expect(app.screen.lines[title]).toContain("Model")
            expect(app.screen.lines[title + 1]).toMatch(/› ?2 {1,2}second/)
            expect(app.screen.lines[footer]).toContain("enter choose")
            if (mode === "fullscreen") {
              // Three essential rows fit; status and activity must not displace them.
              expect(footer).toBe(title + 2)
              if (working) {
                expect(app.agent.status).toBe("working")
                expect(app.live()).toContain("m1 · auto")
                expect(app.live()).not.toContain("stop")
              } else expect(app.live()).not.toContain("m1 · auto")
            }
          } finally {
            app.agent.abort()
            await app.idle()
            app.terminal.send("\x1b[27u\x03\x03")
            await app.exited
          }
        })
      }

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
            const file = `file${String(i).padStart(2, "0")}.ts`
            expect(app.live()).toContain(`› ${file}`)
            const rows = app.screen.lines
            const composer = rows.findIndex((row) => row.trimStart().startsWith("│ › @"))
            expect(composer).toBeGreaterThan(0)
            const left = rows[composer]!.indexOf("│")
            expect(rows[composer]!.indexOf("@")).toBe(left + 4)
            expect(rows[composer - 1]).toMatch(/╭─+╮/)
            expect(rows[composer + 1]).toMatch(/╰─+╯/)
            expect(rows[composer + 2]).toContain("m1 · auto")
            const option = rows.findIndex((row) => row.includes(`› ${file}`))
            expect(option).toBeGreaterThan(composer + 2)
            expect(rows[option]!.indexOf(file)).toBe(left + 4)
            expect(app.live()).toContain("insert")
            expect(app.live()).toContain("esc close")
            expect(app.screen.y).toBe(composer)
            expect(app.screen.x).toBe(left + 4 + "@".length)
          }
          app.terminal.send("\t")
          await waitFor(() => app.live().includes("│ › @file11.ts"), "file inserted")
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
            const composer = rows.findIndex((row) => row.trimStart().startsWith("│ › /"))
            expect(composer).toBeGreaterThan(0)
            const left = rows[composer]!.indexOf("│")
            expect(rows[composer]!.indexOf("/")).toBe(left + 4)
            expect(rows[composer - 1]).toMatch(/╭─+╮/)
            expect(rows[composer + 1]).toMatch(/╰─+╯/)
            expect(rows[composer + 2]).toContain("m1 · auto")
            const option = rows.findIndex((row) => row.includes(selected))
            expect(option).toBeGreaterThan(composer + 2)
            expect(rows[option]!.indexOf(selected.slice(2))).toBe(left + 4)
            expect(rows.at(-1)).toContain("tab complete")
            expect(rows.at(-1)).toContain("enter run")
            expect(rows.at(-1)).toContain("esc close")
            expect(app.screen.y).toBe(composer)
            expect(app.screen.x).toBe(left + 4 + "/".length)
          }
          app.terminal.send("\t")
          await waitFor(() => app.live().includes("│ › /candidate11"), "completion inserted")
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
