import type { Dirent } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { initWasm, Resvg } from "@resvg/resvg-wasm"
import type { IBufferCell, ITheme, Terminal } from "@xterm/headless"
import { cellGeometry } from "./geometry.ts"

const CELL_WIDTH = 10
const CELL_HEIGHT = 20
const FONT_SIZE = 16
const DEFAULT_FOREGROUND = "#ffffff"
const DEFAULT_BACKGROUND = "#000000"

// xterm's default ANSI palette. Entries 16–255 are the standard cube and grayscale ramp.
const ANSI_COLORS = [
  "#2e3436",
  "#cc0000",
  "#4e9a06",
  "#c4a000",
  "#3465a4",
  "#75507b",
  "#06989a",
  "#d3d7cf",
  "#555753",
  "#ef2929",
  "#8ae234",
  "#fce94f",
  "#729fcf",
  "#ad7fa8",
  "#34e2e2",
  "#eeeeec",
]
const ANSI_THEME_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const

const FONT_FAMILIES = {
  // Prefer Consolas' separate bold/italic faces over variable-only Cascadia installations.
  win32: "Consolas, Cascadia Mono, Segoe UI Symbol, Microsoft YaHei, MS Gothic, SimSun, Malgun Gothic",
  darwin:
    "Menlo, Apple Symbols, PingFang SC, Hiragino Sans GB, Hiragino Sans, Apple SD Gothic Neo, Songti SC",
  linux: "DejaVu Sans Mono, Noto Sans Mono CJK SC, Noto Sans CJK SC, Noto Sans CJK JP, WenQuanYi Zen Hei",
}
const FONT_FILE =
  /^(?:cascadiamono.*|consola[biz]?|seguisym|apple ?symbols|msyh(?:bd|l)?|msgothic|simsun.*|malgun.*|menlo.*|pingfang.*|hiragino.*|applesdgothicneo.*|songti.*|dejavusansmono.*|notosans(?:mono)?cjk.*|wqy.*)\.(?:ttf|otf|ttc)$/i

let rendererReady: Promise<Uint8Array[]> | undefined

function fontFamily(): string {
  if (process.platform === "win32") return FONT_FAMILIES.win32
  if (process.platform === "darwin") return FONT_FAMILIES.darwin
  return FONT_FAMILIES.linux
}

async function loadFonts(): Promise<Uint8Array[]> {
  const roots =
    process.platform === "win32"
      ? [
          join(process.env.WINDIR ?? "C:\\Windows", "Fonts"),
          join(
            process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
            "Microsoft",
            "Windows",
            "Fonts",
          ),
        ]
      : process.platform === "darwin"
        ? ["/System/Library/Fonts", "/Library/Fonts", join(homedir(), "Library", "Fonts")]
        : [
            "/usr/share/fonts",
            "/usr/local/share/fonts",
            join(homedir(), ".fonts"),
            join(homedir(), ".local/share/fonts"),
          ]
  const paths = new Set<string>()
  async function visit(directory: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "EACCES") return
      throw error
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (FONT_FILE.test(entry.name)) paths.add(path)
    }
  }
  for (const root of roots) await visit(root)
  const available = [...paths].sort()
  const primary =
    process.platform === "win32"
      ? [/^consola/i, /^cascadiamono/i]
      : process.platform === "darwin"
        ? [/^menlo/i]
        : [/^dejavusansmono/i]
  const mono = primary
    .map((pattern) => available.filter((file) => pattern.test(basename(file))))
    .find((files) => files.length)
  if (!mono) {
    throw new Error("No terminal fonts found. Install Cascadia Mono, Consolas, Menlo, or DejaVu Sans Mono.")
  }
  // One CJK collection is enough. Loading every installed fallback wastes memory per parallel walk.
  const fallbackPatterns = [
    /^msyh\./i,
    /^pingfang/i,
    /^notosans(?:mono)?cjk.*regular/i,
    /^msgothic/i,
    /^simsun/i,
    /^hiragino/i,
    /^notosans(?:mono)?cjk/i,
    /^wqy/i,
    /^malgun/i,
    /^songti/i,
  ]
  const fallback = fallbackPatterns
    .map((pattern) => available.find((file) => pattern.test(basename(file))))
    .find(Boolean)
  const selected = fallback ? [...mono, fallback] : [...mono]
  const symbols = available.find((file) => /^(?:seguisym|apple ?symbols)\./i.test(basename(file)))
  if (symbols) selected.push(symbols)
  return Promise.all(selected.map(async (file) => new Uint8Array(await readFile(file))))
}

