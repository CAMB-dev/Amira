import { expect, test } from "bun:test"
import { closeImageApp, exchange, setup, waitFor } from "./app-harness.ts"

type App = Awaited<ReturnType<typeof setup>>
const point = (s: App, text: string) => {
  const y = s.screen.lines.findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  return { x: s.screen.lines[y]!.indexOf(text), y }
}
const mouse = (s: App, x: number, y: number, code = 0, end = "M") =>
  s.terminal.send(`\x1b[<${code};${x + 1};${y + 1}${end}`)

for (const gesture of ["click", "drag"] as const) {
  test(`an open input dock owns outside ${gesture}s without losing focus or copying transcript text`, async () => {
    const s = await setup([], {
      cols: 90,
      rows: 32,
      history: exchange("transcript-target"),
      settings: { margin: 3, marginRows: 1 },
      extensions: [
        (api) => {
          api.registerView({
            kind: "pointer-owner",
            title: () => "Pointer owner",
            ui: () => ({ type: "input", id: "draft", placeholder: "Dock input" }),
          })
          api.registerCommand({
            name: "pointer-owner",
            description: "Open dock",
            run: (_args, ctx) => {
              ctx.openView?.({ kind: "pointer-owner", placement: "dock", maxHeight: 8 })
            },
          })
        },
      ],
    })
    try {
      s.terminal.send("/pointer-owner\r")
      await waitFor(() => s.live().includes("Dock input"), "input dock")
      const input = point(s, "Dock input")
      mouse(s, input.x, input.y)
      mouse(s, input.x, input.y, 0, "m")
      s.terminal.send("before")
      await waitFor(() => s.live().includes("before"), "focused dock draft")
      const transcript = point(s, "transcript-target")
      const before = s.terminal.output.length
      mouse(s, transcript.x, transcript.y)
      const end = transcript.x + (gesture === "drag" ? 10 : 0)
      if (gesture === "drag") mouse(s, end, transcript.y, 32)
      mouse(s, end, transcript.y, 0, "m")
      s.terminal.send("after")
      await Bun.sleep(60)
      expect(s.terminal.output.slice(before)).not.toContain("\x1b]52;")
      expect(s.live()).toContain("beforeafter")
      s.terminal.send("\tkeyboard")
      await waitFor(() => s.live().includes("keyboard"), "keyboard switches focus to composer")
      expect(s.live()).not.toContain("beforeafterkeyboard")
    } finally {
      s.terminal.send("\x1b[27u")
      await closeImageApp(s)
    }
  })
}
