import { expect, test } from "bun:test"
import { stripAnsi } from "../src/ansi.ts"
import { type Component, CURSOR_MARKER } from "../src/component.ts"
import { Box } from "../src/components/box.ts"
import { Text } from "../src/components/text.ts"
import { FullScreenRenderer } from "../src/fullscreen.ts"
import { LiveRenderer } from "../src/renderer.ts"
import { FakeTerminal } from "../src/terminal.ts"
import { presentEmoji, textWidth, truncateToWidth, visibleWidth, wrapText } from "../src/width.ts"
import { plain } from "./context.ts"
import { VirtualScreen } from "./screen.ts"

const VS15 = "\uFE0E"
const VS16 = "\uFE0F"

/** Emoji without an emoji presentation of their own, which terminals draw two cells wide. */
const TEXT_DEFAULT = [
  "✉",
  "☑",
  "⚠",
  "❤",
  "☀",
  "✏",
  "✔",
  "✖",
  "⁉",
  "ℹ",
  "Ⓜ",
  "↩",
  "↗",
  "➡",
  "⬆",
  "🖼",
  "🗑",
  "⏱",
]
/** Emoji-capable symbols that Cascadia Mono draws itself, one cell. */
const TEXT_SYMBOLS = [
  "#",
  "*",
  "0",
  "9",
  "©",
  "®",
  "™",
  "‼",
  "↔",
  "↕",
  "▪",
  "▫",
  "◻",
  "◼",
  "▶",
  "◀",
  "☺",
  "♀",
  "♂",
  "♠",
  "♣",
  "♥",
  "♦",
]

test("a text-default emoji counts as two cells, as if VS16 followed it", () => {
  for (const c of TEXT_DEFAULT) {
    expect([c, visibleWidth(c)]).toEqual([c, 2])
    expect([c, textWidth(c)]).toEqual([c, 2])
    expect([c, visibleWidth(c + VS16)]).toEqual([c, 2])
  }
})

test("VS15 asks for text: one cell", () => {
  for (const c of TEXT_DEFAULT) expect([c, visibleWidth(c + VS15)]).toEqual([c, 1])
})

test("symbols terminal fonts draw as text stay one cell unless VS16 asks for the emoji", () => {
  for (const c of TEXT_SYMBOLS) expect([c, visibleWidth(c)]).toEqual([c, 1])
  expect(visibleWidth(`©${VS16}`)).toBe(2)
  expect(visibleWidth(`♥${VS16}`)).toBe(2)
  expect(visibleWidth("a1#*")).toBe(4)
})

test("emoji, CJK, ZWJ sequences, flags, keycaps and modifiers keep their widths", () => {
  expect(visibleWidth("😀")).toBe(2)
  expect(visibleWidth("你好")).toBe(4)
  expect(visibleWidth("👨‍👩‍👧")).toBe(2)
  expect(visibleWidth("❤‍🔥")).toBe(2)
  expect(visibleWidth(`❤${VS16}‍🔥`)).toBe(2)
  expect(visibleWidth("🏳‍🌈")).toBe(2)
  expect(visibleWidth("🇯🇵")).toBe(2)
  expect(visibleWidth(`1${VS16}\u20E3`)).toBe(2)
  expect(visibleWidth(`#${VS16}\u20E3`)).toBe(2)
  expect(visibleWidth("☝🏽")).toBe(2)
  expect(visibleWidth("〰")).toBe(2)
  expect(visibleWidth("✓ ✗ • ◦ ▸ ▲ ● ◆ › … ─ │")).toBe(23)
})

test("counts in mixed text and escapes, and truncates and wraps by the same widths", () => {
  expect(visibleWidth("\x1b[31m✉ mail\x1b[0m")).toBe(7)
  expect(visibleWidth("a✉b☑c")).toBe(7)
  expect(truncateToWidth("a✉b", 2)).toBe("a")
  expect(truncateToWidth("a✉b", 3)).toBe("a✉")
  expect(wrapText("✉✉✉", 4)).toEqual(["✉✉", "✉"])
  for (const l of wrapText("mail ✉ from ⚠ someone ❤ here", 7)) expect(visibleWidth(l)).toBeLessThanOrEqual(7)
})

test("presentEmoji adds VS16 where the emoji was not asked for, and nowhere else", () => {
  expect(presentEmoji("✉ mail")).toBe(`✉${VS16} mail`)
  expect(presentEmoji(`✉${VS16}`)).toBe(`✉${VS16}`)
  expect(presentEmoji(`✉${VS15}`)).toBe(`✉${VS15}`)
  expect(presentEmoji("© ♥ ▶ 1 #")).toBe("© ♥ ▶ 1 #")
  expect(presentEmoji("😀 你好 👨‍👩‍👧 🇯🇵 ❤‍🔥")).toBe("😀 你好 👨‍👩‍👧 🇯🇵 ❤‍🔥")
  expect(presentEmoji("plain")).toBe("plain")
  // Escape sequences, hyperlink targets included, are left alone.
  const link = "\x1b]8;;http://x/✉\x07✉\x1b]8;;\x07"
  expect(presentEmoji(`\x1b[1m${link}\x1b[0m`)).toBe(
    `\x1b[1m\x1b]8;;http://x/✉\x07✉${VS16}\x1b]8;;\x07\x1b[0m`,
  )
})

