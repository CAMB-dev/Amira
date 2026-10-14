import { expect, test } from "bun:test"
import type { UserMessage } from "@amira/api"
import {
  defaultTheme,
  FakeTerminal,
  key,
  type MouseInput,
  Spinner,
  stripAnsi,
  surfaceTheme,
  visibleWidth,
} from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { type BlockEnv, LinesBlock, userBlock } from "../src/blocks.ts"
import { localClock, rememberMessageTime } from "../src/format.ts"
import { historyBlocks } from "../src/fullscreen/history-blocks.ts"
import { createMouse } from "../src/fullscreen/mouse.ts"
import { createFullscreenView } from "../src/fullscreen-view.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"
import {
  stickyPrompt,
  stickyPromptLine,
  stickyPromptLines,
  stickyPromptOverlay,
} from "../src/pane/sticky-prompt.ts"
import { TranscriptPane } from "../src/transcript-pane.ts"

const at = new Date(2026, 9, 10, 20, 9).getTime()
const clock = localClock(at)
const clockCells = visibleWidth(clock)
const env: BlockEnv = {
  theme: plain.theme,
  width: 100,
  now: at,
  spinner: "*",
  detail: "summary",
  presenters: undefined,
  hyperlinks: false,
  nodes: new Map(),
}
const message = (text: string): UserMessage => {
  const m: UserMessage = { role: "user", content: [{ type: "text", text }] }
  rememberMessageTime(m, at)
  return m
}
const output = (count: number, prefix = "row") =>
  new LinesBlock("assistant", () => Array.from({ length: count }, (_, i) => `  ${prefix} ${i}`))
const pinned = (pane: TranscriptPane) => (pane.padding ? undefined : stickyPrompt(pane.blocks, pane.layout))
const mouseEvent = (action: MouseInput["action"], y: number, x = 5): MouseInput => ({
  type: "mouse",
  action,
  button: "left",
  x,
  y,
  ctrl: false,
  alt: false,
  shift: false,
})

test("a prompt pins after output grows, switches to the topmost turn, and enters identically when its band reaches the top", () => {
  const pane = new TranscriptPane()
  const older = userBlock(message("Older prompt\nSecond line"))
  pane.add(older)
  pane.render(env, 5)
  expect(pinned(pane)).toBeUndefined()
  pane.add(output(12, "older"))
  pane.render(env, 5)
  expect(pinned(pane)).toBe(older)
  const newer = userBlock(message("Newer prompt"))
  pane.add(newer)
  pane.add(output(12, "newer"))
  pane.render(env, 5)
  expect(pinned(pane)).toBe(newer)
  pane.scrollBy(-14)
  pane.render(env, 5)
  expect(pinned(pane)).toBe(older)
  pane.toBlock(older)
  pane.render(env, 5)
  expect(pinned(pane)).toBe(older)
  pane.scrollBy(1)
  pane.render(env, 5)
  // The first row has scrolled away even though the second line of the real band remains.
  expect(pinned(pane)).toBe(older)
})

test("natural entry pins at the real band's top edge without changing any ANSI row", () => {
  for (const theme of [plain.theme, { ...defaultTheme, ...surfaceTheme("dark") }]) {
    const frameEnv = { ...env, theme }
    const pane = new TranscriptPane()
    const prompt = userBlock(message("One\nTwo\nThree\nFour"))
    pane.add(prompt)
    pane.add(output(30))
    pane.render(frameEnv, 20)
    pane.toTop()
    const real = pane.render(frameEnv, 20)
    expect(pinned(pane)).toBe(prompt)
    const sticky = stickyPromptLines(prompt, frameEnv, 20)
    expect(sticky).toEqual(real.slice(0, sticky.length))
    expect(
      pane.render(frameEnv, 20, (layout) => stickyPromptOverlay(pane.blocks, layout, frameEnv, 20).lines),
    ).toEqual(real)
  }
})

