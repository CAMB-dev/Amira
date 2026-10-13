import { afterEach, describe, expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"
import { PNG } from "pngjs"
import { renderScreen, screenAnsi, screenText } from "./render.ts"

const terminals: Terminal[] = []

function terminal(cols = 100, rows = 32): Terminal {
  const result = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 100 })
  terminals.push(result)
  return result
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

async function image(term: Terminal): Promise<PNG> {
  return PNG.sync.read(Buffer.from(await renderScreen(term)))
}

function pixel(png: PNG, x: number, y: number): number[] {
  const offset = (y * png.width + x) * 4
  return [...png.data.subarray(offset, offset + 4)]
}

function containsColor(png: PNG, x: number, y: number, width: number, color: number[]): boolean {
  for (let row = y; row < y + 20; row++) {
    for (let column = x; column < x + width; column++) {
      if (pixel(png, column, row).every((component, index) => component === color[index])) return true
    }
  }
  return false
}

afterEach(() => {
  for (const term of terminals) term.dispose()
  terminals.length = 0
})

describe("renderScreen", () => {
  test("renders the selection chevron instead of a missing-glyph box", async () => {
    const term = terminal(4, 2)
    await write(term, "\x1b[?25l❯\u0378")
    const png = await image(term)
    const chevron: number[][] = []
    const missing: number[][] = []
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 10; x++) {
        chevron.push(pixel(png, x, y))
        missing.push(pixel(png, x + 10, y))
      }
    }
    expect(chevron).not.toEqual(missing)
    expect(containsColor(png, 0, 0, 10, [255, 255, 255, 255])).toBe(true)
  }, 30_000)

  test("encodes a 100×32 terminal as an opaque 1000×640 PNG", async () => {
    const term = terminal()
    await write(term, "\x1b[?25lhello")
    const png = await image(term)
    expect(png.width).toBe(1000)
    expect(png.height).toBe(640)
    expect(pixel(png, 999, 639)).toEqual([0, 0, 0, 255])
    expect(containsColor(png, 0, 0, 50, [255, 255, 255, 255])).toBe(true)
  }, 30_000)

  test("preserves RGB, ANSI, cube, grayscale, default and inverse colors", async () => {
    const term = terminal(12, 2)
    term.options.theme = { foreground: "#abcdef", background: "#123456", red: "#123abc" }
    await write(
      term,
      [
        "\x1b[?25l",
        "\x1b[48;2;17;34;51m ",
        "\x1b[0;41m ",
        "\x1b[0;48;5;196m ",
        "\x1b[0;48;5;244m ",
        "\x1b[0m ",
        "\x1b[38;2;201;102;3;48;2;4;5;6;7m ",
        "\x1b[0;7m ",
        "\x1b[0;1;31;7m ",
      ].join(""),
    )
    const png = await image(term)
    expect(pixel(png, 5, 5)).toEqual([17, 34, 51, 255])
    expect(pixel(png, 15, 5)).toEqual([18, 58, 188, 255])
    expect(pixel(png, 25, 5)).toEqual([255, 0, 0, 255])
    expect(pixel(png, 35, 5)).toEqual([128, 128, 128, 255])
    expect(pixel(png, 45, 5)).toEqual([18, 52, 86, 255])
    expect(pixel(png, 55, 5)).toEqual([201, 102, 3, 255])
    expect(pixel(png, 65, 5)).toEqual([171, 205, 239, 255])
    expect(pixel(png, 75, 5)).toEqual([239, 41, 41, 255])
  }, 30_000)

  test("honors theme palette overrides and disables bold brightening when requested", async () => {
    const term = terminal(4, 2)
    term.options.theme = { red: "#102030", brightRed: "#405060", extendedAnsi: ["#708090"] }
    term.options.drawBoldTextInBrightColors = false
    await write(term, "\x1b[?25l\x1b[1;31;7m \x1b[0;48;5;16m ")
    const png = await image(term)
    expect(pixel(png, 5, 5)).toEqual([16, 32, 48, 255])
    expect(pixel(png, 15, 5)).toEqual([112, 128, 144, 255])
  }, 30_000)

  test("renders foreground glyphs and underline while retaining bold and italic", async () => {
    const term = terminal(8, 2)
    await write(term, "\x1b[?25l\x1b[38;2;23;143;213;1;3;4mM \x1b[0m")
    const png = await image(term)
    expect(containsColor(png, 0, 0, 10, [23, 143, 213, 255])).toBe(true)
    expect(pixel(png, 15, 18)).toEqual([23, 143, 213, 255])
    expect(pixel(png, 15, 17)).toEqual([0, 0, 0, 255])
    const cell = term.buffer.active.getLine(0)?.getCell(0)
    expect(Boolean(cell?.isBold())).toBe(true)
    expect(Boolean(cell?.isItalic())).toBe(true)
    expect(Boolean(cell?.isUnderline())).toBe(true)
  }, 30_000)

  test("bold and italic produce distinct glyph rasters", async () => {
    const term = terminal(8, 2)
    await write(term, "\x1b[?25lM \x1b[1mM \x1b[0;3mM")
    const png = await image(term)
    const raster = (x: number) => {
      const values: number[] = []
      for (let y = 0; y < 20; y++) {
        for (let column = x; column < x + 10; column++) values.push(...pixel(png, column, y))
      }
      return values
    }
    expect(raster(20)).not.toEqual(raster(0))
    expect(raster(40)).not.toEqual(raster(0))
  }, 30_000)

  test("gives CJK glyphs two cells without shifting the following cell", async () => {
    const term = terminal(8, 2)
    await write(term, "\x1b[?25l\x1b[38;2;255;0;0;48;2;1;2;3m界\x1b[48;2;4;5;6mA")
    expect(term.buffer.active.getLine(0)?.getCell(0)?.getWidth()).toBe(2)
    expect(term.buffer.active.getLine(0)?.getCell(1)?.getWidth()).toBe(0)
    expect(screenText(term, false)).toBe("界A\n")
    const png = await image(term)
    expect(pixel(png, 1, 0)).toEqual([1, 2, 3, 255])
    expect(pixel(png, 19, 0)).toEqual([1, 2, 3, 255])
    expect(pixel(png, 21, 0)).toEqual([4, 5, 6, 255])
    expect(containsColor(png, 0, 0, 20, [255, 0, 0, 255])).toBe(true)
  }, 30_000)

  test("draws block, bar and underline cursors and honors DEC cursor hiding", async () => {
    const term = terminal(4, 2)
    term.options.theme = { cursor: "#123456" }
    await write(term, "\x1b[1;2H")
    const block = await image(term)
    expect(pixel(block, 15, 5)).toEqual([18, 52, 86, 255])
    expect(pixel(block, 5, 5)).toEqual([0, 0, 0, 255])
    term.options.cursorStyle = "bar"
    term.options.cursorWidth = 2
    const bar = await image(term)
    expect(pixel(bar, 10, 5)).toEqual([18, 52, 86, 255])
    expect(pixel(bar, 12, 5)).toEqual([0, 0, 0, 255])
    term.options.cursorStyle = "underline"
    const underline = await image(term)
    expect(pixel(underline, 15, 18)).toEqual([18, 52, 86, 255])
    expect(pixel(underline, 15, 17)).toEqual([0, 0, 0, 255])
    await write(term, "\x1b[?25l")
    expect(pixel(await image(term), 15, 18)).toEqual([0, 0, 0, 255])
  }, 30_000)

  test("renders the active viewport rather than scrollback and switches alternate screens", async () => {
    const term = terminal(8, 2)
    await write(term, "\x1b[?25lold\r\none\r\n\x1b[48;2;1;2;3mtwo\r\n\x1b[48;2;4;5;6mthree")
    expect(term.buffer.active.baseY).toBeGreaterThan(0)
    expect(screenText(term, false)).toBe("two\nthree")
    expect(pixel(await image(term), 0, 0)).toEqual([1, 2, 3, 255])
    term.scrollLines(-1)
    expect(screenText(term, false)).toBe("one\ntwo")
    expect(pixel(await image(term), 0, 0)).toEqual([0, 0, 0, 255])
    term.scrollToBottom()
    await write(term, "\x1b[?1049h\x1b[H\x1b[0;48;2;7;8;9malt")
    expect(term.buffer.active.type).toBe("alternate")
    expect(screenText(term, false)).toBe("alt\n")
    expect(pixel(await image(term), 0, 0)).toEqual([7, 8, 9, 255])
    await write(term, "\x1b[?1049l")
    expect(screenText(term, false)).toBe("two\nthree")
  }, 30_000)
})

