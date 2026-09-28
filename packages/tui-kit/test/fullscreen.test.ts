import { expect, test } from "bun:test"
import { modes, RESET } from "../src/ansi.ts"
import type { Component } from "../src/component.ts"
import { ScrollView } from "../src/components/scroll-view.ts"
import { FullScreenRenderer } from "../src/fullscreen.ts"
import { key } from "../src/keys.ts"
import { LiveRenderer } from "../src/renderer.ts"
import { FakeTerminal } from "../src/terminal.ts"
import { plain } from "./context.ts"
import { VirtualScreen } from "./screen.ts"

class Lines implements Component {
  constructor(public lines: string[]) {}
  render(): string[] {
    return this.lines
  }
}

function setup(cols = 20, rows = 6) {
  const term = new FakeTerminal(cols, rows)
  const screen = new VirtualScreen(cols, rows)
  const write = term.write.bind(term)
  term.write = (data: string) => {
    write(data)
    screen.write(data)
  }
  const resize = (c: number, r: number) => {
    screen.resize(c, r)
    term.setSize(c, r)
  }
  return { term, screen, resize }
}

test("open enters the alternate screen with alternate scroll; close leaves both", () => {
  const { term, screen } = setup()
  const full = new FullScreenRenderer(term, new Lines(["view"]))
  full.open()
  expect(term.output.indexOf(modes.altScreen.on)).toBeGreaterThanOrEqual(0)
  expect(term.output).toContain(modes.alternateScroll.on)
  expect(term.output.indexOf(modes.altScreen.on)).toBeLessThan(term.output.indexOf("view"))
  expect(screen.inAltScreen).toBe(true)
  expect(screen.lines[0]).toBe("view")
  expect(screen.cursorVisible).toBe(false)
  term.clearWrites()
  full.close()
  expect(term.output).toBe(modes.alternateScroll.off + modes.altScreen.off)
  expect(screen.inAltScreen).toBe(false)
  expect(full.isOpen).toBe(false)
  // Closing twice writes nothing more; rendering while closed does nothing.
  full.close()
  full.render()
  expect(term.output).toBe(modes.alternateScroll.off + modes.altScreen.off)
})

test("a crash while open restores the main screen: the terminal tracks the modes", () => {
  const { term } = setup()
  new FullScreenRenderer(term, new Lines(["x"])).open()
  term.clearWrites()
  term.restore()
  expect(term.output).toContain(modes.altScreen.off)
  expect(term.output).toContain(modes.alternateScroll.off)
  expect(term.output).toContain(RESET)
})

test("frames fill the screen exactly, cut to its width and height, and rewrite only changed rows", () => {
  const { term, screen } = setup(10, 4)
  const root = new Lines(["one", "two", "a very long line", "four", "five"])
  const full = new FullScreenRenderer(term, root)
  full.open()
  expect(screen.lines).toEqual(["one", "two", "a very lon", "four"])
  term.clearWrites()
  root.lines = ["one", "TWO"]
  full.render()
  expect(term.output).toContain("TWO")
  expect(term.output).not.toContain("one")
  expect(screen.lines).toEqual(["one", "TWO", "", ""])
  term.clearWrites()
  full.render()
  expect(term.output).toBe("")
  // Nothing ever scrolls: the scrollback stays empty.
  expect(screen.scrollback).toEqual([])
})

test("a resize redraws the whole screen at the new size", () => {
  const { term, screen, resize } = setup(10, 4)
  const root = new Lines(["alpha", "beta", "gamma", "delta", "epsilon"])
  const full = new FullScreenRenderer(term, root, { frameIntervalMs: 0 })
  full.open()
  resize(12, 5)
  full.render()
  expect(screen.lines).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"])
  resize(12, 2)
  full.render()
  expect(screen.lines).toEqual(["alpha", "beta"])
  full.close()
})