function initializeRenderer(): Promise<Uint8Array[]> {
  rendererReady ??= (async () => {
    const wasm = await readFile(fileURLToPath(import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm")))
    await initWasm(new Uint8Array(wasm).buffer)
    return loadFonts()
  })()
  return rendererReady
}

function rgb(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`
}

function indexedColor(index: number, theme: ITheme): string {
  if (index < 16) return theme[ANSI_THEME_KEYS[index]!] ?? ANSI_COLORS[index]!
  const custom = theme.extendedAnsi?.[index - 16]
  if (custom) return custom
  if (index >= 232) {
    const level = 8 + (index - 232) * 10
    return rgb((level << 16) | (level << 8) | level)
  }
  const levels = [0, 95, 135, 175, 215, 255]
  const offset = index - 16
  return rgb(
    (levels[Math.floor(offset / 36)]! << 16) |
      (levels[Math.floor(offset / 6) % 6]! << 8) |
      levels[offset % 6]!,
  )
}

function cellColors(cell: IBufferCell, terminal: Terminal): { foreground: string; background: string } {
  const theme = terminal.options.theme ?? {}
  let foreground = theme.foreground ?? DEFAULT_FOREGROUND
  let background = theme.background ?? DEFAULT_BACKGROUND
  if (cell.isFgRGB()) foreground = rgb(cell.getFgColor())
  else if (cell.isFgPalette()) {
    let index = cell.getFgColor()
    if (cell.isBold() && terminal.options.drawBoldTextInBrightColors !== false && index < 8) index += 8
    foreground = indexedColor(index, theme)
  }
  if (cell.isBgRGB()) background = rgb(cell.getBgColor())
  else if (cell.isBgPalette()) background = indexedColor(cell.getBgColor(), theme)
  if (cell.isInverse()) [foreground, background] = [background, foreground]
  return { foreground, background }
}

function xml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      default:
        return "&apos;"
    }
  })
}

function rectangle(x: number, y: number, width: number, height: number, color: string): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${xml(color)}"/>`
}

function glyph(cell: IBufferCell, x: number, y: number, foreground: string): string {
  if (cell.isInvisible()) return ""
  const width = cell.getWidth() * CELL_WIDTH
  let content = ""
  if (cell.getChars().trim()) {
    const geometry = cellGeometry(cell.getChars(), x, y, width, CELL_HEIGHT)
    content +=
      geometry === undefined
        ? `<text x="${x}" y="${y + 16}" fill="${xml(foreground)}" font-weight="${cell.isBold() ? 700 : 400}" font-style="${cell.isItalic() ? "italic" : "normal"}" xml:space="preserve">${xml(cell.getChars())}</text>`
        : `<g fill="${xml(foreground)}" color="${xml(foreground)}">${geometry}</g>`
  }
  if (cell.isUnderline()) content += rectangle(x, y + 18, width, 1, foreground)
  if (cell.isStrikethrough()) content += rectangle(x, y + 10, width, 1, foreground)
  if (cell.isOverline()) content += rectangle(x, y + 1, width, 1, foreground)
  return cell.isDim() ? `<g opacity="0.5">${content}</g>` : content
}

function screenSvg(terminal: Terminal): string {
  const buffer = terminal.buffer.active
  const theme = terminal.options.theme ?? {}
  const backgrounds: string[] = []
  const glyphs: string[] = []
  const cell = buffer.getNullCell()
  for (let row = 0; row < terminal.rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row)
    if (!line) continue
    for (let column = 0; column < terminal.cols; column++) {
      if (!line.getCell(column, cell) || cell.getWidth() === 0) continue
      const { foreground, background } = cellColors(cell, terminal)
      const x = column * CELL_WIDTH
      const y = row * CELL_HEIGHT
      backgrounds.push(rectangle(x, y, cell.getWidth() * CELL_WIDTH, CELL_HEIGHT, background))
      glyphs.push(glyph(cell, x, y, foreground))
    }
  }

  // Headless xterm 6 exposes cursor position but not DEC mode 25 (visibility).
  // Keep this single private read isolated; never modify the terminal internals.
  const hidden =
    (
      terminal as Terminal & {
        _core?: { coreService?: { isCursorHidden?: boolean } }
      }
    )._core?.coreService?.isCursorHidden ?? false
  const cursorRow = buffer.baseY + buffer.cursorY - buffer.viewportY
  if (!hidden && cursorRow >= 0 && cursorRow < terminal.rows) {
    const line = buffer.getLine(buffer.baseY + buffer.cursorY)
    let column = Math.min(buffer.cursorX, terminal.cols - 1)
    if (line?.getCell(column)?.getWidth() === 0) column = Math.max(0, column - 1)
    const cursorCell = line?.getCell(column)
    const x = column * CELL_WIDTH
    const y = cursorRow * CELL_HEIGHT
    const width = Math.max(1, cursorCell?.getWidth() ?? 1) * CELL_WIDTH
    const color = theme.cursor ?? theme.foreground ?? DEFAULT_FOREGROUND
    switch (terminal.options.cursorStyle) {
      case "bar":
        glyphs.push(rectangle(x, y, terminal.options.cursorWidth ?? 1, CELL_HEIGHT, color))
        break
      case "underline":
        glyphs.push(rectangle(x, y + CELL_HEIGHT - 2, width, 2, color))
        break
      default:
        glyphs.push(rectangle(x, y, width, CELL_HEIGHT, color))
        if (cursorCell)
          glyphs.push(glyph(cursorCell, x, y, theme.cursorAccent ?? theme.background ?? DEFAULT_BACKGROUND))
    }
  }

  const width = terminal.cols * CELL_WIDTH
  const height = terminal.rows * CELL_HEIGHT
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${xml(theme.background ?? DEFAULT_BACKGROUND)}"/>${backgrounds.join("")}<g font-family="${xml(fontFamily())}" font-size="${FONT_SIZE}">${glyphs.join("")}</g></svg>`
}

/** Render a snapshot of the active viewport using fixed 10×20 pixel cells. */
export async function renderScreen(terminal: Terminal): Promise<Uint8Array> {
  // Snapshot before awaiting initialization so concurrent output cannot tear the image.
  const svg = screenSvg(terminal)
  const fontBuffers = await initializeRenderer()
  const renderer = new Resvg(svg, {
    font: { fontBuffers, defaultFontFamily: fontFamily().split(",")[0]!, defaultFontSize: FONT_SIZE },
  })
  try {
    const image = renderer.render()
    try {
      return image.asPng().slice()
    } finally {
      image.free()
    }
  } finally {
    renderer.free()
  }
}

/** Visible rows only, with trailing whitespace trimmed and optional 1-based row numbers. */
export function screenText(terminal: Terminal, lineNumbers = true): string {
  const buffer = terminal.buffer.active
  const digits = String(terminal.rows).length
  const lines: string[] = []
  for (let row = 0; row < terminal.rows; row++) {
    const text = (
      buffer.getLine(buffer.viewportY + row)?.translateToString(true, 0, terminal.cols) ?? ""
    ).trimEnd()
    lines.push(lineNumbers ? `${String(row + 1).padStart(digits)}: ${text}` : text)
  }
  return lines.join("\n")
}

function ansiColor(cell: IBufferCell, foreground: boolean): string {
  const value = foreground ? cell.getFgColor() : cell.getBgColor()
  const code = foreground ? 38 : 48
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) {
    return `${code};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`
  }
  if (foreground ? cell.isFgPalette() : cell.isBgPalette()) {
    // xterm distinguishes the original 16-colour SGR mode from indexed (38/48;5) mode.
    const mode = foreground ? cell.getFgColorMode() : cell.getBgColorMode()
    if (mode === 0x1000000) return String((foreground ? 30 : 40) + (value < 8 ? value : value + 52))
    return `${code};5;${value}`
  }
  return foreground ? "39" : "49"
}

