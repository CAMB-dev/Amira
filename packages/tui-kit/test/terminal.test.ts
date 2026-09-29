import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { modes } from "../src/ansi.ts"
import { FakeTerminal, ProcessTerminal } from "../src/terminal.ts"

test("restore leaves enabled modes in reverse order, shows the cursor and leaves raw mode", () => {
  const term = new FakeTerminal()
  term.setRawMode(true)
  term.enableMode(modes.bracketedPaste)
  term.enableMode(modes.bracketedPaste)
  term.enterAltScreen()
  expect(term.writes).toEqual([modes.bracketedPaste.on, modes.altScreen.on])
  term.clearWrites()
  term.restore()
  expect(term.output).toBe(`${modes.altScreen.off}${modes.bracketedPaste.off}\x1b[0m\x1b[?25h`)
  expect(term.isRaw).toBe(false)
})

test("exitAltScreen only writes when the alt screen is active", () => {
  const term = new FakeTerminal()
  term.exitAltScreen()
  expect(term.writes).toEqual([])
  term.enterAltScreen()
  term.exitAltScreen()
  expect(term.writes).toEqual([modes.altScreen.on, modes.altScreen.off])
})

test("input and resize reach listeners until unsubscribed", () => {
  const term = new FakeTerminal(80, 24)
  const got: string[] = []
  let resized = 0
  const off = term.onInput((d) => got.push(d))
  term.onResize(() => resized++)
  term.send("a")
  off()
  term.send("b")
  term.setSize(40, 10)
  expect(got).toEqual(["a"])
  expect(resized).toBe(1)
  expect(term.columns).toBe(40)
})

describe("ProcessTerminal restores itself when the process goes away", () => {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP", ...(process.platform === "win32" ? ["SIGBREAK"] : [])]
  let dir: string
  let file: string
  let term: ProcessTerminal
  let fd: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tui-kit-"))
    file = join(dir, "out")
    fd = openSync(file, "w")
    const stdout = Object.assign(new EventEmitter(), {
      fd,
      columns: 80,
      rows: 24,
      write: () => true,
    })
    term = new ProcessTerminal(new PassThrough() as any, stdout as any)
  })

  afterEach(() => {
    term.stop()
    closeSync(fd)
    rmSync(dir, { recursive: true, force: true })
  })

  const counts = () => [...signals, "exit", "uncaughtExceptionMonitor"].map((s) => process.listenerCount(s))

  test("handlers are added by start and removed by stop, once", () => {
    const before = counts()
    term.start()
    term.start()
    expect(counts()).toEqual(before.map((n) => n + 1))
    term.stop()
    term.stop()
    expect(counts()).toEqual(before)
  })

  test("an uncaught exception restores synchronously", () => {
    term.start()
    term.enableMode(modes.bracketedPaste)
    process.emit("uncaughtExceptionMonitor", new Error("x"), "uncaughtException")
    expect(readFileSync(file, "utf8")).toBe(`${modes.bracketedPaste.off}\x1b[0m\x1b[?25h`)
  })

  test("after restoring, the emergency text is written once, below the alternate screen", () => {
    term.start()
    term.enterAltScreen()
    let asked = 0
    term.onEmergencyExit(() => {
      asked++
      return "the conversation\r\n"
    })
    const off = term.onEmergencyExit(() => "never")
    off()
    process.emit("uncaughtExceptionMonitor", new Error("x"), "uncaughtException")
    process.emit("uncaughtExceptionMonitor", new Error("y"), "uncaughtException")
    expect(readFileSync(file, "utf8")).toBe(
      `${modes.altScreen.off}\x1b[0m\x1b[?25hthe conversation\r\n\x1b[0m\x1b[?25h`,
    )
    expect(asked).toBe(1)
  })

  test("an uncaught exception the app handles leaves the terminal alone", () => {
    term.start()
    term.enableMode(modes.bracketedPaste)
    const app = () => {}
    process.on("uncaughtException", app)
    try {
      process.emit("uncaughtExceptionMonitor", new Error("x"), "uncaughtException")
    } finally {
      process.off("uncaughtException", app)
    }
    expect(readFileSync(file, "utf8")).toBe("")
  })

  test("a signal with no other listener restores and exits; an app handler keeps it", () => {
    term.start()
    term.enableMode(modes.bracketedPaste)
    let appGot = 0
    const app = () => appGot++
    process.on("SIGTERM", app)
    process.emit("SIGTERM", "SIGTERM")
    process.off("SIGTERM", app)
    expect(appGot).toBe(1)
    expect(readFileSync(file, "utf8")).toBe("")

    const exit = process.exit
    let code: number | undefined
    process.exit = ((c?: number) => {
      code = c
    }) as typeof process.exit
    try {
      process.emit("SIGTERM", "SIGTERM")
    } finally {
      process.exit = exit
    }
    expect(code).toBe(143)
    expect(readFileSync(file, "utf8")).toStartWith(modes.bracketedPaste.off)
    expect(process.listenerCount("SIGTERM")).toBe(0)
  })
})
