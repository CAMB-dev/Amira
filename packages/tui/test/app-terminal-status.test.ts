import { expect, test } from "bun:test"
import { setup } from "./app-harness.ts"

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: unknown focus alerts for questions, not pickers, once per wait`, async () => {
    const s = await setup([], { settings: { mode }, env: { TERM_PROGRAM: "ghostty" } })
    try {
      const ui = s.host.ui.api("test")
      const picker = ui.select("Pick a value", ["one", "two"])
      await s.bus.flush()
      expect(s.screen.bells).toBe(0)
      expect(s.screen.oscs).not.toContain("9;Amira is waiting for your answer")
      s.terminal.send("\x1b[27u")
      await picker
      await s.bus.flush()
      const first = ui.confirm("Continue?", "Proceed?")
      await s.bus.flush()
      expect(s.screen.bells).toBe(1)
      expect(s.screen.oscs.filter((o) => o.startsWith("0;")).at(-1)).toBe("0;? Amira · proj")
      const second = ui.confirm("Another question", "Proceed?")
      await s.bus.flush()
      s.terminal.send("\x1b[I")
      await s.bus.flush()
      expect(s.screen.oscs.filter((o) => o.startsWith("0;")).at(-1)).toBe("0;? Amira · proj")
      s.terminal.send("\x1b[O\x1b[I\x1b[O")
      await s.bus.flush()
      expect(s.screen.bells).toBe(1)
      expect(s.screen.oscs.filter((o) => o === "9;Amira is waiting for your answer")).toHaveLength(1)
      s.terminal.send("\x1b[27u")
      await first
      s.terminal.send("\x1b[27u")
      await second
      await s.bus.flush()
      expect(s.screen.oscs.filter((o) => o.startsWith("0;")).at(-1)).toBe("0;Amira · proj")
    } finally {
      s.terminal.send("\x03\x03")
      await s.exited
    }
  })

  test(`${mode}: background completion alerts once, focus return clears waiting title`, async () => {
    const s = await setup([{ text: "done", delayMs: 20 }], {
      settings: { mode, bell: false },
      env: { TERM_PROGRAM: "ghostty" },
    })
    try {
      s.terminal.send("\x1b[Ogo\r")
      await s.shows("done")
      await s.idle()
      await s.bus.flush()
      expect(s.screen.bells).toBe(0)
      expect(s.screen.oscs.filter((o) => o === "9;Amira finished the turn")).toHaveLength(1)
      expect(s.screen.oscs.filter((o) => o.startsWith("0;")).at(-1)).toBe("0;? Amira · proj")
      s.terminal.send("\x1b[I")
      await s.bus.flush()
      expect(s.screen.oscs.filter((o) => o.startsWith("0;")).at(-1)).toBe("0;Amira · proj")
      s.bus.emit("turn.end", { reason: "aborted", steps: 0 }, { sessionId: s.agent.sessionId })
      await s.bus.flush()
      expect(s.screen.oscs.filter((o) => o === "9;Amira finished the turn")).toHaveLength(1)
    } finally {
      s.terminal.send("\x03\x03")
      await s.exited
    }
  })
}