test("commands, origin notices and session boundaries never become sticky prompts", () => {
  const pane = new TranscriptPane()
  pane.add(new LinesBlock("command", () => ["  › /status"], "/status"))
  pane.add(output(10))
  pane.render(env, 4)
  expect(pinned(pane)).toBeUndefined()
  const real = userBlock(message("Real prompt"))
  pane.add(real)
  pane.add(new LinesBlock("command", () => ["  › /help"], "/help"))
  pane.add(userBlock({ ...message("Agent finished"), display: { text: "Agent finished", origin: "agent" } }))
  pane.add(output(10))
  pane.render(env, 4)
  expect(pinned(pane)).toBe(real)
  pane.add(new LinesBlock("history", () => ["next session"]))
  pane.add(output(10))
  pane.render(env, 4)
  expect(pinned(pane)).toBeUndefined()
  pane.clear(() => false)
  pane.render(env, 4)
  expect(pinned(pane)).toBeUndefined()
})

test("the single sticky row uses the band, accent, first-line ellipsis and original right-hand clock", () => {
  const banded = { ...env, theme: { ...defaultTheme, ...surfaceTheme("dark") } }
  const block = userBlock(message("First line\nHidden second line"))
  const row = stickyPromptLine(block, banded)
  expect(stripAnsi(row)).toBe(`› First line…${" ".repeat(87 - clockCells)}${clock}`)
  expect(row).toContain(banded.theme.accent("›"))
  expect(row).toContain(banded.theme.muted(clock))
  expect(row).toContain("\x1b[48;2;")
  expect(visibleWidth(row)).toBe(100)
  const long = userBlock(message("界".repeat(100)))
  const longRow = stripAnsi(stickyPromptLine(long, banded))
  expect(longRow).toContain("…")
  expect(longRow).toEndWith(`${clock}`)
  expect(visibleWidth(longRow)).toBe(100)
  for (const width of [1, 8, 15, 16, 30]) {
    const narrow = stickyPromptLine(long, { ...banded, width })
    expect(visibleWidth(narrow)).toBe(width)
    expect(narrow).not.toContain("\n")
  }
  const old = userBlock({ role: "user", content: [{ type: "text", text: "Old prompt" }] })
  expect(stickyPromptLine(old, env)).not.toContain(clock)
})

test("the reserved sticky slot never changes scrolling, match counts, selection or rows-below math", () => {
  const pane = new TranscriptPane()
  const prompt = userBlock(message("needle prompt"))
  const reply = output(30, "needle")
  pane.add(prompt)
  pane.add(reply)
  pane.render(env, 6)
  const first = pane.layout[0]!
  expect(first).toEqual({ block: reply, line: 24 })
  expect(pinned(pane)).toBe(prompt)
  pane.scrollBy(-5)
  pane.render(env, 6)
  expect(pane.layout[0]).toEqual({ block: reply, line: 19 })
  expect(pane.rowsBelow).toBe(5)
  pane.selectLine(0, 4)
  expect(pane.selectedText()).toBe("  needle 19")
  pane.find("needle")
  pane.render(env, 6)
  expect(pane.matchCount).toBe(31) // The pinned duplicate is not indexed.
  expect(pinned(pane)).toBe(prompt)
  pane.stepMatch(-1)
  pane.render(env, 6)
  expect(pane.matchPosition).toBe(25)
  pane.clearFind()
  pane.select(reply)
  pane.render(env, 6)
  expect(pane.selected).toBe(reply)
  expect(pinned(pane)).toBe(prompt)
  pane.toBlock(prompt)
  pane.render(env, 6)
  expect(pane.layout[0]).toEqual({ block: prompt, line: 0 })
  expect(pinned(pane)).toBe(prompt)
})

