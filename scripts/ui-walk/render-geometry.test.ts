import { afterEach, describe, expect, test } from "bun:test"
import { Resvg } from "@resvg/resvg-wasm"
import { Terminal } from "@xterm/headless"
import { PNG } from "pngjs"
import { cellGeometry } from "./geometry.ts"
import { renderScreen } from "./render.ts"

const terminals: Terminal[] = []
// U+2580–259F coverage in 10×20 cells: halves/eighths, shades, then quadrants.
const BLOCK_AREAS = [
  100, 25, 50, 75, 100, 125, 150, 175, 200, 175, 150, 125, 100, 75, 50, 25, 100, 50, 100, 150, 25, 25, 50, 50,
  50, 150, 100, 150, 150, 50, 100, 150,
]

async function image(text: string, cols = 12, rows = 4): Promise<PNG> {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true })
  terminals.push(terminal)
  await new Promise<void>((resolve) => terminal.write(`\x1b[?25l${text}`, resolve))
  return PNG.sync.read(Buffer.from(await renderScreen(terminal)))
}

function red(png: PNG, x: number, y: number): number {
  return png.data[(y * png.width + x) * 4]!
}

function area(png: PNG, column: number, row = 0): number {
  let total = 0
  for (let y = row * 20; y < (row + 1) * 20; y++) {
    for (let x = column * 10; x < (column + 1) * 10; x++) total += red(png, x, y) / 255
  }
  return total
}

afterEach(() => {
  for (const terminal of terminals) terminal.dispose()
  terminals.length = 0
})

