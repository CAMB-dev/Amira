import { cursor } from "../ansi.ts"
import { iterm2Sequence, kittyChunks, sixelHead, validPayload } from "./sequence.ts"
import type { Fit, ImagePayload, ImageProtocol } from "./types.ts"

/**
 * kitty's image numbers are shared by everything drawing in the window: start somewhere random
 * (below 2^31), so another program's images are not replaced.
 */
let nextImageId = 1 + Math.floor(Math.random() * 0x3fff_0000)

const kitty = (keys: string, payload = "") => `\x1b_G${keys};${payload}\x1b\\`

/**
 * What every image of the full screen may hold at once (prepared bands and pixels, slices), in
 * characters of their sequences. Past it, what was used longest ago is let go (not what was
 * used within the last second, which is on screen); it is prepared again when wanted.
 */
let budget = 96 * 1024 * 1024
/** Images holding something, least recently used first. */
const holding = new Set<ScreenImage>()
let held = 0
/** An image not wanted (placed, or waited for) within this long is not prepared any more. */
const WANTED_MS = 1000

/**
 * Slices of one Sixel image kept (joining one again costs a copy of its bands, well under a
 * millisecond): scrolling makes a new one at almost every step.
 */
const SLICES_KEPT = 8

function preparedChars(p: ImagePayload): number {
  if (p.protocol === "iterm2") return p.data.length
  if (p.protocol === "kitty") return p.data.length
  let n = p.palette.length
  for (const bands of Object.values(p.phases)) for (const b of bands) n += b.length + 1
  return n
}

/** For tests: the characters all screen images may hold. */
export function setScreenImageBudget(chars: number): void {
  budget = chars
}

function trimHeld(now: number) {
  for (const image of holding) {
    if (held <= budget) break
    if (now - image.usedAt < WANTED_MS) continue
    image.release()
  }
}

/**
 * Prepares an image: gets it encoded at its fitted size (by its provider). Returns undefined
 * when that failed, null when `wanted` said no before the work began (it was no longer needed).
 */
export type PrepareImage = (wanted: () => boolean) => Promise<ImagePayload | undefined | null>

/**
 * An image at one fitted size, as the full-screen view draws it: any run of its rows of cells
 * (a slice) at a place on the screen, again and again. Sixel slices are joined from bands
 * encoded once (a slice starting at any row of cells has its bands ready); kitty's image is
 * sent once and then placed, cropped by the terminal; iTerm2's protocol takes the file whole,
 * so it is only drawn whole.
 *
 * Nothing is done until it is wanted (`whenReady`, by a view about to show it): then it is
 * prepared (Sixel and kitty off the main thread). What it holds counts against a budget shared
 * by all images, so one scrolled past long ago lets go of it, to be prepared again if it comes
 * back.
 */
export class ScreenImage {
  readonly id = nextImageId++
  readonly cols: number
  readonly rows: number
  /** When it was last wanted or drawn. */
  usedAt = Number.NEGATIVE_INFINITY
  private prepared: ImagePayload | undefined
  private state: "idle" | "preparing" | "ready" | "failed" = "idle"
  private slices = new Map<string, string>()
  private chars = 0
  private listeners = new Set<() => void>()

  constructor(
    readonly protocol: ImageProtocol,
    readonly fit: Fit,
    private cellHeight: number,
    private prepare: PrepareImage,
  ) {
    this.cols = fit.cols
    this.rows = fit.rows
  }

  /** Whether it can be drawn now. */
  get ready(): boolean {
    return this.state === "ready"
  }

  /** Whether getting it ready failed: it is shown as its alt text. */
  get broken(): boolean {
    return this.state === "failed"
  }

  /** Whether a part of it can be drawn (the rest being off screen). */
  get croppable(): boolean {
    return this.protocol !== "iterm2"
  }

  /** Calls `fn` once it is ready (or failed), at once if it is; wants it meanwhile (see `want`). */
  whenReady(fn: () => void): void {
    if (this.state === "ready" || this.state === "failed") {
      this.touch()
      fn()
      return
    }
    this.listeners.add(fn)
    this.want()
  }

  /**
   * Notes that it is on screen (views say so every frame): it keeps what it holds, and starts
   * preparing if it is not ready.
   */
  want(): void {
    this.touch()
    if (this.state !== "idle") return
    this.state = "preparing"
    this.prepare(() => performance.now() - this.usedAt < WANTED_MS).then(
      (p) => this.settle(p),
      () => this.settle(undefined),
    )
  }

  private settle(prepared: ImagePayload | undefined | null): void {
    if (prepared === null) {
      // Not wanted lately: left for when it is. Those waiting hear of it, so a view that still
      // shows it (idle for a while) wants it again.
      this.state = "idle"
    } else if (prepared && validPayload(prepared, this.protocol, this.fit)) {
      this.prepared = prepared
      this.state = "ready"
      this.hold(preparedChars(prepared))
    } else this.state = "failed"
    const fns = [...this.listeners]
    this.listeners.clear()
    for (const fn of fns) fn()
  }