test("clicking the sticky slot jumps to its full message, never starts a drag or copies the preview", () => {
  const pane = new TranscriptPane()
  const prompt = userBlock(message("First line\nEntire second line"))
  pane.add(prompt)
  pane.add(output(20))
  pane.render(env, 5)
  const terminal = new FakeTerminal(100, 10)
  const mouse = createMouse({
    pane,
    paneRows: () => 5,
    paneTop: () => 2,
    stickyPrompt: () => pinned(pane),
    stickyRows: () => 1,
    requestRender: () => {},
    showNote: () => {},
    terminal,
  })
  mouse.mouse(mouseEvent("press", 2))
  mouse.mouse(mouseEvent("release", 2))
  expect(pane.dragging).toBe(false)
  expect(pane.selectedText()).toBe("")
  expect(terminal.output).not.toContain("\x1b]52;")
  pane.render(env, 5)
  expect(pane.layout[0]).toEqual({ block: prompt, line: 0 })
  expect(pinned(pane)).toBe(prompt)
  // The first content row is still at paneTop, not at the sticky slot.
  mouse.mouse(mouseEvent("press", 3, 2))
  mouse.mouse(mouseEvent("drag", 3, 24))
  mouse.mouse(mouseEvent("release", 3, 24))
  expect(pane.selectedText()).toContain("Entire second line")
  expect(pane.selectedText()).not.toContain(clock)
  mouse.stopEdgeScroll()
})

function fullscreen(withHeader = true, height = 12, theme = plain.theme, width = 100, margin = 0) {
  const terminal = new FakeTerminal(width, height)
  const screen = new VirtualScreen(width, height)
  const write = terminal.write.bind(terminal)
  terminal.write = (data) => {
    write(data)
    screen.write(data)
  }
  const view = createFullscreenView({
    terminal,
    theme,
    capabilities: { win32InputMode: false, kittyKeyboard: true, synchronizedOutput: false, shiftEnter: true },
    settings: { margin, marginRows: 0 },
    presenters: undefined,
    hyperlinks: false,
    renders: new ReplyRenderers(undefined),
    keys: new Keybindings(defaultKeys({ vscode: false })),
    spinner: new Spinner(),
    sessionId: () => "test",
    detail: () => "summary",
    header: withHeader ? () => [" Amira · project"] : undefined,
    bottom: () => ["input"],
    overlay: { render: () => [] },
    editorEmpty: () => true,
    showNote: () => {},
  })
  view.start()
  return { view, terminal, screen }
}

test("fullscreen reserves the header gap, overlays below the fixed header gap and keeps mouse/search coordinates", () => {
  const { view, terminal, screen } = fullscreen()
  try {
    view.user(message("Fix the transcript\nKeep every row reachable"))
    view.replyDelta(Array.from({ length: 20 }, (_, i) => `Result ${i}`).join("\n\n"))
    view.replyEnd([])
    view.render()
    expect(screen.lines[0]).toBe(" Amira · project")
    expect(screen.lines[2]).toBe(`› Fix the transcript…${" ".repeat(79 - clockCells)}${clock}`)
    const tail = screen.lines.slice(3, 10)
    view.handleInput(key("up", { shift: true }))
    view.render()
    expect(screen.lines.slice(4, 10)).toEqual(tail.slice(0, 6))
    expect(screen.lines[10]).toContain("1 row below")
    view.handleInput(key("f", { ctrl: true }))
    view.handleInput({ type: "paste", text: "Fix the transcript" })
    view.render()
    expect(screen.lines[1]).toBe("")
    expect(screen.lines.join("\n")).toContain("1/1")
    view.handleInput(key("escape"))
    view.handleInput(key("end"))
    view.render()
    expect(screen.lines[2]).toContain("Fix the transcript…")
    view.handleInput(mouseEvent("press", 2))
    view.handleInput(mouseEvent("release", 2))
    view.render()
    expect(screen.lines[1]).toBe("")
    // Jumping to the real compact-entry row must not replace it with the preview.
    expect(screen.lines[2]).toBe(`› Fix the transcript${" ".repeat(80 - clockCells)}${clock}`)
    expect(screen.lines.filter((row) => row.includes("Fix the transcript"))).toHaveLength(1)
    expect(screen.lines[3]).toContain("Keep every row reachable")
    expect(terminal.output).not.toContain("\x1b]52;")
  } finally {
    view.stop()
  }
  // Exiting prints the real transcript once, never its pinned preview.
  expect(screen.mainText).not.toContain("Fix the transcript…")
  expect(screen.mainText.match(/Fix the transcript/g)).toHaveLength(1)
})

