import { expect, test } from "bun:test"
import { isColorEnabled, setColorEnabled, stripAnsi } from "@amira/tui-kit"
import { setup } from "./app-harness.ts"

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: 33 ms shimmer rewrites activity only and preserves composer cursor`, async () => {
    const color = isColorEnabled()
    setColorEnabled(true)
    const s = await setup([], { cols: 100, rows: 32, settings: { mode, colorDepth: "truecolor" } })
    try {
      s.bus.emit(
        "turn.start",
        { prompt: { role: "user", content: [{ type: "text", text: "clock" }] } },
        { sessionId: s.agent.sessionId },
      )
      await Bun.sleep(200)
      const before = s.terminal.output.length
      const cursor = { x: s.screen.x, y: s.screen.y }
      const rows = s.screen.lines
      const scrollback = [...s.screen.scrollback]
      // At ~30 fps three frames take ~100 ms; slow CI runners get up to a second.
      const frameCount = () => (stripAnsi(s.terminal.output.slice(before)).match(/Working…/g) ?? []).length
      for (const deadline = Date.now() + 1000; frameCount() < 3 && Date.now() < deadline; )
        await Bun.sleep(10)
      const written = s.terminal.output.slice(before)
      const output = stripAnsi(written)
      const frames = output.match(/Working…/g)!.length
      expect(frames).toBeGreaterThanOrEqual(3)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: count renderer line-diff rewrites
      expect(written.match(/\x1b\[2K/g)!.length).toBe(frames)
      expect(output).not.toContain("Message Amira")
      expect(output).not.toContain("/work/proj")
      expect(output).not.toContain("shift+tab")
      expect(s.screen.lines.filter((row) => !row.includes("Working…"))).toEqual(
        rows.filter((row) => !row.includes("Working…")),
      )
      expect({ x: s.screen.x, y: s.screen.y }).toEqual(cursor)
      expect(s.screen.scrollback).toEqual(scrollback)
    } finally {
      s.bus.emit("turn.end", { reason: "done", steps: 0 }, { sessionId: s.agent.sessionId })
      await Bun.sleep(50)
      s.terminal.send("\x03\x03")
      await s.exited
      setColorEnabled(color)
    }
  })
}
