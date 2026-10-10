import { expect, test } from "bun:test"
import { setup } from "./app-harness.ts"

test("interactive startup applies palette and depth settings, with mono taking precedence", async () => {
  const cases = [
    { settings: { theme: "dark", colorDepth: "truecolor" }, env: {}, prompt: "\x1b[38;2;120;219;226m› " },
    { settings: { theme: "light", colorDepth: "truecolor" }, env: {}, prompt: "\x1b[38;2;21;124;132m› " },
    { settings: { theme: "terminal", colorDepth: "truecolor" }, env: {}, prompt: "\x1b[36m› " },
    { settings: { theme: "light", colorDepth: "truecolor" }, env: { NO_COLOR: "1" }, prompt: "\x1b[1m› " },
  ] as const
  for (const c of cases) {
    const s = await setup([], c)
    try {
      expect(s.terminal.output).toContain(c.prompt)
    } finally {
      s.terminal.send("\x03")
      await s.exited
    }
  }
})