test("sticky previews sanitize controls and tabs just like user rows, and honor ASCII ellipses", () => {
  const previous = { ...glyphs }
  try {
    setGlyphs({ user: ">", more: "." })
    const block = userBlock(message("A\tB\x00\x07\x1b[2J\x1b]0;injected\x07C\rD\nnext"))
    const row = stickyPromptLine(block, env)
    expect(stripAnsi(row)).toStartWith("> A   BC.")
    expect(row).not.toContain("\t")
    expect(row).not.toContain("\x00")
    expect(row).not.toContain("\x07")
    expect(row).not.toContain("\x1b[2J")
    expect(row).not.toContain("injected")
    expect(row).not.toContain("…")
    const long = stickyPromptLine(userBlock(message("long".repeat(30))), { ...env, width: 30 })
    expect(stripAnsi(long)).toEndWith(`.  ${clock}`)
    expect(visibleWidth(long)).toBe(30)
  } finally {
    setGlyphs(previous)
  }
})

test("resumed history never pins a prompt, while newly sent prompts still do", () => {
  const pane = new TranscriptPane()
  const blocks = historyBlocks([message("Old prompt")], () => env, {
    hyperlinks: false,
    sessionId: () => "resumed",
    terminal: { columns: 100 },
    noticeBlock: () => new LinesBlock("notice", () => []),
  })
  for (const block of blocks) pane.add(block)
  pane.add(output(20))
  pane.render(env, 5)
  expect(pinned(pane)).toBeUndefined()
  const live = userBlock(message("New prompt"))
  pane.add(live)
  pane.add(output(20))
  pane.render(env, 5)
  expect(pinned(pane)).toBe(live)
})

test("fullscreen without a header reserves no slot and never draws an offscreen sticky row", () => {
  const { view, screen } = fullscreen(false)
  try {
    view.user(message("No header"))
    view.replyDelta(Array.from({ length: 20 }, (_, i) => `Result ${i}`).join("\n\n"))
    view.replyEnd([])
    view.handleInput(key("home"))
    view.render()
    expect(screen.lines[0]).toBe(`› No header${" ".repeat(89 - clockCells)}${clock}`)
    view.handleInput(key("end"))
    view.render()
    expect(screen.lines.slice(0, 10).filter((row) => row.includes("Result"))).toHaveLength(5)
    expect(screen.lines.join("\n")).not.toContain("No header")
    const tail = screen.lines.slice(0, 10)
    view.handleInput(key("up", { shift: true }))
    view.render()
    expect(screen.lines.slice(1, 10)).toEqual(tail.slice(0, 9))
  } finally {
    view.stop()
  }
})

test("painted band pins from its own top padding, not a frame after the first text row", () => {
  const banded = { ...env, theme: { ...defaultTheme, ...surfaceTheme("dark") } }
  const pane = new TranscriptPane()
  const prompt = userBlock(message("First text\nSecond text"))
  pane.add(prompt)
  pane.add(output(20))
  pane.render(banded, 6)
  pane.toBlock(prompt)
  pane.render(banded, 6)
  expect(prompt.promptRow).toBe(1)
  expect(pinned(pane)).toBe(prompt)
  pane.scrollBy(1)
  pane.render(banded, 6)
  expect(pane.layout[0]).toEqual({ block: prompt, line: 1 })
  expect(pinned(pane)).toBe(prompt)
  pane.scrollBy(1)
  pane.render(banded, 6)
  expect(pane.layout[0]).toEqual({ block: prompt, line: 2 })
  expect(pinned(pane)).toBe(prompt)
  const sticky = stickyPromptLine(prompt, banded)
  expect(sticky.split("\n")).toHaveLength(1)
  expect(sticky).toContain("\x1b[48;2;32;32;32m")
})

