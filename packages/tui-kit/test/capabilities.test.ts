import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { modes, queries } from "../src/ansi.ts"
import {
  detectEnv,
  parseProbeReplies,
  probeTerminal,
  setupTerminalInput,
  supportsHyperlinks,
} from "../src/capabilities.ts"
import { InputReader } from "../src/reader.ts"
import { FakeTerminal, ProcessTerminal } from "../src/terminal.ts"

test("detectEnv: Windows Terminal unless running inside VS Code", () => {
  expect(detectEnv({ WT_SESSION: "x" })).toEqual({ windowsTerminal: true, vscode: false })
  expect(detectEnv({ WT_SESSION: "x", TERM_PROGRAM: "vscode" })).toEqual({
    windowsTerminal: false,
    vscode: true,
  })
  expect(detectEnv({})).toEqual({ windowsTerminal: false, vscode: false })
})

test("parseProbeReplies reads kitty, DECRQM and DA1 replies and keeps other input", () => {
  const r = parseProbeReplies("a\x1b[?1u\x1b[?2026;2$yb\x1b[?62;22c")
  expect(r).toEqual({ kittyKeyboard: true, synchronizedOutput: true, complete: true, rest: "ab" })
  expect(parseProbeReplies("\x1b[?2026;0$y").synchronizedOutput).toBe(false)
  expect(parseProbeReplies("\x1b[?2026;4$y").synchronizedOutput).toBe(false)
  expect(parseProbeReplies("\x1b[?2026;1$y").complete).toBe(false)
})

test("Windows Terminal: win32-input-mode, no kitty query", async () => {
  const term = new FakeTerminal()
  const pending = setupTerminalInput(term, { WT_SESSION: "1" })
  expect(term.writes[0]).toBe(queries.syncOutput + queries.primaryDeviceAttributes)
  term.send("\x1b[?2026;2$y\x1b[?61;6;7;22;23;24;28;32;42c")
  const { capabilities } = await pending
  expect(capabilities).toEqual({
    win32InputMode: true,
    kittyKeyboard: false,
    synchronizedOutput: true,
    shiftEnter: true,
  })
  expect(term.writes).toContain(modes.win32Input.on)
  expect(term.writes).toContain(modes.bracketedPaste.on)
})

test("VS Code never gets win32-input-mode", async () => {
  const term = new FakeTerminal()
  const { capabilities } = await setupTerminalInput(
    term,
    { WT_SESSION: "1", TERM_PROGRAM: "vscode" },
    { timeoutMs: 10 },
  )
  expect(capabilities.win32InputMode).toBe(false)
  expect(capabilities.shiftEnter).toBe(false)
  expect(term.output).not.toContain(modes.win32Input.on)
})

test("kitty keyboard is enabled when the terminal replies, and popped on restore", async () => {
  const term = new FakeTerminal()
  const pending = setupTerminalInput(term, {})
  expect(term.writes[0]!.startsWith(queries.kittyKeyboard)).toBe(true)
  term.send("x\x1b[?0u\x1b[?62c")
  const result = await pending
  expect(result.capabilities.kittyKeyboard).toBe(true)
  expect(result.leftoverInput).toBe("x")
  expect(term.writes).toContain(modes.kittyKeyboard.on)
  term.restore()
  expect(term.output).toContain(modes.kittyKeyboard.off)
})

test("falls back to legacy mode after the timeout when nothing replies", async () => {
  const term = new FakeTerminal()
  const { capabilities } = await setupTerminalInput(term, {}, { timeoutMs: 10 })
  expect(capabilities).toEqual({
    win32InputMode: false,
    kittyKeyboard: false,
    synchronizedOutput: false,
    shiftEnter: false,
  })
})

test("a reply cut short at the timeout gets more time and never leaks into the input", async () => {
  const term = new FakeTerminal()
  const pending = probeTerminal(term, { timeoutMs: 10, lateReplyMs: 40 })
  term.send("a\x1b[?62;")
  await Bun.sleep(20)
  term.send("22c")
  expect(await pending).toMatchObject({ complete: true, rest: "a" })

  const cut = probeTerminal(term, { timeoutMs: 10, lateReplyMs: 10 })
  term.send("b\x1b[?2026;")
  expect(await cut).toMatchObject({ complete: false, rest: "b" })
})

test("WT_SESSION inherited by tmux or WSL is not Windows Terminal", () => {
  expect(detectEnv({ WT_SESSION: "x", TMUX: "/tmp/tmux-1000/default,1,0" }).windowsTerminal).toBe(false)
  expect(detectEnv({ WT_SESSION: "x", WSL_DISTRO_NAME: "Ubuntu" }).windowsTerminal).toBe(false)
})

test("setup enables raw mode and refuses to run under an active InputReader", async () => {
  const term = new FakeTerminal()
  await setupTerminalInput(term, {}, { timeoutMs: 5 })
  expect(term.isRaw).toBe(true)
  term.restore()
  expect(term.isRaw).toBe(false)
  const reader = new InputReader(term, () => {})
  reader.start()
  await expect(setupTerminalInput(term, {}, { timeoutMs: 5 })).rejects.toThrow("InputReader")
  reader.stop()
  await setupTerminalInput(term, {}, { timeoutMs: 5 })
})

test("setup starts a ProcessTerminal that was not started, so the replies reach it", async () => {
  const stdin = new PassThrough()
  const stdout = Object.assign(new EventEmitter(), {
    columns: 80,
    rows: 24,
    write: (data: string) => {
      if (data.includes(queries.primaryDeviceAttributes))
        setTimeout(() => stdin.write("\x1b[?1u\x1b[?62c"), 1)
      return true
    },
  })
  const term = new ProcessTerminal(stdin as any, stdout as any)
  try {
    const { capabilities } = await setupTerminalInput(term, {}, { timeoutMs: 1000 })
    expect(capabilities.kittyKeyboard).toBe(true)
  } finally {
    term.stop()
  }
})

test("supportsHyperlinks: Windows Terminal and VS Code yes, tmux and unknown terminals no, FORCE_HYPERLINK wins", () => {
  expect(supportsHyperlinks({ WT_SESSION: "1" })).toBe(true)
  expect(supportsHyperlinks({ TERM_PROGRAM: "vscode" })).toBe(true)
  expect(supportsHyperlinks({ WT_SESSION: "1", TMUX: "/tmp/tmux" })).toBe(false)
  expect(supportsHyperlinks({ TERM: "xterm-256color" })).toBe(false)
  expect(supportsHyperlinks({ VTE_VERSION: "6800" })).toBe(true)
  expect(supportsHyperlinks({ FORCE_HYPERLINK: "1" })).toBe(true)
  expect(supportsHyperlinks({ WT_SESSION: "1", FORCE_HYPERLINK: "0" })).toBe(false)
})