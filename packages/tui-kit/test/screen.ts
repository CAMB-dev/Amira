import { graphemes } from "../src/width.ts"

/**
 * A tiny VT emulator, just enough to check what the renderer leaves on screen: printing with
 * autowrap, CR/LF with scrolling, CUU/CUD/CHA/CUP, EL 2, ED 0 and 2, and the alternate screen
 * (1049: saves the cursor, and the main screen comes back as it was). Colors and other modes
 * are ignored. `resize` changes the size without re-wrapping, like a terminal that got wider.
 */
export class VirtualScreen {
  grid: string[][]
  scrollback: string[] = []
  x = 0
  y = 0
  cursorVisible = true
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
      else {
        const next = data.indexOf("\x1b", i)
        const run = data.slice(i, next === -1 ? undefined : next).split(/[\r\n]/)[0]!
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

  private escape(data: string, i: number): number {
    if (data[i + 1] === "_") {
      const end = data.indexOf("\x07", i)
      return end === -1 ? data.length : end + 1
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