test("the live region is suspended while a full-screen view is open and comes back exactly", () => {
  const { term, screen } = setup(20, 6)
  const live = new Lines(["› draft", "status"])
  const inline = new LiveRenderer(term, live)
  inline.start()
  inline.commit(["first"])
  const before = screen.mainText
  const full = new FullScreenRenderer(term, new Lines(["VIEW"]))
  inline.suspend()
  full.open()
  expect(inline.isSuspended).toBe(true)
  // Commits and frames while suspended write nothing; the lines are held in order.
  term.clearWrites()
  inline.commit(["second"])
  live.lines = ["› draft2", "status"]
  inline.render()
  inline.requestRender()
  inline.commit(["third"])
  expect(term.output).toBe("")
  expect(screen.lines[0]).toBe("VIEW")
  expect(screen.mainText).toBe(before)
  full.close()
  inline.resume()
  expect(screen.inAltScreen).toBe(false)
  expect(screen.mainText).toBe("first\nsecond\nthird\n› draft2\nstatus")
  expect(screen.mainText).not.toContain("VIEW")
})

test("a resize while suspended is handled when resuming", () => {
  const { term, screen, resize } = setup(20, 6)
  const inline = new LiveRenderer(term, new Lines(["live one", "live two"]))
  inline.start()
  inline.commit(["kept"])
  const full = new FullScreenRenderer(term, new Lines(["VIEW"]))
  inline.suspend()
  full.open()
  resize(30, 8)
  full.close()
  inline.resume()
  expect(screen.mainText).toBe("kept\nlive one\nlive two")
})

test("stop resumes a suspended renderer, so held lines are not lost", () => {
  const { term, screen } = setup(20, 6)
  const inline = new LiveRenderer(term, new Lines(["live"]))
  inline.start()
  inline.suspend()
  inline.commit(["held"])
  inline.stop({ clear: true })
  expect(screen.mainText).toBe("held")
})

function scrollView(n: number, height: number) {
  const lines = Array.from({ length: n }, (_, i) => `line ${i + 1}`)
  const view = new ScrollView(() => lines)
  view.height = height
  return { view, lines }
}

test("a scroll view follows the tail as content grows until scrolled up", () => {
  const { view, lines } = scrollView(10, 3)
  expect(view.render(20, plain)).toEqual(["line 8", "line 9", "line 10"])
  lines.push("line 11")
  expect(view.render(20, plain)).toEqual(["line 9", "line 10", "line 11"])
  view.handleInput(key("up"))
  expect(view.render(20, plain)).toEqual(["line 8", "line 9", "line 10"])
  expect(view.position.following).toBe(false)
  // Content that arrives while reading does not move the view.
  lines.push("line 12")
  expect(view.render(20, plain)).toEqual(["line 8", "line 9", "line 10"])
  view.handleInput(key("down"))
  view.handleInput(key("down"))
  expect(view.position.following).toBe(true)
  lines.push("line 13")
  expect(view.render(20, plain)).toEqual(["line 11", "line 12", "line 13"])
})

test("a scroll view pages, jumps to either end and pads short content", () => {
  const { view } = scrollView(20, 5)
  view.render(20, plain)
  view.handleInput(key("pageup"))
  expect(view.render(20, plain)[0]).toBe("line 12")
  view.handleInput(key("home"))
  expect(view.render(20, plain)).toEqual(["line 1", "line 2", "line 3", "line 4", "line 5"])
  view.handleInput(key("up"))
  expect(view.position.top).toBe(0)
  view.handleInput(key("pagedown"))
  expect(view.render(20, plain)[0]).toBe("line 5")
  view.handleInput(key("end"))
  expect(view.render(20, plain).at(-1)).toBe("line 20")
  expect(view.position).toEqual({ top: 15, height: 5, total: 20, following: true })
  expect(view.handleInput(key("x"))).toBe(false)
  const short = scrollView(2, 4).view
  expect(short.render(20, plain)).toEqual(["line 1", "line 2", "", ""])
})