  /** Lets go of what it holds; it is prepared again when next wanted. */
  release(): void {
    if (this.state !== "ready") return
    this.prepared = undefined
    this.slices.clear()
    this.state = "idle"
    held -= this.chars
    this.chars = 0
    holding.delete(this)
  }

  private touch() {
    this.usedAt = performance.now()
    if (holding.has(this)) {
      holding.delete(this)
      holding.add(this)
    }
  }

  private hold(chars: number) {
    this.chars += chars
    held += chars
    holding.delete(this)
    holding.add(this)
    trimHeld(this.usedAt)
  }

  /**
   * What draws its rows `[from, to)` at the cursor (Sixel, iTerm2), or undefined when that cannot
   * be drawn (yet). For kitty, see `upload` and `place`.
   */
  draw(from: number, to: number): string | undefined {
    const p = this.prepared
    if (!p) return undefined
    this.touch()
    if (p.protocol === "iterm2")
      return from === 0 && to === this.rows ? iterm2Sequence(p, this.fit) : undefined
    if (p.protocol !== "sixel") return undefined
    const key = `${from}:${to}`
    const hit = this.slices.get(key)
    if (hit !== undefined) {
      this.slices.delete(key)
      this.slices.set(key, hit)
      return hit
    }
    const seq = sixelSlice(p, from * this.cellHeight, to * this.cellHeight)
    this.slices.set(key, seq)
    if (this.slices.size > SLICES_KEPT) {
      const [oldest, dropped] = this.slices.entries().next().value!
      this.slices.delete(oldest)
      this.chars -= dropped.length
      held -= dropped.length
    }
    this.hold(seq.length)
    return seq
  }

  /** kitty: sends the pixels, under its id, without showing them. */
  upload(): string {
    const p = this.prepared
    if (p?.protocol !== "kitty") return ""
    return kittyChunks(`a=t,f=32,s=${p.width},v=${p.height},o=z,i=${this.id},q=2`, p.data)
  }

  /**
   * kitty: shows rows `[from, to)` at the cursor as placement `pid`, which replaces the one of
   * that number (so moving it is placing it again), scaled into the cells, the cursor not moving.
   */
  place(from: number, to: number, pid: number): string {
    const p = this.prepared
    if (p?.protocol !== "kitty") return ""
    let crop = ""
    if (from > 0 || to < this.rows) {
      const y = Math.round((from * p.height) / this.rows)
      const h = Math.max(1, Math.round((to * p.height) / this.rows) - y)
      crop = `x=0,y=${y},w=${p.width},h=${h},`
    }
    return kitty(`a=p,i=${this.id},p=${pid},${crop}c=${this.cols},r=${to - from},C=1,q=2`)
  }

  /** kitty: takes placement `pid` away, keeping the pixels. */
  remove(pid: number): string {
    return this.protocol === "kitty" ? kitty(`a=d,d=i,i=${this.id},p=${pid},q=2`) : ""
  }

  /** kitty: frees the pixels sent. */
  free(): string {
    return this.protocol === "kitty" ? kitty(`a=d,d=I,i=${this.id},q=2`) : ""
  }
}

/**
 * The Sixel image of pixel rows `[y0, limit)`: the bands from `y0` (in its phase), as many
 * whole ones as fit above `limit` (so drawing never reaches the row below), and never past
 * the image's end.
 */
function sixelSlice(p: Extract<ImagePayload, { protocol: "sixel" }>, y0: number, limit: number): string {
  if (y0 >= p.height) return ""
  const phase = y0 % 6
  const bands = p.phases[phase] ?? []
  const first = (y0 - phase) / 6
  const n = Math.min(Math.floor((limit - y0) / 6), bands.length - first)
  if (n <= 0) return ""
  const height = Math.min(n * 6, p.height - y0)
  return `${sixelHead(p.width, height)}${p.palette}${bands.slice(first, first + n).join("-")}\x1b\\`
}

/** An image shown in a frame: its rows `[from, to)`, the first at `row`, `col` of the screen. */
export interface ImagePlacement {
  image: ScreenImage
  row: number
  col: number
  from: number
  to: number
  /** Which occurrence this is, the same from frame to frame (the same image may show twice). */
  key: string
}

interface Shown extends ImagePlacement {
  /** kitty's placement number. */
  pid: number
}

/** kitty images kept in the terminal while not shown; older ones are freed. */
const KITTY_KEPT = 32
const DELETE_ALL_PLACEMENTS = kitty("a=d,d=a,q=2")

/**
 * The images of a full-screen renderer: which are shown where, and what each frame must do
 * about them. Images are drawn after the frame's text, only when they became visible or
 * moved (or their rows were written over); one that is unchanged costs nothing. Rows an image
 * leaves are repainted, which erases Sixel and iTerm2 pixels (Windows Terminal keeps them until
 * written over); kitty's placements are taken away instead, or moved by placing them again.
 */
