import { expect, test } from "bun:test"
import { pendingBlock } from "../src/images/placement.ts"
import { LiveRenderer } from "../src/renderer.ts"
import { defaultTheme } from "../src/style.ts"
import { FakeTerminal } from "../src/terminal.ts"
import { VirtualScreen } from "./screen.ts"

function setup(historyLines?: number) {
  const terminal = new FakeTerminal(60, 20)
  const screen = new VirtualScreen(60, 20)
  const write = terminal.write.bind(terminal)
  terminal.write = (text) => {
    write(text)
    screen.write(text)
  }
  const renderer = new LiveRenderer(
    terminal,
    { render: () => ["input"] },
    { color: false, theme: defaultTheme, historyLines },
  )
  renderer.start()
  return { terminal, screen, renderer }
}

test("semantic committed blocks repaint in place without losing surrounding history", () => {
  const { screen, renderer } = setup()
  let full = false
  const draw = () => ["btw: question", ...(full ? ["side answer"] : [])]
  try {
    renderer.commit(["before"])
    renderer.commit(draw(), draw)
    renderer.commit(["after"])
    full = true
    renderer.redraw()
    expect(screen.text).toContain("before\nbtw: question\nside answer\nafter\ninput")
    full = false
    renderer.redraw()
    expect(screen.text).toContain("before\nbtw: question\nafter\ninput")
    expect(screen.text).not.toContain("side answer")
  } finally {
    renderer.stop()
  }
})

test("suspended semantic commits keep their own duplicate head and surrounding output", () => {
  const { screen, renderer } = setup()
  let full = false
  const draw = () => ["same head", ...(full ? ["semantic details"] : [])]
  try {
    renderer.suspend()
    renderer.commit(["same head"])
    renderer.commit(["intervening output"])
    renderer.commit(draw(), draw)
    renderer.commit(["after"])
    renderer.resume()
    full = true
    renderer.redraw()
    expect(screen.text).toBe("same head\nintervening output\nsame head\nsemantic details\nafter\ninput")
  } finally {
    renderer.stop()
  }
})

test("adjacent identical semantic heads stay distinct when one redraw becomes empty", () => {
  const { screen, renderer } = setup()
  let expanded = false
  let hidden = false
  const first = () => (hidden ? [] : ["same head", ...(expanded ? ["first details"] : [])])
  const second = () => ["same head", ...(expanded ? ["second details"] : [])]
  try {
    renderer.suspend()
    renderer.commit(first(), first)
    renderer.commit(second(), second)
    renderer.resume()
    expanded = true
    renderer.redraw()
    expect(screen.text).toBe("same head\nfirst details\nsame head\nsecond details\ninput")
    hidden = true
    renderer.redraw()
    expect(screen.text).toBe("same head\nsecond details\ninput")
    hidden = false
    renderer.redraw()
    expect(screen.text).toBe("same head\nfirst details\nsame head\nsecond details\ninput")
  } finally {
    renderer.stop()
  }
})

test("an initially empty semantic commit retains its boundary between duplicate heads", () => {
  const { screen, renderer } = setup()
  let expanded = false
  const draw = () => (expanded ? ["empty block details"] : [])
  try {
    renderer.suspend()
    renderer.commit(["same head"])
    renderer.commit(draw(), draw)
    renderer.commit(["same head"])
    renderer.resume()
    expanded = true
    renderer.redraw()
    expect(screen.text).toBe("same head\nempty block details\nsame head\ninput")
  } finally {
    renderer.stop()
  }
})

test("a semantic commit dropped from suspended history cannot capture a later ordinary head", () => {
  const { screen, renderer } = setup(3)
  const draw = () => ["same head", "discarded semantic details"]
  try {
    renderer.suspend()
    renderer.commit(["same head"], draw)
    renderer.commit(["one", "two", "three"])
    renderer.resume()
    renderer.redraw()
    expect(screen.text).toBe("one\ntwo\nthree\ninput")
    renderer.commit(["same head"])
    renderer.redraw()
    expect(screen.text).toBe("same head\ninput")
  } finally {
    renderer.stop()
  }
})

test("a partially retained semantic commit redraws only its retained tail", () => {
  const { screen, renderer } = setup(3)
  const draw = () => ["same head", "one", "two", "three"]
  try {
    renderer.suspend()
    renderer.commit(draw(), draw)
    renderer.resume()
    renderer.redraw()
    expect(screen.text).toBe("one\ntwo\nthree\ninput")
    renderer.commit(["same head"])
    renderer.redraw()
    expect(screen.text).toBe("same head\ninput")
  } finally {
    renderer.stop()
  }
})

test("a suspended semantic commit retains its identity across pending-block batches", async () => {
  const { screen, renderer } = setup()
  const marker = pendingBlock(Promise.resolve(["resolved one", "resolved two"]), ["loading"])
  const draw = () => ["same head", "semantic details"]
  try {
    renderer.suspend()
    renderer.commit(["same head", "intervening output"])
    renderer.commit(["same head", marker, "tail"], draw)
    renderer.commit(["after"])
    renderer.resume()
    expect(screen.text).toBe("same head\nintervening output\nsame head\nloading\ntail\nafter\ninput")
    await Promise.resolve()
    // This redraw also flushes the pending tail; it must not repaint a partial saved boundary.
    renderer.redraw()
    expect(screen.text).toBe(
      "same head\nintervening output\nsame head\nresolved one\nresolved two\ntail\nafter\ninput",
    )
    renderer.redraw()
    expect(screen.text).toBe("same head\nintervening output\nsame head\nsemantic details\nafter\ninput")
  } finally {
    renderer.stop()
  }
})

test("semantic committed blocks retain their redraw through an overlay suspension", () => {
  const { screen, renderer } = setup()
  let full = false
  const draw = () => ["btw: held", ...(full ? ["held details"] : [])]
  try {
    renderer.suspend()
    renderer.commit(draw(), draw)
    renderer.resume()
    full = true
    renderer.redraw()
    expect(screen.text).toContain("btw: held\nheld details\ninput")
  } finally {
    renderer.stop()
  }
})
