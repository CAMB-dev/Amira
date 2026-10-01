import { expect, test } from "bun:test"
import { FakeTerminal } from "@amira/tui-kit"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { TerminalStatus, type TerminalStatusOptions } from "../src/terminal-status.ts"

function setup(opts: TerminalStatusOptions = {}) {
  const terminal = new FakeTerminal()
  const screen = new VirtualScreen(80, 24)
  const write = terminal.write.bind(terminal)
  terminal.write = (d: string) => {
    write(d)
    screen.write(d)
  }
  let now = 0
  const status = new TerminalStatus(terminal, "/work/proj", { now: () => now, ...opts })
  const titles = () => screen.oscs.filter((o) => o.startsWith("0;")).map((o) => o.slice(2))
  const progress = () => screen.oscs.filter((o) => o.startsWith("9;4;")).map((o) => o.slice(4))
  return { terminal, screen, status, titles, progress, advance: (ms: number) => (now += ms) }
}

test("the title names the folder and branch, marked while a turn runs, and is handed back on stop", () => {
  const { terminal, status, titles } = setup()
  status.start()
  expect(terminal.output.startsWith("\x1b[22;0t")).toBe(true)
  status.setBranch("main")
  status.turnStarted()
  status.turnEnded("completed")
  expect(titles()).toEqual([
    "Amira · proj",
    "Amira · proj ⎇ main",
    "● Amira · proj ⎇ main",
    "Amira · proj ⎇ main",
  ])
  // Nothing new is written when nothing changed.
  const writes = terminal.writes.length
  status.setBranch("main")
  expect(terminal.writes.length).toBe(writes)
  status.stop()
  expect(titles().at(-1)).toBe("")
  expect(terminal.output.endsWith("\x1b[23;0t\x1b[?1004l")).toBe(true)
})

test("progress: busy while working, paused while a dialog waits, cleared when idle and on stop", () => {
  const { status, progress } = setup()
  status.start()
  status.turnStarted()
  status.setWaiting(true)
  status.setWaiting(false)
  status.turnEnded("completed")
  status.turnStarted()
  status.stop()
  expect(progress()).toEqual(["3;0", "4;100", "3;0", "0;0", "3;0", "0;0"])
})

test("a session title follows the folder and resets when switching to an unnamed session", () => {
  const { status, titles } = setup()
  status.start()
  status.setSessionTitle("Database repair")
  expect(titles().at(-1)).toBe("Amira · proj · Database repair")
  status.setSessionTitle(undefined)
  expect(titles().at(-1)).toBe("Amira · proj")
  status.stop()
})

test("the terminal's own restore (a crash, a signal) hands the title and the indicator back too", () => {
  const { terminal, status, titles, progress } = setup()
  status.start()
  status.turnStarted()
  // What ProcessTerminal writes on exit when stop() never ran.
  terminal.restore()
  expect(progress().at(-1)).toBe("0;0")
  expect(titles().at(-1)).toBe("")
  expect(terminal.output).toContain("\x1b]0;\x07\x1b[23;0t")
  // Handed back once: a later stop() finds nothing left to undo.
  const writes = terminal.output.length
  status.stop()
  expect(terminal.output.length).toBe(writes)
})

test("a hidden dialog rings even with the terminal in front", () => {
  const { status, screen } = setup()
  status.start()
  status.focus(true)
  status.setWaiting(true, true)
  expect(screen.bells).toBe(1)
  // Another one while the first still waits rings again.
  status.setWaiting(true, true)
  expect(screen.bells).toBe(2)
  status.setWaiting(true)
  expect(screen.bells).toBe(2)
})

test("settings turn each part off", () => {
  const { terminal, status, screen } = setup({ title: false, progress: false, bell: false })
  status.start()
  status.turnStarted()
  status.turnEnded("completed")
  status.stop()
  expect(screen.oscs).toEqual([])
  // Only the focus reports, which extensions use too (ui.focus), are left.
  expect(terminal.output).toBe("\x1b[?1004h\x1b[?1004l")
})

test("with focus reports, the bell rings only while the terminal is in the background", () => {
  const { terminal, status, screen } = setup()
  status.start()
  expect(terminal.output).toContain("\x1b[?1004h")
  status.focus(true)
  status.turnStarted()
  status.turnEnded("completed")
  expect(screen.bells).toBe(0)
  status.focus(false)
  status.turnStarted()
  status.setWaiting(true)
  expect(screen.bells).toBe(1)
  status.setWaiting(false)
  status.turnEnded("completed")
  expect(screen.bells).toBe(2)
  // Not after Esc: the user is right there.
  status.turnStarted()
  status.turnEnded("aborted")
  expect(screen.bells).toBe(2)
})

test("without focus reports, only a long turn rings", () => {
  const { status, screen, advance } = setup({ longTurnMs: 10_000 })
  status.start()
  status.turnStarted()
  advance(3000)
  status.turnEnded("completed")
  expect(screen.bells).toBe(0)
  status.turnStarted()
  advance(12_000)
  status.setWaiting(true)
  expect(screen.bells).toBe(1)
  status.setWaiting(false)
  status.turnEnded("error")
  expect(screen.bells).toBe(2)
  // A dialog outside a turn (a command's picker) was just asked for.
  status.setWaiting(true)
  expect(screen.bells).toBe(2)
})