export class ScreenImageLayer {
  private shown = new Map<string, Shown>()
  private uploaded = new Map<number, ScreenImage>()
  private nextPid = 1

  /**
   * One frame. `rows`×`columns` is the screen, `full` says it is cleared and every row written,
   * `changed` whether a row's text differs from the last frame (it is repainted). Returns the
   * rows the text must repaint too, and what to write before and after the text.
   */
  frame(
    placements: ImagePlacement[],
    opts: { full: boolean; rows: number; columns: number; changed: (row: number) => boolean },
  ): { repaint: Set<number>; before: string; after: string } {
    const repaint = new Set<number>()
    let before = ""
    let after = ""
    // Placement numbers are kept across a redraw.
    const pids = this.shown
    if (opts.full) {
      // The screen is cleared: nothing is left of Sixel's pixels, and kitty's placements go too.
      if ([...this.shown.values()].some((s) => s.image.protocol === "kitty")) before += DELETE_ALL_PLACEMENTS
      this.shown = new Map()
    }
    const next = new Map<string, Shown>()
    const draws: { s: Shown; seq?: string }[] = []
    for (const raw of placements) {
      const p = fitted(raw, opts.rows, opts.columns)
      if (!p || next.has(p.key)) continue
      const old = this.shown.get(p.key)
      const cells = p.image.protocol !== "kitty"
      if (
        old &&
        old.image === p.image &&
        old.row === p.row &&
        old.col === p.col &&
        old.from === p.from &&
        old.to === p.to &&
        !(cells && rowsOf(p).some(opts.changed))
      ) {
        next.set(p.key, old)
        continue
      }
      const seq = cells ? p.image.draw(p.from, p.to) : undefined
      if (cells ? seq === undefined : !p.image.ready) continue
      const was = pids.get(p.key)
      const s: Shown = { ...p, pid: was && was.image === p.image ? was.pid : this.nextPid++ }
      next.set(p.key, s)
      draws.push(seq === undefined ? { s } : { s, seq })
    }
    for (const [key, old] of this.shown) {
      const now = next.get(key)
      if (now === old) continue
      if (old.image.protocol === "kitty") {
        // Placing it again under the same number moves it.
        if (now?.image !== old.image) before += old.image.remove(old.pid)
      } else for (const r of rowsOf(old)) repaint.add(r)
    }
    for (const { s, seq } of draws) {
      if (seq !== undefined) for (const r of rowsOf(s)) repaint.add(r)
    }
    // An image kept whose rows are repainted anyway is drawn again after them.
    for (const [key, s] of next) {
      if (s.image.protocol === "kitty" || this.shown.get(key) !== s) continue
      if (!rowsOf(s).some((r) => repaint.has(r))) continue
      const seq = s.image.draw(s.from, s.to)
      if (seq !== undefined) draws.push({ s, seq })
      else next.delete(key)
    }
    for (const { s, seq } of draws) {
      if (seq !== undefined) {
        // Terminals leave the cursor in different places after an image: it is put back.
        if (seq) after += `${cursor.to(s.row, s.col)}\x1b7${seq}\x1b8`
        continue
      }
      if (!this.uploaded.has(s.image.id)) after += s.image.upload()
      this.uploaded.delete(s.image.id)
      this.uploaded.set(s.image.id, s.image)
      after += cursor.to(s.row, s.col) + s.image.place(s.from, s.to, s.pid)
    }
    this.shown = next
    if (this.uploaded.size > KITTY_KEPT) {
      const showing = new Set([...next.values()].map((s) => s.image.id))
      for (const [id, image] of this.uploaded) {
        if (this.uploaded.size <= KITTY_KEPT) break
        if (showing.has(id)) continue
        this.uploaded.delete(id)
        after += image.free()
      }
    }
    return { repaint, before, after }
  }

  /** Forgets what is shown (the screen was left); returns what frees kitty's images. */
  close(): string {
    let out = ""
    for (const image of this.uploaded.values()) out += image.free()
    this.uploaded.clear()
    this.shown.clear()
    return out
  }
}

function rowsOf(p: ImagePlacement): number[] {
  return Array.from({ length: p.to - p.from }, (_, i) => p.row + i)
}

/**
 * The placement kept to the screen, or undefined when it cannot show: never on the last row
 * (a Sixel image ending there scrolls the screen), cut there when it can be cropped.
 */
function fitted(p: ImagePlacement, rows: number, columns: number): ImagePlacement | undefined {
  const { image } = p
  const from = Math.max(0, p.from)
  let to = Math.min(image.rows, p.to)
  if (p.row < 0 || p.col < 0 || p.col + image.cols > columns || to <= from) return undefined
  if (p.row + (to - from) > rows - 1) {
    if (!image.croppable) return undefined
    to = from + (rows - 1 - p.row)
    if (to <= from) return undefined
  }
  if (!image.croppable && (from !== 0 || to !== image.rows)) return undefined
  return from === p.from && to === p.to ? p : { ...p, from, to }
}
