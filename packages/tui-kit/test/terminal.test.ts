import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { modes } from "../src/ansi.ts"
import { createConsoleCodePage } from "../src/console-code-page.ts"
import { FakeTerminal, PASSIVE_SIGNAL_LISTENER, ProcessTerminal } from "../src/terminal.ts"
import { processTerminalFixture } from "./process-terminal-fixture.ts"

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

test("restoration honors existing no-argument restore-sequence overrides", () => {
  class CustomTerminal extends FakeTerminal {
    protected override takeRestoreSequence(): string {
      return super.takeRestoreSequence()
    }
  }
  const terminal = new CustomTerminal()
  terminal.enterAltScreen()
  terminal.clearWrites()
  terminal.restore()
  expect(terminal.output).toBe(`${modes.altScreen.off}\x1b[0m\x1b[?25h`)
})

test("exitAltScreen only writes when the alt screen is active", () => {
  const term = new FakeTerminal()
  term.exitAltScreen()
  expect(term.writes).toEqual([])
  term.enterAltScreen()
  term.exitAltScreen()
  expect(term.writes).toEqual([modes.altScreen.on, modes.altScreen.off])
})

test("a failed alternate-screen exit retains its mode for restore", () => {
  const f = processTerminalFixture()
  try {
    f.terminal.enterAltScreen()
    f.failRestores(1)
    expect(() => f.terminal.exitAltScreen()).toThrow("restore write failed")
    f.terminal.restore()
    expect(f.screen.inAltScreen).toBe(false)
    expect(f.restoreAttempts()).toBe(2)
  } finally {
    f.failRestores(0)
    f.terminal.stop()
    f.stdin.destroy()
  }
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

test("a failed stop releases input and listeners, and a second stop can restore tracked modes", () => {
  const f = processTerminalFixture()
  const events = ["exit", "uncaughtExceptionMonitor", "SIGINT", "SIGTERM", "SIGHUP"] as const
  const before = events.map((event) => process.listenerCount(event))
  try {
    f.terminal.start()
    f.terminal.setRawMode(true)
    f.terminal.enableMode(modes.bracketedPaste)
    f.terminal.enterAltScreen()
    f.failRestores(1)
    expect(() => f.terminal.stop()).toThrow("restore write failed")
    expect({
      raw: f.raw(),
      paused: f.stdin.isPaused(),
      inputListeners: f.stdin.listenerCount("data"),
      resizeListeners: f.stdout.listenerCount("resize"),
      processListeners: events.map((event) => process.listenerCount(event)),
    }).toEqual({
      raw: false,
      paused: true,
      inputListeners: 0,
      resizeListeners: 0,
      processListeners: before,
    })
    f.terminal.stop()
    expect(f.screen.inAltScreen).toBe(false)
    expect(f.screen.altSwitches).toEqual([true, false])
    expect(f.restoreAttempts()).toBe(2)
    expect(f.terminal.isRaw).toBe(false)
  } finally {
    f.failRestores(0)
    f.terminal.stop()
    f.stdin.destroy()
  }
})

describe("ProcessTerminal restores itself when the process goes away", () => {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP", ...(process.platform === "win32" ? ["SIGBREAK"] : [])]
  let dir: string
  let file: string
  let term: ProcessTerminal
  let fd: number
  let codePages: { output: number; input: number }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tui-kit-"))
    file = join(dir, "out")
    fd = openSync(file, "w")
    const stdout = Object.assign(new EventEmitter(), {
      fd,
      columns: 80,
      rows: 24,
      write: () => {
        expect(codePages).toEqual({ output: 65001, input: 65001 })
        return true
      },
    })
    codePages = { output: 936, input: 950 }
    const codePage = createConsoleCodePage({
      platform: "win32",
      stdoutIsTTY: true,
      stdinIsTTY: true,
      load: () => ({
        GetConsoleOutputCP: () => codePages.output,
        SetConsoleOutputCP: (value) => {
          codePages.output = value
          return 1
        },
        GetConsoleCP: () => codePages.input,
        SetConsoleCP: (value) => {
          codePages.input = value
          return 1
        },
      }),
    })
    term = new ProcessTerminal(new PassThrough() as any, stdout as any, codePage)
  })

  afterEach(() => {
    term.stop()
    closeSync(fd)
    rmSync(dir, { recursive: true, force: true })
  })

  const counts = () => [...signals, "exit", "uncaughtExceptionMonitor"].map((s) => process.listenerCount(s))

  test("every normal write reasserts console code pages before sending UTF-8", () => {
    term.write("❯ ● ✓ └ 中文\n")
    codePages.output = 936
    codePages.input = 950
    term.write("❯ ● ✓ └ 中文\n")
    expect(codePages).toEqual({ output: 65001, input: 65001 })
    term.restore()
    expect(codePages).toEqual({ output: 936, input: 950 })
  })

  test("external terminal handoff restores our changes and resume reclaims even without modes", () => {
    term.start()
    const resume = term.suspend()
    expect(codePages).toEqual({ output: 936, input: 950 })
    codePages.output = 437
    codePages.input = 437
    resume()
    expect(codePages).toEqual({ output: 65001, input: 65001 })
    term.stop()
    expect(codePages).toEqual({ output: 936, input: 950 })
  })

  test("emergency output reasserts after callbacks and relinquishes code pages afterwards", () => {
    term.start()
    term.onEmergencyExit(() => {
      codePages.output = 936
      codePages.input = 950
      return "❯ ● ✓ └ 中文\n"
    })
    process.emit("uncaughtExceptionMonitor", new Error("x"), "uncaughtException")
    expect(readFileSync(file, "utf8")).toEndWith("❯ ● ✓ └ 中文\n")
    expect(codePages).toEqual({ output: 936, input: 950 })
  })

  test("explicit emergency stop restores and prints once before detaching, with filtered isolated callbacks", () => {
    const before = counts()
    const oldExitHandlers = new Set(process.listeners("exit"))
    term.start()
    const onExit = process.listeners("exit").find((handler) => !oldExitHandlers.has(handler))!
    term.setRawMode(true)
    term.enableMode(modes.bracketedPaste)
    term.enterAltScreen()
    term.setOutputFilter((text) => text.replace("plain transcript", "filtered transcript"))
    let asked = 0
    term.onEmergencyExit(() => {
      throw new Error("broken callback")
    })
    term.onEmergencyExit(() => {
      asked++
      expect(term.isRaw).toBe(false)
      expect(counts()).toEqual(before.map((count) => count + 1))
      codePages.output = 936
      codePages.input = 950
      return "plain transcript\r\n"
    })
    term.emergencyStop()
    expect(readFileSync(file, "utf8")).toBe(
      `${modes.altScreen.off}${modes.bracketedPaste.off}\x1b[0m\x1b[?25hfiltered transcript\r\n`,
    )
    expect(asked).toBe(1)
    expect(counts()).toEqual(before)
    expect(codePages).toEqual({ output: 936, input: 950 })
    // An already-snapshotted exit listener must not print the same transcript again.
    onExit(0)
    term.emergencyStop()
    expect(readFileSync(file, "utf8").split("filtered transcript")).toHaveLength(2)
    expect(asked).toBe(1)
  })

  test("ordinary stop does not print emergency text, including a later lifecycle stop", () => {
    const before = counts()
    term.start()
    let asked = 0
    term.onEmergencyExit(() => {
      asked++
      return "emergency only"
    })
    term.stop()
    term.emergencyStop()
    expect(asked).toBe(0)
    expect(readFileSync(file, "utf8")).toBe("")
    expect(counts()).toEqual(before)
    expect(codePages).toEqual({ output: 936, input: 950 })
  })

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
    expect(process.listeners("SIGTERM").filter((l) => !(l as never)[PASSIVE_SIGNAL_LISTENER])).toEqual([])
  })

  test("a passive listener (one that only cleans up) does not count as the app's handler", () => {
    term.start()
    term.enableMode(modes.bracketedPaste)
    let cleaned = 0
    const passive = Object.assign(() => void cleaned++, { [PASSIVE_SIGNAL_LISTENER]: true })
    process.on("SIGHUP", passive)
    const exit = process.exit
    let code: number | undefined
    process.exit = ((c?: number) => {
      code = c
    }) as typeof process.exit
    try {
      process.emit("SIGHUP", "SIGHUP")
    } finally {
      process.exit = exit
      process.off("SIGHUP", passive)
    }
    expect(cleaned).toBe(1)
    expect(code).toBe(129)
    expect(readFileSync(file, "utf8")).toStartWith(modes.bracketedPaste.off)
  })
})
