import { expect, test } from "bun:test"
import { cursor, syncOutput } from "../src/ansi.ts"
import { type Component, CURSOR_MARKER, type RenderContext } from "../src/component.ts"
import { Text } from "../src/components/text.ts"
import { LiveRenderer } from "../src/renderer.ts"
import { bold, defaultTheme, red } from "../src/style.ts"
import { FakeTerminal } from "../src/terminal.ts"
import { truncateToWidth } from "../src/width.ts"
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

test("escape sequences in content cannot move the cursor or erase committed lines", () => {
  const hostile = "out: \x1b[3A\x1b[2Kwrecked\x1b[J\r\x08!"
  const { screen, root, r } = setup(["live"], 30, 8)
  r.render()
  r.commit(["committed 1", "committed 2", "committed 3"])
  r.commit([hostile, `x\x1b[1G\x1b[2Ky`])
  root.lines = [...new Text(hostile).render(30), truncateToWidth(hostile, 30)]
  r.render()
  expect(screen.text).toBe(
    [
      "committed 1",
      "committed 2",
      "committed 3",
      "out: wrecked!",
      "xy",
      "out: wrecked",
      "!",
      "out: wrecked!",
    ].join("\n"),
  )
})

test("after stop, render, requestRender and commit do nothing until started again", async () => {
  const { term, screen, root, r } = setup(["live1", "live2"], 20, 10, { frameIntervalMs: 0 })
  r.render()
  r.stop()
  r.stop()
  const writes = term.writes.length
  root.lines = ["spin"]
  r.render()
  r.requestRender()
  r.commit(["late"])
  await Bun.sleep(5)
  expect(term.writes.length).toBe(writes)
  expect(screen.text).toBe("live1\nlive2")
  r.start()
  expect(screen.text).toBe("live1\nlive2\nspin")
  r.stop()
})

test("stop cancels a scheduled frame", async () => {
  const { term, root, r } = setup(["a"], 20, 10, { frameIntervalMs: 10 })
  r.render()
  root.lines = ["b"]
  r.requestRender()
  r.stop()
  const writes = term.writes.length
  await Bun.sleep(30)
  expect(term.writes.length).toBe(writes)
})

test("after a narrowing resize, only the live region's own rows are erased", () => {
  const { term, screen, root, r } = setup(["x", "y", "zzzzzzzzz"], 10, 10)
  r.commit(["kept"])
  root.lines = ["X", "y", "zzzzzzzzz"]
  r.render()
  // The terminal re-wraps "zzzzzzzzz" onto two rows; the cursor is on the first of them.
  term.columns = 5
  root.lines = ["X", "y", "zz"]
  term.setSize(5, 10)
  r.render()
  const frame = term.writes.at(-1)!
  expect(frame.startsWith(`${cursor.hide}\r${cursor.up(2)}\x1b[J`)).toBe(true)
  screen.cols = 5
  expect(screen.lines[0]).toBe("kept")
})

test("a caret beyond the visible width hides the cursor", () => {
  const { screen, root, r } = setup([`0123456789abc${CURSOR_MARKER}`], 10, 5)
  r.render()
  expect(screen.cursorVisible).toBe(false)
  root.lines = [`0123456789${CURSOR_MARKER}`]
  r.render()
  expect(screen.cursorVisible).toBe(false)
  root.lines = [`012345678${CURSOR_MARKER}9`]
  r.render()
  expect(screen.cursorVisible).toBe(true)
  expect(screen.x).toBe(9)
})

test("components get the renderer's theme, and colors are stripped when off", () => {
  const theme = { ...defaultTheme, accent: red }
  const seen: RenderContext[] = []
  const root: Component = {
    render: (_w, ctx) => {
      seen.push(ctx)
      return [ctx.theme.accent("a") + bold("b")]
    },
  }
  const term = new FakeTerminal(20, 5)
  const r = new LiveRenderer(term, root, { theme, color: false })
  r.render()
  expect(seen[0]).toMatchObject({ theme, color: false, rows: 5 })
  expect(term.output).not.toContain("\x1b[31m")
  expect(term.output).toContain("a\x1b[1mb\x1b[22m")
  r.commit([red("c")])
  expect(term.writes.at(-1)).not.toContain("\x1b[31m")
  r.context.color = true
  r.commit([red("d")])
  expect(term.writes.at(-1)).toContain("\x1b[31md")
})

test("the render context carries the terminal height", () => {
  const rows: number[] = []
  const root: Component = {
    render: (_w, ctx) => {
      rows.push(ctx.rows)
      return ["a"]
    },
  }
  const term = new FakeTerminal(20, 5)
  const r = new LiveRenderer(term, root)
  expect(r.context.rows).toBe(5)
  r.render()
  term.setSize(20, 9)
  r.render()
  expect(rows).toEqual([5, 9])
})

test("a component can commit lines while rendering; they print above the frame in the same write", () => {
  const term = new FakeTerminal(20, 4)
  const screen = new VirtualScreen(20, 4)
  const write = term.write.bind(term)
  term.write = (d: string) => {
    write(d)
    screen.write(d)
  }
  let pending: string[] = []
  let kept: RenderContext | undefined
  const root: Component = {
    render: (_w, ctx) => {
      kept = ctx
      ctx.commit?.(pending)
      pending = []
      return ["live"]
    },
  }
  const r = new LiveRenderer(term, root)
  r.render()
  r.commit(["explicit"])
  const writes = term.writes.length
  pending = ["row 1", "row 2\nrow 3"]
  r.render()
  expect(term.writes.length).toBe(writes + 1)
  expect(screen.text).toBe(["explicit", "row 1", "row 2", "row 3", "live"].join("\n"))
  // Explicit commits go first: the frame's own lines were below them, in the live region.
  pending = ["from frame"]
  r.commit(["from app"])
  expect(screen.text).toBe(
    ["explicit", "row 1", "row 2", "row 3", "from app", "from frame", "live"].join("\n"),
  )
  // A context kept past its frame cannot commit.
  kept!.commit!(["late"])
  r.render()
  expect(screen.text).not.toContain("late")
})
