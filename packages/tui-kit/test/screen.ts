import { graphemes } from "../src/width.ts"

/**
 * A tiny VT emulator, just enough to check what the renderer leaves on screen: printing with
 * autowrap, CR/LF with scrolling, CUU/CUD/CHA/CUP, EL 2, ED 0 and 2 (on the main screen it
 * scrolls the rows into the scrollback, as Windows Terminal does), and the alternate screen
 * (1049: saves the cursor, and the main screen comes back as it was). Colors and other modes are
 * ignored; OSC strings (title, progress, hyperlinks) are recorded in `oscs`, not drawn. `resize`
 * changes the size without re-wrapping, like a terminal that got wider.
 *
 * Images are drawn as cells of `▓`, scrolling when they reach the bottom: Sixel (its raster size
 * in cells of `cell` pixels), leaving the cursor on the line below it as Windows Terminal does;
 * iTerm2's (its width and height in cells), leaving the cursor after its last row; kitty's with
 * C=1, not moving it. ESC 7 and ESC 8 save and restore the cursor.
 */
export class VirtualScreen {
  grid: string[][]
  scrollback: string[] = []
  x = 0
  y = 0
  cursorVisible = true
  /** Pixels per cell for Sixel images. */
  cell = { width: 10, height: 20 }
  /** Images drawn: where (the row counted from the top of the scrollback), and the cells taken. */
  images: { protocol: "sixel" | "iterm2" | "kitty"; row: number; col: number; rows: number; cols: number }[] =
    []
  private savedCursor = { x: 0, y: 0 }
  /** OSC strings received (`0;title`, `9;4;3;0`), without ESC ] and the terminator. */
  oscs: string[] = []
  /** Bell characters received outside OSC strings. */
  bells = 0
  /** The main screen and its cursor while the alternate screen is shown. */
  saved: { grid: string[][]; x: number; y: number } | undefined
  /** Every time the alternate screen was entered (true) or left (false), in order. */
  altSwitches: boolean[] = []

  constructor(
    public cols: number,
    public rows: number,
  ) {
    this.grid = Array.from({ length: rows }, () => this.blank())
  }

  get inAltScreen(): boolean {
    return this.saved !== undefined
  }

  /** New size; rows cut from the top of the main screen go to the scrollback. */
  resize(cols: number, rows: number): void {
    const fit = (grid: string[][], keepScrollback: boolean) => {
      const out = grid.map((row) => [
        ...row.slice(0, cols),
        ...Array(Math.max(0, cols - row.length)).fill(" "),
      ])
      while (out.length > rows) {
        const top = out.shift()!
        if (keepScrollback) this.scrollback.push(top.join("").trimEnd())
      }
      while (out.length < rows) out.push(Array(cols).fill(" "))
      return out
    }
    const shift = Math.max(0, this.grid.length - rows)
    this.cols = cols
    this.rows = rows
    if (this.saved) {
      const shiftMain = Math.max(0, this.saved.grid.length - rows)
      this.saved.grid = fit(this.saved.grid, true)
      this.saved.y = Math.max(0, this.saved.y - shiftMain)
      this.grid = fit(this.grid, false)
      this.y = Math.max(0, Math.min(rows - 1, this.y - shift))
    } else {
      this.grid = fit(this.grid, true)
      this.y = Math.max(0, this.y - shift)
    }
    this.x = Math.min(this.x, cols - 1)
  }

  write(data: string): void {
    let i = 0
    while (i < data.length) {
      const ch = data[i]!
      if (ch === "\x1b") {
        i = this.escape(data, i)
        continue
      }
      if (ch === "\r") this.x = 0
      else if (ch === "\n") this.lineFeed()
      else if (ch === "\x07") this.bells++
      else {
        const next = data.indexOf("\x1b", i)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: BEL ends a run of text
        const run = data.slice(i, next === -1 ? undefined : next).split(/[\r\n\x07]/)[0]!
        for (const g of graphemes(run)) this.print(g)
        i += run.length
        continue
      }
      i++
    }
  }

  get lines(): string[] {
    return this.grid.map((row) => row.join("").trimEnd())
  }

  /** The main screen's scrollback and rows, even while the alternate screen is shown. */
  get mainText(): string {
    const grid = this.saved?.grid ?? this.grid
    const all = [...this.scrollback, ...grid.map((row) => row.join("").trimEnd())]
    while (all.length > 0 && all[all.length - 1] === "") all.pop()
    return all.join("\n")
  }

  /** Scrollback plus screen, with trailing empty rows removed. */
  get text(): string {
    const all = [...this.scrollback, ...this.lines]
    while (all.length > 0 && all[all.length - 1] === "") all.pop()
    return all.join("\n")
  }

  private altScreen(on: boolean): void {
    if (on === this.inAltScreen) return
    this.altSwitches.push(on)
    if (on) {
      this.saved = { grid: this.grid, x: this.x, y: this.y }
      this.grid = Array.from({ length: this.rows }, () => this.blank())
    } else {
      const s = this.saved!
      this.saved = undefined
      this.grid = s.grid
      this.x = s.x
      this.y = s.y
    }
  }