describe("cell-sized screenshot geometry", () => {
  test("┃ and │ touch the top and bottom and stay continuous across rows", async () => {
    const png = await image("┃│\r\n┃│\r\n┃│")
    for (let y = 0; y < 60; y++) {
      expect(red(png, 4, y)).toBe(255)
      expect(red(png, 14, y)).toBe(255)
    }
    expect(area(png, 0)).toBe(80)
    expect(area(png, 1)).toBe(40)
  }, 30_000)

  test("─, ━ and ═ stay continuous across neighboring cells", async () => {
    const png = await image("───\r\n━━━\r\n═══")
    for (let x = 0; x < 30; x++) {
      expect(red(png, x, 9)).toBe(255)
      expect(red(png, x, 29)).toBe(255)
      expect(red(png, x, 48)).toBe(255)
      expect(red(png, x, 51)).toBe(255)
      expect(red(png, x, 50)).toBe(0)
    }
  })

  test("corners connect horizontal and vertical neighbors without font-baseline gaps", async () => {
    const png = await image("┌─┐ ╔═╗\r\n│ │ ║ ║\r\n└─┘ ╚═╝")
    for (let x = 4; x < 26; x++) expect(red(png, x, 9)).toBe(255)
    for (let y = 9; y <= 50; y++) expect(red(png, 4, y)).toBe(255)
    for (let x = 43; x < 67; x++) expect(red(png, x, 8)).toBe(255)
    for (let y = 8; y <= 51; y++) expect(red(png, 43, y)).toBe(255)
    expect(red(png, 45, 10)).toBe(0)
  })

  test("█ fills all 200 pixels, while ▌ and ▐ cover exact halves including row zero", async () => {
    const png = await image("█▌▐")
    expect(area(png, 0)).toBe(200)
    expect(area(png, 1)).toBe(100)
    expect(area(png, 2)).toBe(100)
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 30; x++) {
        expect(red(png, x, y)).toBe(x < 15 || x >= 25 ? 255 : 0)
      }
    }
  })

  test("all 32 block elements have their specified integrated coverage", async () => {
    const expected = BLOCK_AREAS
    const text = Array.from({ length: 32 }, (_, i) => String.fromCodePoint(0x2580 + i)).join("")
    const png = await image(text, 33, 2)
    for (let i = 0; i < expected.length; i++) {
      // Fractional 1.25px eighth edges may be antialiased: integrate rather than count white pixels.
      expect(Math.abs(area(png, i) - expected[i]!)).toBeLessThan(0.5)
    }
  })

  test("block boundaries and quadrants occupy the correct side of the cell", async () => {
    const png = await image("▀▄▔▁▏▕▖▗▘▝▚▞")
    const sample = (column: number, x: number, y: number) => red(png, column * 10 + x, y)
    for (const [column, x, y, value] of [
      [0, 5, 0, 255],
      [0, 5, 10, 0],
      [1, 5, 9, 0],
      [1, 5, 19, 255],
      [2, 5, 0, 255],
      [2, 5, 3, 0],
      [3, 5, 16, 0],
      [3, 5, 19, 255],
      [4, 0, 10, 255],
      [4, 2, 10, 0],
      [5, 7, 10, 0],
      [5, 9, 10, 255],
      [6, 2, 15, 255],
      [6, 7, 15, 0],
      [7, 7, 15, 255],
      [8, 2, 5, 255],
      [9, 7, 5, 255],
      [10, 2, 5, 255],
      [10, 7, 15, 255],
      [10, 7, 5, 0],
      [11, 7, 5, 255],
      [11, 2, 15, 255],
      [11, 2, 5, 0],
    ])
      expect(sample(column!, x!, y!)).toBe(value!)
  })

  test("every solid and mixed-weight box has the Unicode-specified arms at the cell edges", async () => {
    // Independent edge specification, U+2500–257F, up/right/down/left.
    // 1=light, 2=heavy, 3=double; '-' marks dashed/diagonal special cases tested below.
    const arms = [
      "0101 0202 1010 2020 - - - - - - - - 0110 0210 0120 0220",
      "0011 0012 0021 0022 1100 1200 2100 2200 1001 1002 2001 2002 1110 1210 2110 1120",
      "2120 2210 1220 2220 1011 1012 2011 1021 2021 2012 1022 2022 0111 0112 0211 0212",
      "0121 0122 0221 0222 1101 1102 1201 1202 2101 2102 2201 2202 1111 1112 1211 1212",
      "2111 1121 2121 2112 2211 1122 1221 2212 1222 2122 2221 2222 - - - -",
      "0303 3030 0310 0130 0330 0013 0031 0033 1300 3100 3300 1003 3001 3003 1310 3130",
      "3330 1013 3031 3033 0313 0131 0333 1303 3101 3303 1313 3131 3333 0110 0011 1001",
      "1100 - - - 0001 1000 0100 0010 0002 2000 0200 0020 0201 1020 0102 2010",
    ]
      .join(" ")
      .split(" ")
    expect(arms.length).toBe(128)
    const text = Array.from({ length: 128 }, (_, i) => String.fromCodePoint(0x2500 + i)).join("")
    const png = await image(text, 129, 2)
    for (let i = 0; i < arms.length; i++) {
      if (arms[i] === "-") continue
      for (let direction = 0; direction < 4; direction++) {
        const vertical = direction % 2 === 0
        const length = vertical ? 10 : 20
        const expected = arms[i]![direction]
        for (let position = 0; position < length; position++) {
          const middle = length / 2
          const ink =
            expected === "1"
              ? position >= middle - 1 && position < middle + 1
              : expected === "2"
                ? position >= middle - 2 && position < middle + 2
                : expected === "3"
                  ? position === middle - 2 || position === middle + 1
                  : false
          const x = i * 10 + (vertical ? position : direction === 1 ? 9 : 0)
          const y = vertical ? (direction === 0 ? 0 : 19) : position
          expect(red(png, x, y)).toBe(ink ? 255 : 0)
        }
      }
    }
  })

  test("all 160 geometry characters ignore font bold/italic metrics", async () => {
    const text = Array.from({ length: 160 }, (_, i) => String.fromCodePoint(0x2500 + i)).join("")
    const png = await image(`${text}\r\n\x1b[1;3m${text}`, 161, 3)
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 1600; x++) expect(red(png, x, y + 20)).toBe(red(png, x, y))
    }
  })

  test("double mixed joins meet both rails and keep the central double-line gap", async () => {
    const png = await image("╒╓╞╟╤╥╪╫╬")
    // A single vertical stem meets both horizontal rails, and vice versa.
    for (const column of [0, 2, 4, 6]) {
      expect(red(png, column * 10 + 4, 8)).toBe(255)
      expect(red(png, column * 10 + 4, 11)).toBe(255)
    }
    for (const column of [1, 3, 5, 7]) {
      expect(red(png, column * 10 + 3, 9)).toBe(255)
      expect(red(png, column * 10 + 6, 9)).toBe(255)
    }
    expect(red(png, 84, 9)).toBe(0)
    expect(red(png, 83, 8)).toBe(255)
    expect(red(png, 86, 11)).toBe(255)
  })

  test("every dashed variant has visible gaps and the requested dash count", async () => {
    const codes = [
      0x2504, 0x2505, 0x2506, 0x2507, 0x2508, 0x2509, 0x250a, 0x250b, 0x254c, 0x254d, 0x254e, 0x254f,
    ]
    const png = await image(String.fromCodePoint(...codes), 13, 2)
    for (let i = 0; i < codes.length; i++) {
      const vertical = i % 4 >= 2
      const length = vertical ? 20 : 10
      const samples = Array.from({ length }, (_, p) =>
        red(png, i * 10 + (vertical ? 4 : p), vertical ? p : 9),
      )
      // Fractional horizontal dashes can have antialiased gaps rather than black pixels.
      expect(Math.min(...samples)).toBeLessThan(200)
      expect(Math.max(...samples)).toBeGreaterThan(200)
      const count = i < 4 ? 3 : i < 8 ? 4 : 2
      const peaks = samples.filter((value, p) => value >= 200 && (p === 0 || samples[p - 1]! < 200)).length
      expect(peaks).toBe(count)
    }
  })

  test("rounded corners bend instead of forming square joints, and diagonals reach corners", async () => {
    const png = await image("╭╮╯╰╱╲╳")
    expect(red(png, 4, 9)).toBeLessThan(255)
    expect(red(png, 4, 15)).toBe(255)
    expect(red(png, 9, 9)).toBe(255)
    expect(red(png, 14, 9)).toBeLessThan(255)
    expect(red(png, 24, 10)).toBeLessThan(255)
    expect(red(png, 34, 10)).toBeLessThan(255)
    for (const [x, y] of [
      [49, 0],
      [40, 19],
      [50, 0],
      [59, 19],
      [60, 0],
      [69, 0],
      [60, 19],
      [69, 19],
    ]) {
      expect(red(png, x!, y!)).toBeGreaterThan(150)
    }
    expect(red(png, 44, 0)).toBe(0)
    expect(red(png, 54, 0)).toBe(0)
  })

  test("odd 9×19 cells retain exact fractional block coverage without snapping eighths", async () => {
    await image("") // Initialize the shared WASM renderer through its normal seam.
    for (let i = 0; i < BLOCK_AREAS.length; i++) {
      const character = String.fromCodePoint(0x2580 + i)
      const fraction = BLOCK_AREAS[i]! / 200
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="9" height="19"><rect width="9" height="19" fill="black"/><g fill="white">${cellGeometry(character, 0, 0, 9, 19)}</g></svg>`
      const renderer = new Resvg(svg)
      const rendered = renderer.render()
      try {
        const png = PNG.sync.read(Buffer.from(rendered.asPng()))
        let coverage = 0
        for (let y = 0; y < 19; y++) {
          for (let x = 0; x < 9; x++) coverage += red(png, x, y) / 255
        }
        expect(Math.abs(coverage - 171 * fraction), `${character}: ${coverage}`).toBeLessThan(0.5)
      } finally {
        rendered.free()
        renderer.free()
      }
    }
  })

  test("geometry retains inverse, dim, invisible, underline, strike and overline styles", async () => {
    const png = await image("\x1b[7m▌\x1b[0;2m█\x1b[0;8;4m█\x1b[0;4;9;53m│")
    expect(red(png, 0, 0)).toBe(0)
    expect(red(png, 9, 0)).toBe(255)
    expect(red(png, 10, 0)).toBe(128)
    expect(area(png, 2)).toBe(0)
    for (let x = 30; x < 40; x++) {
      expect(red(png, x, 18)).toBe(255)
      expect(red(png, x, 10)).toBe(255)
      expect(red(png, x, 1)).toBe(255)
    }
  })
})