describe("screen exports", () => {
  test("numbers visible rows, trims right padding and preserves blank rows", async () => {
    const term = terminal(12, 3)
    await write(term, "hello  \r\n  world")
    expect(screenText(term)).toBe("1: hello\n2:   world\n3: ")
    expect(screenText(term, false)).toBe("hello\n  world\n")
  })

  test("ANSI round-trips RGB, indexed/default colors, styles and wide cells", async () => {
    const source = terminal(12, 3)
    await write(source, "\x1b[38;2;1;2;3;48;5;196;1;3;4;7m界A\x1b[0mB\r\n\x1b[32mgreen")
    const target = terminal(12, 3)
    await write(target, screenAnsi(source))
    expect(screenText(target, false)).toBe(screenText(source, false))
    for (let row = 0; row < source.rows; row++) {
      for (let column = 0; column < source.cols; column++) {
        const original = source.buffer.active.getLine(row)!.getCell(column)!
        const restored = target.buffer.active.getLine(row)!.getCell(column)!
        expect(restored.getWidth()).toBe(original.getWidth())
        expect(restored.getFgColorMode()).toBe(original.getFgColorMode())
        expect(restored.getFgColor()).toBe(original.getFgColor())
        expect(restored.getBgColorMode()).toBe(original.getBgColorMode())
        expect(restored.getBgColor()).toBe(original.getBgColor())
        expect(restored.isBold()).toBe(original.isBold())
        expect(restored.isItalic()).toBe(original.isItalic())
        expect(restored.isUnderline()).toBe(original.isUnderline())
        expect(restored.isInverse()).toBe(original.isInverse())
      }
    }
  })
})