test("selecting a whole message marks text but leaves the painted padding unselected", () => {
  const banded = { ...env, theme: { ...defaultTheme, ...surfaceTheme("dark") } }
  const pane = new TranscriptPane()
  const prompt = userBlock(message("Only text"))
  pane.add(prompt)
  pane.add(output(20))
  pane.render(banded, 6)
  pane.toBlock(prompt)
  const before = pane.render(banded, 6)
  pane.select(prompt)
  const after = pane.render(banded, 6)
  expect(after[0]).toBe(before[0])
  expect(after[2]).toBe(before[2])
  expect(after[0]).toContain("\x1b[48;2;32;32;32m")
  expect(after[1]).not.toBe(before[1])
  expect(prompt.copyText()).toBe("Only text")
})

test("expanded sticky bands match transcript wrapping, painted padding, marker and clock", () => {
  const banded = { ...env, theme: { ...defaultTheme, ...surfaceTheme("dark") } }
  for (const text of ["First line\nSecond line", "界 word ".repeat(20), "A\tB\x00\x07\x1b[2JC\nD"]) {
    const block = userBlock(message(text))
    const real = block.lines(banded)
    const sticky = stickyPromptLines(block, banded, 12)
    expect(sticky).toEqual(real)
    expect(sticky[0]).toBe(banded.theme.userBg!(" ".repeat(100)))
    expect(sticky.at(-1)).toBe(sticky[0])
    expect(sticky[0]).toContain("\x1b[48;2;32;32;32m")
    expect(sticky.at(-1)).toContain("\x1b[48;2;32;32;32m")
    expect(sticky[1]).toContain(banded.theme.accent(glyphs.user))
    expect(sticky[1]).toContain(banded.theme.muted(clock))
    expect(sticky.every((row) => visibleWidth(row) === 100)).toBe(true)
    expect(sticky.join("\n")).not.toContain("\x1b[2J")
  }
})

test("expanded bands cap at three actual text rows without mutating the natural entry", () => {
  const previous = { ...glyphs }
  try {
    setGlyphs({ user: ">", more: "." })
    const banded = { ...env, theme: { ...defaultTheme, ...surfaceTheme("dark") }, width: 30 }
    for (const text of ["界".repeat(100), "One\nTwo\nThree\nFour", "word ".repeat(50)]) {
      const block = userBlock(message(text))
      const real = block.lines(banded)
      const sticky = stickyPromptLines(block, banded, 12)
      expect(sticky).toHaveLength(4)
      expect(sticky.slice(0, 3)).toEqual(real.slice(0, 3))
      expect(sticky[3]).toBe(real[3])
      expect(stripAnsi(sticky[3]!)).toStartWith("  ")
      expect(sticky.every((row) => visibleWidth(row) === 30)).toBe(true)
      expect(sticky).toEqual(real.slice(0, 4))
      expect(stickyPromptLines(block, banded, 11)).toEqual([stickyPromptLine(block, banded)])
    }
    for (const width of [1, 8, 15, 16]) {
      const sticky = stickyPromptLines(userBlock(message("long".repeat(30))), { ...banded, width }, 12)
      expect(sticky).toHaveLength(4)
      expect(sticky.every((row) => visibleWidth(row) === width)).toBe(true)
    }
  } finally {
    setGlyphs(previous)
  }
})