test("presentEmoji never changes a width", () => {
  const all = [
    ...TEXT_DEFAULT,
    ...TEXT_SYMBOLS,
    "😀",
    "你",
    "👨‍👩‍👧",
    "❤‍🔥",
    "🇯🇵",
    "☝🏽",
    `✉${VS15}`,
    `✉\u0301`,
  ]
  for (const s of all) expect([s, visibleWidth(presentEmoji(s))]).toEqual([s, visibleWidth(s)])
  // And the terminal draws it as measured: two cells once VS16 follows.
  for (const c of TEXT_DEFAULT) expect([c, Bun.stringWidth(presentEmoji(c))]).toEqual([c, 2])
})

class Lines implements Component {
  constructor(public lines: string[]) {}
  render(): string[] {
    return this.lines
  }
}

function setup(cols: number, rows: number) {
  const term = new FakeTerminal(cols, rows)
  // Draws like Windows Terminal: a bare ✉ moves the cursor one cell, ✉ with VS16 two.
  const screen = new VirtualScreen(cols, rows)
  const write = term.write.bind(term)
  term.write = (d: string) => {
    write(d)
    screen.write(d)
  }
  return { term, screen }
}

/** The column of each cell holding `g` in a row of the screen. */
const columnsOf = (row: string[], g: string) => row.flatMap((c, i) => (c === g ? [i] : []))

test("the inline renderer writes VS16 after ✉, not after symbols kept as text", () => {
  const { term, screen } = setup(20, 5)
  const r = new LiveRenderer(term, new Lines(["✉ new ♥ ©"]))
  r.start()
  expect(term.output).toContain(`✉${VS16} new ♥ ©`)
  expect(term.output).not.toContain(`♥${VS16}`)
  expect(term.output).not.toContain(`©${VS16}`)
  expect(screen.lines[0]).toBe(`✉${VS16} new ♥ ©`)
  // Committed lines go the same way.
  r.commit(["☑ done"])
  expect(screen.text).toContain(`☑${VS16} done`)
  r.stop()
})

test("a box around ✉ stays aligned on screen, inline and full-screen", () => {
  const box = new Box(new Text("✉ mail ⚠"))
  const expected = box.render(14, plain)
  expect(expected.map(visibleWidth)).toEqual([14, 14, 14])
  const check = (screen: VirtualScreen) => {
    const rows = screen.grid.slice(0, 3)
    // The right border lands in the last column on every row, the text row included.
    expect(columnsOf(rows[1]!, "│")).toEqual([0, 13])
    expect(rows[0]![13]).toBe("╮")
    expect(rows[2]![13]).toBe("╯")
  }
  {
    const { term, screen } = setup(14, 5)
    const r = new LiveRenderer(term, box, { color: false })
    r.start()
    check(screen)
    r.stop()
  }
  {
    const { term, screen } = setup(14, 5)
    const f = new FullScreenRenderer(term, box, { color: false })
    f.open()
    check(screen)
    expect(term.output).toContain(`✉${VS16}`)
    f.close()
  }
})

test("a truncated row with ✉ ends where it was measured to", () => {
  const { term, screen } = setup(10, 3)
  const r = new LiveRenderer(term, new Lines(["abcdefgh✉xyz", "✉✉✉✉✉✉"]))
  r.start()
  expect(stripAnsi(screen.lines[0]!)).toBe("abcdefgh✉\uFE0F")
  expect(screen.grid[1]!.filter((c) => c !== "").length).toBe(5)
  expect(screen.y).toBe(1)
  r.stop()
})

test("the cursor after ✉ lands where the terminal put the text, inline and full-screen", () => {
  const line = `✉ ⚠${CURSOR_MARKER}x`
  {
    const { term, screen } = setup(20, 5)
    const r = new LiveRenderer(term, new Lines([line]))
    r.start()
    expect(screen.x).toBe(5)
    expect(screen.grid[0]![screen.x]).toBe("x")
    r.stop()
  }
  {
    const { term, screen } = setup(20, 5)
    const f = new FullScreenRenderer(term, new Lines([line]))
    f.open()
    expect(screen.x).toBe(5)
    expect(screen.grid[0]![screen.x]).toBe("x")
    f.close()
  }
})

test("presentEmoji judges a grapheme whole when an escape splits it", () => {
  const hl = (s: string) => `\x1b[7m${s}\x1b[27m`
  const cases = [
    `${hl("⚠")}\uFE0E x`,
    `${hl("⚠")}\uFE0F x`,
    `❤\x1b[31m‍🔥`,
    `${hl("✉")} x`,
    `a${hl("🖼")}b`,
    `\x1b]8;;http://x\x07✉\x1b]8;;\x07\uFE0E`,
  ]
  for (const s of cases) {
    const out = presentEmoji(s)
    expect([s, visibleWidth(out)]).toEqual([s, visibleWidth(s)])
    // What the terminal takes, the escapes aside, is the width that was measured.
    expect([s, Bun.stringWidth(stripAnsi(out))]).toEqual([s, visibleWidth(s)])
  }
  expect(presentEmoji(`${hl("⚠")}\uFE0E x`)).toBe(`${hl("⚠")}\uFE0E x`)
  expect(presentEmoji(`${hl("✉")} x`)).toBe(`\x1b[7m✉\uFE0F\x1b[27m x`)
  expect(presentEmoji(`a${hl("🖼")}b`)).toBe(`a\x1b[7m🖼\uFE0F\x1b[27mb`)
})
