import { expect, test } from "bun:test"
import { modes, osc } from "@amira/tui-kit"
import { exchange, setup, testCommands } from "./app-harness.ts"

for (const margin of [0, 3]) {
  for (const open of [false, true]) {
    for (const pinned of [false, true]) {
      test(`real fullscreen drag: margin ${margin}, dialog ${open}, pinned ${pinned}`, async () => {
        const s = await setup([], {
          cols: 90,
          rows: 32,
          history: exchange("selection-target"),
          commands: testCommands([]),
          settings: { mode: "fullscreen", margin, marginRows: 1 },
        })
        try {
          if (pinned) {
            s.bus.emit(
              "turn.start",
              { prompt: { role: "user", content: [{ type: "text", text: "pinned-target" }] } },
              { sessionId: s.agent.sessionId },
            )
            s.bus.emit(
              "message.delta",
              { kind: "text", text: "selection-target\n".repeat(50) },
              { sessionId: s.agent.sessionId },
            )
          }
          if (open) {
            s.terminal.send("/model\r")
            await s.shows("deepseek/deepseek-flash")
          }
          if (pinned) s.terminal.send("\x1b[<64;10;10M")
          await Bun.sleep(60)
          if (pinned) expect(s.screen.text).toContain("› pinned-target")
          const y = s.screen.lines.findIndex((row) => row.includes("selection-target"))
          expect(y).toBeGreaterThanOrEqual(0)
          const x = s.screen.lines[y]!.indexOf("selection-target")
          const before = s.terminal.output.length
          for (const [code, action, end] of [
            [0, "M", x],
            [32, "M", x + 8],
            [0, "m", x + 8],
          ] as const)
            s.terminal.send(`\x1b[<${code};${end + 1};${y + 1}${action}`)
          await Bun.sleep(60)
          expect(s.terminal.output.slice(before)).toContain(osc.clipboard("selection"))
          if (open) {
            expect(s.screen.text).toContain("Model")
            // Interactive dialog rows are outside the transcript selection pane.
            const dy = s.screen.lines.findIndex((row) => row.includes("deepseek/deepseek-flash"))
            const dx = s.screen.lines[dy]!.indexOf("deepseek/")
            const afterCopy = s.terminal.output.length
            for (const [code, action, end] of [
              [0, "M", dx],
              [32, "M", dx + 8],
              [0, "m", dx + 8],
            ] as const)
              s.terminal.send(`\x1b[<${code};${end + 1};${dy + 1}${action}`)
            await Bun.sleep(60)
            expect(s.terminal.output.slice(afterCopy)).not.toContain("\x1b]52;")
            s.terminal.send("deepseek")
            await s.shows("filter: deepseek")
          }
        } finally {
          if (pinned) s.bus.emit("turn.end", { reason: "done", steps: 0 }, { sessionId: s.agent.sessionId })
          s.terminal.send("\x1b")
          await Bun.sleep(60)
          s.terminal.send("\x03\x03")
          await s.exited
        }
      })
    }
    test(`inline native selection stays enabled: margin ${margin}, dialog ${open}`, async () => {
      const s = await setup([], {
        history: exchange("selection-target"),
        commands: testCommands([]),
        settings: { mode: "inline", margin },
      })
      try {
        if (open) {
          s.terminal.send("/model\r")
          await s.shows("deepseek/deepseek-flash")
        }
        // Inline transcript/dialog selection belongs to the terminal, not app mouse reporting.
        // Feed the real parser too: stray reports must not capture keys or disturb native text.
        const rendered = s.live()
        const y = s.screen.lines.findIndex((row) => row.includes("selection-target"))
        const x = s.screen.lines[y]!.indexOf("selection-target")
        const before = s.terminal.output.length
        for (const [code, action, end] of [
          [0, "M", x],
          [32, "M", x + 8],
          [0, "m", x + 8],
        ] as const)
          s.terminal.send(`\x1b[<${code};${end + 1};${y + 1}${action}`)
        await Bun.sleep(60)
        expect(s.live()).toBe(rendered)
        expect(s.terminal.output.slice(before)).not.toContain("\x1b]52;")
        expect(s.terminal.output).not.toContain(modes.mouse.on)
        expect(s.terminal.output).not.toContain(modes.mouseDrag.on)
        expect(s.screen.text).toContain("selection-target")
      } finally {
        s.terminal.send("\x1b")
        await Bun.sleep(60)
        s.terminal.send("\x03\x03")
        await s.exited
      }
    })
  }
}
