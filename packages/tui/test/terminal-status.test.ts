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

test("settings turn each part off", () => {
  const { terminal, status, screen } = setup({ title: false, progress: false, bell: false })
  status.start()
  status.turnStarted()
  status.turnEnded("completed")
  status.stop()
  expect(screen.oscs).toEqual([])
  expect(terminal.output).toBe("")
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