// E intentionally replaces variable pane budgets with a nonselectable constant-height overlay.
test("overlay keeps page, wheel, find and row-count geometry at the full pane height", () => {
  const banded = { ...env, theme: { ...defaultTheme, ...surfaceTheme("dark") } }
  const pane = new TranscriptPane()
  const prompt = userBlock(message("First line\nSecond line"))
  const reply = output(60, "needle")
  pane.add(prompt)
  pane.add(reply)
  const render = () =>
    pane.render(banded, 20, (layout) => stickyPromptOverlay(pane.blocks, layout, banded, 20).lines)
  expect(render()).toHaveLength(20)
  expect(pane.layout[0]).toEqual({ block: reply, line: 40 })
  pane.pageUp()
  render()
  expect(pane.layout[0]).toEqual({ block: reply, line: 21 })
  expect(pane.rowsBelow).toBe(19)
  pane.selectLine(4, 5)
  expect(pane.selectedText()).toBe("  needle 25")
  pane.pageDown()
  render()
  expect(pane.following).toBe(true)
  expect(pane.layout[0]).toEqual({ block: reply, line: 40 })
  const mouse = createMouse({
    pane,
    paneRows: () => 20,
    paneTop: () => 5,
    stickyRows: () => 4,
    stickyPrompt: () => pinned(pane),
    requestRender: () => {},
    showNote: () => {},
    terminal: new FakeTerminal(100, 30),
  })
  mouse.mouse({ ...mouseEvent("wheel", 2), button: "up" })
  render()
  expect(pane.layout[0]).toEqual({ block: reply, line: 37 })
  expect(pane.rowsBelow).toBe(3)
  pane.find("needle")
  render()
  expect(pane.matchCount).toBe(60)
  pane.clearFind()
  for (const row of [5, 6, 7, 8]) {
    pane.follow()
    render()
    mouse.mouse(mouseEvent("press", row))
    mouse.mouse(mouseEvent("release", row))
    expect(pane.selectedText()).toBe("")
    expect(pane.dragging).toBe(false)
    expect(render()).toHaveLength(20)
    expect(pinned(pane)).toBe(prompt)
    expect(pane.layout[0]).toEqual({ block: prompt, line: 0 })
  }
})

test("tail overlay clips older turns without changing follow or scroll anchors", () => {
  const banded = { ...env, theme: { ...defaultTheme, ...surfaceTheme("dark") } }
  const pane = new TranscriptPane()
  const older = userBlock(message("Older\nTwo\nThree"))
  pane.add(older)
  pane.add(output(20))
  const newer = userBlock(message("Newer"))
  pane.add(newer)
  pane.add(output(8))
  let sticky: LinesBlock | undefined
  const render = () =>
    pane.render(banded, 14, (layout) => {
      const overlay = stickyPromptOverlay(pane.blocks, layout, banded, 14)
      sticky = overlay.block
      return overlay.lines
    })
  expect(render()).toHaveLength(14)
  expect(sticky).toBe(older)
  expect(pane.layout[0]).toEqual({ block: pane.blocks[1]!, line: 19 })
  pane.scrollBy(-1)
  render()
  expect(pane.following).toBe(false)
  expect(sticky).toBe(older)
  expect(pane.layout[0]).toEqual({ block: pane.blocks[1]!, line: 18 })
  expect(pane.rowsBelow).toBe(1)
  pane.follow()
  render()
  pane.add(output(20))
  expect(render()).toHaveLength(14)
  expect(sticky).toBe(newer)
  pane.toBlock(newer)
  expect(render()).toHaveLength(14)
  expect(sticky).toBe(newer)
  expect(pane.layout[0]).toEqual({ block: newer, line: 0 })
  pane.follow()
  render()
  pane.scrollBy(-1)
  render()
  expect(pane.following).toBe(false)
  expect(pane.rowsBelow).toBe(1)
})

