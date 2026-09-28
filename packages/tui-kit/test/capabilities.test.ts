import { expect, test } from "bun:test"
import { modes, queries } from "../src/ansi.ts"
import { detectEnv, parseProbeReplies, setupTerminalInput } from "../src/capabilities.ts"
import { FakeTerminal } from "../src/terminal.ts"

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
