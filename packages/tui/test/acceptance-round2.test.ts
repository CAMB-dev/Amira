import { expect, spyOn, test } from "bun:test"
import { defaultTheme, type RenderContext, surfaceTheme } from "@amira/tui-kit"
import { Dialog } from "../src/dialog.ts"
import { paste, setup, waitFor } from "./app-harness.ts"

const ESC = "\x1b[27u"
const SELECT = "\x1b[1;5A"
async function close(app: Awaited<ReturnType<typeof setup>>) {
  app.terminal.send(`${ESC}${ESC}\x03\x03`)
  await app.exited
}

for (const cols of [60, 90, 100]) {
  for (const margin of [0, 3]) {
    test(`one-row transcript keeps a real find match and keyboard selection visible: ${cols}/${margin}`, async () => {
      const app = await setup([{ text: `TARGET\n${"reply row\n".repeat(50)}` }], {
        cols,
        rows: 12,
        settings: { mode: "fullscreen", margin, marginRows: 0, theme: "dark" },
      })
      try {
        app.terminal.send("PINNED PROMPT\r")
        await app.idle()
        app.terminal.send(paste("draft one\ndraft two\ndraft three\ndraft four"))
        await app.shows("draft four")
        app.terminal.send("\x06TARGET")
        await waitFor(() => app.live().includes("1/1"), "found TARGET")
        expect(
          app.screen.lines.filter((row) => row.includes("TARGET") && !row.includes("find")),
        ).toHaveLength(1)
        // After composer budgeting is fixed, this resize still exercises a one-row find viewport.
        app.screen.resize(cols, 10)
        app.terminal.setSize(cols, 10)
        await Bun.sleep(40)
        app.terminal.send("\r")
        await Bun.sleep(40)
        expect(
          app.screen.lines.filter((row) => row.includes("TARGET") && !row.includes("find")),
        ).toHaveLength(1)
        const query = app.screen.lines.findIndex((row) => row.includes("find") && row.includes("1/1"))
        expect(app.screen.lines[query - 2]).toContain("TARGET")
        expect(app.screen.lines.filter((row) => row.includes("PINNED PROMPT"))).toHaveLength(0)
        app.terminal.send(ESC + SELECT)
        await waitFor(
          () => app.screen.lines.some((row) => row.trimStart().startsWith("› reply ")),
          "selected reply",
        )
        expect(
          app.screen.lines.some((row) => row.trimStart().startsWith("▌") && row.includes("TARGET")),
        ).toBe(true)
      } finally {
        await close(app)
      }
    })

    for (const banded of [false, true]) {
      test(`natural prompt keeps find highlighting and selection: ${cols}/${margin}, banded ${banded}`, async () => {
        const app = await setup([{ text: "reply tail\n".repeat(50) }], {
          cols,
          rows: 32,
          theme: banded ? { ...defaultTheme, ...surfaceTheme("dark") } : defaultTheme,
          settings: { mode: "fullscreen", margin, marginRows: 0 },
        })
        try {
          app.terminal.send("PROMPTTARGET\r")
          await app.idle()
          app.terminal.send("\x06PROMPTTARGET")
          await waitFor(() => app.live().includes("1/1"), "found prompt")
          const promptRow = app.screen.lines.findIndex(
            (row) => row.includes("PROMPTTARGET") && !row.includes("find"),
          )
          const padding = banded ? 1 : 0
          app.terminal.send("\x1b[1;2B".repeat(Math.max(0, promptRow - 2 - padding)))
          await Bun.sleep(40)
          app.terminal.clearWrites()
          app.terminal.send("\x0c")
          await Bun.sleep(40)
          expect(
            app.screen.lines.filter((row) => row.includes("PROMPTTARGET") && !row.includes("find")),
          ).toHaveLength(1)
          expect(app.terminal.output).toContain("\x1b[7;4mPROMPTTARGET")
          app.terminal.clearWrites()
          app.terminal.send(`${ESC}${SELECT}\x1b[A`)
          await waitFor(
            () => app.screen.lines.some((row) => row.trimStart().startsWith("› message ")),
            "selected prompt",
          )
          // A user glyph is inverse-selected rather than replaced with the blank-gutter ▌.
          expect(app.screen.lines[2 + padding]).toContain("PROMPTTARGET")
          expect(app.terminal.output).toContain("\x1b[7m›")
        } finally {
          await close(app)
        }
      })
    }

    for (const mode of ["fullscreen"] as const) {
      test(`sectioned picker preserves essential rows at four and three: ${mode} ${cols}/${margin}`, async () => {
        let cap = 4
        const render = Dialog.prototype.render
        // Exercise the component's public maxRows contract inside the actual app/renderer.
        const capped = spyOn(Dialog.prototype, "render").mockImplementation(function (
          this: Dialog,
          width: number,
          ctx: RenderContext,
        ) {
          this.maxRows = Math.min(this.maxRows, cap)
          return render.call(this, width, ctx)
        })
        const app = await setup([], { cols, rows: 12, settings: { mode, margin, marginRows: 0 } })
        try {
          void app.host.ui.api().choose("Model", ["first", "second"], {
            sections: [{ at: 0, title: "Provider" }],
          })
          await app.shows("Model")
          const top = app.screen.lines.findIndex((row) => row.includes("╭ Model"))
          expect(top).toBeGreaterThanOrEqual(0)
          expect(app.screen.lines[top + 1]).toContain("│›1 first")
          expect(app.screen.lines[top + 2]).toContain("enter choose")
          expect(app.screen.lines[top + 3]).toMatch(/╰─+╯/)
          expect(app.live()).not.toContain("Provider")
          app.terminal.send("\x1b[B")
          await waitFor(() => app.live().includes("│›2 second"), "second selected")
          cap = 3
          app.terminal.send("\x1b[A")
          await Bun.sleep(30)
          const title = app.screen.lines.findIndex((row) => row.trim() === "Model")
          expect(title).toBeGreaterThanOrEqual(0)
          expect(app.screen.lines[title + 1]!.trim()).toBe("› 1 first")
          expect(app.screen.lines[title + 2]).toContain("enter choose")
          expect(app.live()).not.toContain("Provider")
        } finally {
          capped.mockRestore()
          await close(app)
        }
      })

      test(`short composer reserves its complete frame, status and footer: ${mode} ${cols}/${margin}`, async () => {
        const app = await setup([], { cols, rows: 10, settings: { mode, margin, marginRows: 0 } })
        try {
          app.terminal.send(paste("DRAFT ONE\nDRAFT TWO\nDRAFT THREE\nDRAFT FOUR"))
          await app.shows("DRAFT FOUR")
          const rows = app.screen.lines
          const top = rows.findIndex((row) => row.includes("╭"))
          const bottom = rows.findIndex((row, i) => i > top && row.includes("╰"))
          expect(top).toBeGreaterThanOrEqual(0)
          expect(bottom).toBeGreaterThan(top)
          const left = rows[top]!.indexOf("╭")
          const right = rows[top]!.indexOf("╮")
          for (const row of rows.slice(top + 1, bottom)) {
            expect(row[left]).toBe("│")
            expect(row[right]).toBe("│")
          }
          expect(rows[bottom]).toMatch(/╰─+╯/)
          expect(rows[bottom + 1]).toContain("m1 · auto")
          expect(rows[bottom + 2]).toContain("ctrl+o detail")
          expect(rows[bottom + 2]).toContain("shift+tab mode")
          expect(rows.slice(top, bottom + 1).join("\n")).toMatch(/↑ \d+ rows?/)
          expect(app.screen.y).toBeGreaterThan(top)
          expect(app.screen.y).toBeLessThan(bottom)
          app.terminal.send("\x1b[A".repeat(3))
          await Bun.sleep(30)
          expect(app.live()).toContain("DRAFT ONE")
          expect(app.live()).toMatch(/↓ \d+ rows?/)
          expect(app.live()).toContain("ctrl+o detail")
        } finally {
          await close(app)
        }
      })
    }
  }
}