test("fullscreen uses expanded band coordinates, preserves the bottom, and falls back below twelve rows", () => {
  const theme = { ...defaultTheme, ...surfaceTheme("dark") }
  for (const height of [15, 16, 30]) {
    const { view, screen, terminal } = fullscreen(true, height, theme)
    try {
      view.user(message("Fix the transcript\nKeep every row reachable"))
      view.replyDelta(Array.from({ length: 40 }, (_, i) => `Result ${i}`).join("\n\n"))
      view.replyEnd([])
      view.render()
      const expanded = height >= 16 // height - header/gap(2) - below(1) - bottom(1) >= 12
      const top = expanded ? 6 : 3
      expect(screen.lines[0]).toBe(" Amira · project")
      expect(screen.lines[2]).toBe(
        expanded ? "" : `› Fix the transcript…${" ".repeat(79 - clockCells)}${clock}`,
      )
      if (expanded) {
        expect(screen.lines[3]).toContain("› Fix the transcript")
        expect(screen.lines[4]).toBe("  Keep every row reachable")
        expect(screen.lines[5]).toBe("")
        expect(terminal.output).toContain("\x1b[48;2;32;32;32m")
      }
      expect(screen.lines[height - 1]).toBe("input")
      const tail = screen.lines.slice(top, height - 2)
      view.handleInput(key("up", { shift: true }))
      view.render()
      expect(screen.lines.slice(top + 1, height - 2)).toEqual(tail.slice(0, -1))
      expect(screen.lines[height - 2]).toContain("1 row below")
      // Triple-click a transcript text row, not the sticky band's last row.
      const resultRow = screen.lines.findIndex((row, i) => i >= top && row.includes("Result"))
      for (let i = 0; i < 3; i++) {
        view.handleInput(mouseEvent("press", resultRow))
        view.handleInput(mouseEvent("release", resultRow))
      }
      expect(terminal.output).toContain("\x1b]52;")
      expect(terminal.output).not.toContain(Buffer.from("Keep every row reachable").toString("base64"))
      view.handleInput(mouseEvent("press", top - 1))
      view.handleInput(mouseEvent("release", top - 1))
      view.render()
      expect(screen.lines[1]).toBe("")
      expect(screen.lines[3]).toContain("Fix the transcript")
      expect(screen.lines[4]).toContain("Keep every row reachable")
    } finally {
      view.stop()
    }
    expect(screen.mainText.match(/Fix the transcript/g)).toHaveLength(1)
  }
})

for (const width of [60, 100]) {
  for (const margin of [0, 3]) {
    for (const banded of [false, true]) {
      test(`fullscreen frame regression: width ${width}, margin ${margin}, userBg ${banded}`, () => {
        const theme = banded ? { ...defaultTheme, ...surfaceTheme("dark") } : plain.theme
        const { view, screen } = fullscreen(true, 28, theme, width, margin)
        try {
          for (const [name, text] of [
            ["A", "A first\nA second\nA third"],
            ["B", "B first"],
            ["C", "C first\nC second\nC third\nC fourth"],
          ]) {
            view.user(message(text!))
            view.replyDelta(Array.from({ length: 12 }, (_, i) => `${name} body ${i}`).join("\n\n"))
            view.replyEnd([])
          }
          view.handleInput(key("home"))
          view.render()
          const top = 2
          const cap = banded ? 5 : 3
          const prefix = " ".repeat(width >= 66 ? margin : 0)
          const initial = screen.lines.slice(top, top + cap)
          const frames: string[][] = [screen.lines.slice()]
          let previous = frames[0]!
          for (let offset = 1; offset <= 58; offset++) {
            view.handleInput(key("down", { shift: true }))
            view.render()
            const frame = screen.lines.slice()
            expect(frame[1]).toBe("") // Header gap never doubles as band padding.
            expect(frame[27]).toBe(`${prefix}input`)
            expect(frame.slice(top + cap, 25)).toEqual(previous.slice(top + cap + 1, 26))
            if (offset <= 5) expect(frame.slice(top, top + cap)).toEqual(initial)
            for (const name of ["A", "B", "C"]) {
              expect(frame.filter((row) => row.includes(`${name} first`)).length).toBeLessThanOrEqual(1)
            }
            frames.push(frame)
            previous = frame
          }
          // The same actual screen rows, including the exact band padding, return in reverse.
          for (let offset = frames.length - 2; offset >= 0; offset--) {
            view.handleInput(key("up", { shift: true }))
            view.render()
            expect(screen.lines).toEqual(frames[offset]!)
          }
        } finally {
          view.stop()
        }
      })
    }
  }
}
