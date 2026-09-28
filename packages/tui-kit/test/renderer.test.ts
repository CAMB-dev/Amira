import { expect, test } from "bun:test"
import { cursor, syncOutput } from "../src/ansi.ts"
import { type Component, CURSOR_MARKER } from "../src/component.ts"
import { LiveRenderer } from "../src/renderer.ts"
import { FakeTerminal } from "../src/terminal.ts"
import { VirtualScreen } from "./screen.ts"

class Lines implements Component {
  constructor(public lines: string[]) {}
  render(): string[] {
    return this.lines
  }
}

function setup(lines: string[], cols = 20, rows = 10, opts = {}) {
  const term = new FakeTerminal(cols, rows)
  const screen = new VirtualScreen(cols, rows)
  const origWrite = term.write.bind(term)
  term.write = (data: string) => {
    origWrite(data)
    screen.write(data)
  }
  const root = new Lines(lines)
  const r = new LiveRenderer(term, root, opts)
  return { term, screen, root, r }
}

test("each frame is one write that starts by hiding the cursor", () => {
  const { term, screen, root, r } = setup(["hello", "world"])
  r.start()
  expect(term.writes.length).toBe(1)
  expect(term.writes[0]!.startsWith(cursor.hide)).toBe(true)
  expect(screen.lines.slice(0, 2)).toEqual(["hello", "world"])
  root.lines = ["hello", "there", "more"]
  r.render()
  expect(term.writes.length).toBe(2)
  expect(term.writes[1]!.startsWith(cursor.hide)).toBe(true)
  expect(screen.text).toBe("hello\nthere\nmore")
  expect(screen.cursorVisible).toBe(false)
})

test("synchronized output wraps the whole frame", () => {
  const { term, r } = setup(["a"], 20, 10, { synchronizedOutput: true })
  r.render()
  const w = term.writes[0]!
  expect(w.startsWith(syncOutput.begin + cursor.hide)).toBe(true)
  expect(w.endsWith(syncOutput.end)).toBe(true)
})

test("only changed lines are rewritten", () => {
  const { term, screen, root, r } = setup(["alpha", "beta", "gamma"])
  r.render()
  root.lines = ["alpha", "BETA", "gamma"]
  r.render()
  const frame = term.writes[1]!
  expect(frame).toContain("BETA")
  expect(frame).not.toContain("alpha")
  expect(frame).not.toContain("gamma")
  expect(screen.text).toBe("alpha\nBETA\ngamma")
})

test("an unchanged frame writes nothing", () => {
  const { term, r } = setup(["same"])
  r.render()
  r.render()
  expect(term.writes.length).toBe(1)
})

test("a shrinking live region clears the rows it no longer uses", () => {
  const { screen, root, r } = setup(["one", "two", "three", "four"])
  r.render()
  root.lines = ["one"]
  r.render()
  expect(screen.text).toBe("one")
  root.lines = ["one", "2"]
  r.render()
  expect(screen.text).toBe("one\n2")
})

test("commit prints lines above the live region and they are never redrawn", () => {
  const { term, screen, root, r } = setup(["> input"])
  r.render()
  r.commit(["first", "second"])
  expect(screen.text).toBe("first\nsecond\n> input")
  root.lines = ["> changed", "status"]
  r.render()
  expect(term.writes.at(-1)).not.toContain("first")
  expect(screen.text).toBe("first\nsecond\n> changed\nstatus")
  r.commit(["third"])
  expect(screen.text).toBe("first\nsecond\nthird\n> changed\nstatus")
})

test("commit scrolls old lines into the scrollback", () => {
  const { screen, r } = setup(["live"], 20, 3)
  r.render()
  r.commit(["a", "b", "c", "d"])
  expect(screen.scrollback).toEqual(["a", "b"])
  expect(screen.lines).toEqual(["c", "d", "live"])
})

test("lines wider than the terminal are truncated by display width", () => {
  const { screen, r } = setup(["abcdefghijklmnop", "你好世界你好"], 10, 5)
  r.render()
  expect(screen.lines.slice(0, 3)).toEqual(["abcdefghij", "你好世界你", ""])
})

test("the live region never grows beyond the terminal height", () => {
  const lines = Array.from({ length: 8 }, (_, i) => `line${i}`)
  const { screen, root, r } = setup(lines, 20, 5)
  r.render()
  expect(screen.lines).toEqual(["line3", "line4", "line5", "line6", "line7"])
  root.lines = [...lines.slice(0, 7), "LAST"]
  r.render()
  expect(screen.lines).toEqual(["line3", "line4", "line5", "line6", "LAST"])
})

test("the cursor is shown only where the focused component asks for it", () => {
  const { term, screen, root, r } = setup(["title", `你好${CURSOR_MARKER}x`])
  r.render()
  const frame = term.writes[0]!
  expect(frame).not.toContain(CURSOR_MARKER)
  expect(frame.endsWith(cursor.column(4) + cursor.show)).toBe(true)
  expect(screen.cursorVisible).toBe(true)
  expect([screen.x, screen.y]).toEqual([4, 1])
  root.lines = [`${CURSOR_MARKER}title`, "你好x"]
  r.render()
  expect([screen.x, screen.y]).toEqual([0, 0])
  root.lines = ["title", "你好x"]
  r.render()
  expect(screen.cursorVisible).toBe(false)
})

test("a cursor-only move still redraws as one hidden-cursor frame", () => {
  const { term, root, r } = setup([`ab${CURSOR_MARKER}`])
  r.render()
  root.lines = [`a${CURSOR_MARKER}b`]
  r.render()
  expect(term.writes.length).toBe(2)
  expect(term.writes[1]).toBe(cursor.hide + cursor.column(1) + cursor.show)
})

test("resize forces a full redraw of the live region", async () => {
  const { term, screen, root, r } = setup(["aaaa", "bbbb"], 20, 10, { frameIntervalMs: 0 })
  r.start()
  root.lines = ["cccc", "dddd"]
  term.setSize(30, 10)
  screen.cols = 30
  await Bun.sleep(5)
  expect(term.writes.length).toBe(2)
  expect(term.writes[1]).toContain("\x1b[J")
  expect(term.writes[1]).toContain("cccc")
  r.stop()
})

test("requestRender coalesces bursts into one frame", async () => {
  const { term, root, r } = setup(["0"], 20, 10, { frameIntervalMs: 10 })
  r.render()
  for (let i = 1; i <= 20; i++) {
    root.lines = [String(i)]
    r.requestRender()
  }
  expect(term.writes.length).toBe(1)
  await Bun.sleep(30)
  expect(term.writes.length).toBe(2)
  expect(term.writes[1]).toContain("20")
})

test("stop leaves the cursor on a fresh line below the live region", () => {
  const { screen, r } = setup(["a", "b"])
  r.render()
  r.stop()
  expect(screen.cursorVisible).toBe(true)
  expect([screen.x, screen.y]).toEqual([0, 2])
})
