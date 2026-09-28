import { expect, test } from "bun:test"
import { osc, progressSupported } from "../src/osc.ts"
import { VirtualScreen } from "./screen.ts"

test("title and progress are OSC strings the screen does not draw", () => {
  const screen = new VirtualScreen(20, 3)
  screen.write(`a${osc.title("Amira · proj\x1b\x07x")}${osc.progress("indeterminate")}b${osc.bell}`)
  expect(screen.lines[0]).toBe("ab")
  expect(screen.oscs).toEqual(["0;Amira · projx", "9;4;3;0"])
  expect(screen.bells).toBe(1)
})

test("progress percent is clamped and states map to their codes", () => {
  expect(osc.progress("none")).toBe("\x1b]9;4;0;0\x07")
  expect(osc.progress("paused", 140)).toBe("\x1b]9;4;4;100\x07")
  expect(osc.progress("error", 12.4)).toBe("\x1b]9;4;2;12\x07")
})

test("progress is only sent where OSC 9;4 is known to mean progress", () => {
  expect(progressSupported({ WT_SESSION: "x" })).toBe(true)
  expect(progressSupported({ TERM_PROGRAM: "vscode" })).toBe(true)
  expect(progressSupported({ TERM_PROGRAM: "iTerm.app", WT_SESSION: "x" })).toBe(false)
  expect(progressSupported({})).toBe(false)
})
