import { graphemes } from "../src/width.ts"

/**
 * A tiny VT emulator, just enough to check what the renderer leaves on screen: printing with
 * autowrap, CR/LF with scrolling, CUU/CUD/CHA, EL 2 and ED 0. Colors and modes are ignored.
 */
export class VirtualScreen {
  grid: string[][]
  scrollback: string[] = []
  x = 0
  y = 0
  cursorVisible = true

  constructor(
    public cols: number,
    public rows: number,
  ) {
    this.grid = Array.from({ length: rows }, () => this.blank())
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

  /** Scrollback plus screen, with trailing empty rows removed. */
  get text(): string {
    const all = [...this.scrollback, ...this.lines]
    while (all.length > 0 && all[all.length - 1] === "") all.pop()
    return all.join("\n")
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
      this.scrollback.push(this.grid.shift()!.join("").trimEnd())
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
      case "J":
        if (params === "" || params === "0") {
          const row = this.grid[this.y]!
          for (let x = this.x; x < this.cols; x++) row[x] = " "
          for (let y = this.y + 1; y < this.rows; y++) this.grid[y] = this.blank()
        }
        break
      case "h":
      case "l":
        if (params === "?25") this.cursorVisible = final === "h"
        break
    }
    return j + 1
  }
}