  private blank(): string[] {
    return Array.from({ length: this.cols }, () => " ")
  }

  private print(g: string): void {
    const w = Bun.stringWidth(g)
    if (w === 0) return
    if (this.x + w > this.cols) {
      this.x = 0
      this.lineFeed()
    }
    const row = this.grid[this.y]!
    row[this.x] = g
    if (w === 2) row[this.x + 1] = ""
    this.x += w
  }

  private lineFeed(): void {
    if (this.y === this.rows - 1) {
      const top = this.grid.shift()!
      // The alternate screen has no scrollback.
      if (!this.saved) this.scrollback.push(top.join("").trimEnd())
      this.grid.push(this.blank())
    } else this.y++
  }

  /** Paints an image of `rows`×`cols` cells at the cursor, scrolling to make room. */
  private image(protocol: "sixel" | "iterm2" | "kitty", rows: number, cols: number): void {
    const col = this.x
    for (let r = 0; r < rows; r++) {
      if (r > 0) this.lineFeed()
      for (let c = col; c < Math.min(this.cols, col + cols); c++) this.grid[this.y]![c] = "▓"
    }
    this.images.push({ protocol, row: this.scrollback.length + this.y - (rows - 1), col, rows, cols })
  }

  private escape(data: string, i: number): number {
    const kind = data[i + 1]
    if (kind === "7" || kind === "8") {
      if (kind === "7") this.savedCursor = { x: this.x, y: this.y }
      else ({ x: this.x, y: this.y } = this.savedCursor)
      return i + 2
    }
    if (kind === "_" || kind === "P" || kind === "]") {
      // APC, DCS and OSC strings end with BEL (not DCS) or ST.
      const bel = kind === "P" ? -1 : data.indexOf("\x07", i)
      const st = data.indexOf("\x1b\\", i + 2)
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
      const body = data.slice(i + 2, end === -1 ? data.length : end)
      const next = end === -1 ? data.length : end === st ? end + 2 : end + 1
      if (kind === "]") {
        const file = /^1337;File=([^:]*):/.exec(body)
        if (file) {
          const arg = (k: string) => Number(new RegExp(`${k}=(\\d+)`).exec(file[1]!)?.[1] ?? 1)
          this.image("iterm2", arg("height"), arg("width"))
          this.x = Math.min(this.cols - 1, this.x + arg("width"))
        } else this.oscs.push(body)
      } else if (kind === "P") {
        const raster = /q"1;1;(\d+);(\d+)/.exec(body)
        if (raster) {
          const h = Math.ceil(Number(raster[2]) / 6) * 6
          const x = this.x
          this.image("sixel", Math.ceil(h / this.cell.height), Math.ceil(Number(raster[1]) / this.cell.width))
          this.lineFeed()
          this.x = x
        }
      } else if (body.startsWith("G") && /[,G]a=T/.test(body)) {
        const g = /s=(\d+),v=(\d+)/.exec(body)!
        const { x, y } = this
        this.image(
          "kitty",
          Math.ceil(Number(g[2]) / this.cell.height),
          Math.ceil(Number(g[1]) / this.cell.width),
        )
        this.x = x
        this.y = y
      }
      return next
    }
    if (data[i + 1] !== "[") return i + 2
    let j = i + 2
    while (j < data.length && /[0-9;?$]/.test(data[j]!)) j++
    const params = data.slice(i + 2, j)
    const final = data[j]
    const n = Number.parseInt(params, 10) || 1
    const col = () => Math.min(this.x, this.cols - 1)
    switch (final) {
      case "A":
        this.y = Math.max(0, this.y - n)
        this.x = col()
        break
      case "B":
        this.y = Math.min(this.rows - 1, this.y + n)
        this.x = col()
        break
      case "G":
        this.x = Math.min(n - 1, this.cols - 1)
        break
      case "K":
        if (params === "2") this.grid[this.y] = this.blank()
        break
      case "H": {
        const [r, c] = params.split(";").map((p) => Number.parseInt(p, 10) || 1)
        this.y = Math.min((r ?? 1) - 1, this.rows - 1)
        this.x = Math.min((c ?? 1) - 1, this.cols - 1)
        break
      }
      case "J":
        if (params === "" || params === "0") {
          const row = this.grid[this.y]!
          for (let x = this.x; x < this.cols; x++) row[x] = " "
          for (let y = this.y + 1; y < this.rows; y++) this.grid[y] = this.blank()
        } else if (params === "2") {
          // Like Windows Terminal and conhost: the main screen's rows, up to the last one
          // written, scroll into the scrollback rather than being erased in place.
          if (!this.saved) {
            const rows = this.grid.map((row) => row.join("").trimEnd())
            while (rows.length && rows[rows.length - 1] === "") rows.pop()
            this.scrollback.push(...rows)
          }
          this.grid = Array.from({ length: this.rows }, () => this.blank())
        }
        break
      case "h":
      case "l":
        if (params === "?25") this.cursorVisible = final === "h"
        if (params === "?1049") this.altScreen(final === "h")
        break
    }
    return j + 1
  }
}
