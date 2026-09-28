import { expect, test } from "bun:test"
import { modes } from "../src/ansi.ts"
import { FakeTerminal } from "../src/terminal.ts"

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