/** Reconstruct visible cell attributes as ANSI; does not include scrollback or the cursor. */
export function screenAnsi(terminal: Terminal): string {
  const buffer = terminal.buffer.active
  const cell = buffer.getNullCell()
  const lines: string[] = []
  for (let row = 0; row < terminal.rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row)
    let output = ""
    let previous = ""
    for (let column = 0; column < terminal.cols; column++) {
      if (!line?.getCell(column, cell) || cell.getWidth() === 0) continue
      const attributes = ["0", ansiColor(cell, true), ansiColor(cell, false)]
      if (cell.isBold()) attributes.push("1")
      if (cell.isDim()) attributes.push("2")
      if (cell.isItalic()) attributes.push("3")
      if (cell.isUnderline()) attributes.push("4")
      if (cell.isBlink()) attributes.push("5")
      if (cell.isInverse()) attributes.push("7")
      if (cell.isInvisible()) attributes.push("8")
      if (cell.isStrikethrough()) attributes.push("9")
      if (cell.isOverline()) attributes.push("53")
      const style = attributes.join(";")
      if (style !== previous) output += `\x1b[${style}m`
      previous = style
      output += cell.getChars() || " "
    }
    lines.push(`${output}\x1b[0m`)
  }
  return lines.join("\r\n")
}
