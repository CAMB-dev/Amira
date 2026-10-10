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
import { stickyPrompt, stickyPromptLine } from "../src/pane/sticky-prompt.ts"
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
const pinned = (pane: TranscriptPane) => stickyPrompt(pane.blocks, pane.layout)
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

test("a prompt pins after output grows, switches to the topmost turn, and leaves when its band is visible", () => {
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
  expect(pinned(pane)).toBeUndefined()
  pane.scrollBy(1)
  pane.render(env, 5)
  // The first row has scrolled away even though the second line of the real band remains.
  expect(pinned(pane)).toBe(older)
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
  expect(stripAnsi(row)).toBe(`  › First line…${" ".repeat(83 - clockCells)}${clock}  `)
  expect(row).toContain(banded.theme.accent("›"))
  expect(row).toContain(banded.theme.muted(clock))
  expect(row).toContain("\x1b[48;2;")
  expect(visibleWidth(row)).toBe(100)
  const long = userBlock(message("界".repeat(100)))
  const longRow = stripAnsi(stickyPromptLine(long, banded))
  expect(longRow).toContain("…")
  expect(longRow).toEndWith(`${clock}  `)
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
  expect(pinned(pane)).toBeUndefined()
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
    requestRender: () => {},
    showNote: () => {},
    terminal,
  })
  mouse.mouse(mouseEvent("press", 1))
  mouse.mouse(mouseEvent("release", 1))
  expect(pane.dragging).toBe(false)
  expect(pane.selectedText()).toBe("")
  expect(terminal.output).not.toContain("\x1b]52;")
  pane.render(env, 5)
  expect(pane.layout[0]).toEqual({ block: prompt, line: 0 })
  expect(pinned(pane)).toBeUndefined()
  // The first content row is still at paneTop, not at the sticky slot.
  mouse.mouse(mouseEvent("press", 2))
  mouse.mouse(mouseEvent("drag", 3, 24))
  mouse.mouse(mouseEvent("release", 3, 24))
  expect(pane.selectedText()).toContain("Entire second line")
  expect(pane.selectedText()).not.toContain(clock)
  mouse.stopEdgeScroll()
})

function fullscreen(withHeader = true) {
  const terminal = new FakeTerminal(100, 12)
  const screen = new VirtualScreen(100, 12)
  const write = terminal.write.bind(terminal)
  terminal.write = (data) => {
    write(data)
    screen.write(data)
  }
  const view = createFullscreenView({
    terminal,
    theme: plain.theme,
    capabilities: { win32InputMode: false, kittyKeyboard: true, synchronizedOutput: false, shiftEnter: true },
    settings: {},
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

test("fullscreen reserves the header gap, pins directly under the header and keeps mouse/search coordinates", () => {
  const { view, terminal, screen } = fullscreen()
  try {
    view.user(message("Fix the transcript\nKeep every row reachable"))
    view.replyDelta(Array.from({ length: 20 }, (_, i) => `Result ${i}`).join("\n\n"))
    view.replyEnd([])
    view.render()
    expect(screen.lines[0]).toBe(" Amira · project")
    expect(screen.lines[1]).toBe(`  › Fix the transcript…${" ".repeat(75 - clockCells)}${clock}`)
    const tail = screen.lines.slice(2, 10)
    view.handleInput(key("up", { shift: true }))
    view.render()
    expect(screen.lines.slice(3, 10)).toEqual(tail.slice(0, 7))
    expect(screen.lines[10]).toContain("1 row below")
    view.handleInput(key("f", { ctrl: true }))
    view.handleInput({ type: "paste", text: "Fix the transcript" })
    view.render()
    expect(screen.lines[1]).toBe("")
    expect(screen.lines.join("\n")).toContain("1/1")
    view.handleInput(key("escape"))
    view.handleInput(key("end"))
    view.render()
    expect(screen.lines[1]).toContain("Fix the transcript…")
    view.handleInput(mouseEvent("press", 1))
    view.handleInput(mouseEvent("release", 1))
    view.render()
    expect(screen.lines[1]).toBe("")
    expect(screen.lines[2]).toContain("Fix the transcript")
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
    expect(stripAnsi(row)).toStartWith("  > A   BC.")
    expect(row).not.toContain("\t")
    expect(row).not.toContain("\x00")
    expect(row).not.toContain("\x07")
    expect(row).not.toContain("\x1b[2J")
    expect(row).not.toContain("injected")
    expect(row).not.toContain("…")
    const long = stickyPromptLine(userBlock(message("long".repeat(30))), { ...env, width: 30 })
    expect(stripAnsi(long)).toEndWith(`.  ${clock}  `)
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
    expect(screen.lines[0]).toBe(`  › No header${" ".repeat(85 - clockCells)}${clock}`)
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

test("painted band padding does not pin a duplicate while the real first text row is visible", () => {
  const banded = { ...env, theme: { ...defaultTheme, ...surfaceTheme("dark") } }
  const pane = new TranscriptPane()
  const prompt = userBlock(message("First text\nSecond text"))
  pane.add(prompt)
  pane.add(output(20))
  pane.render(banded, 6)
  pane.toBlock(prompt)
  pane.render(banded, 6)
  expect(prompt.promptRow).toBe(1)
  expect(pinned(pane)).toBeUndefined()
  pane.scrollBy(1)
  pane.render(banded, 6)
  expect(pane.layout[0]).toEqual({ block: prompt, line: 1 })
  expect(pinned(pane)).toBeUndefined()
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
