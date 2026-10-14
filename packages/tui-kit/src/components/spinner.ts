import type { Component, RenderContext } from "../component.ts"
import { chromeGlyphs, type Glyphs } from "../glyphs.ts"
import { themeToken } from "../style.ts"
import { truncateToWidth } from "../width.ts"

export interface SpinnerOptions {
  label?: string
  frames?: string[]
  intervalMs?: number
}

const DOTS = chromeGlyphs().spinnerFrames

/** A one-line spinner with a label. `start(onFrame)` animates it; pass the renderer's requestRender. */
export class Spinner implements Component {
  static readonly INTERVAL_MS = 80

  /** Matching ASCII frames for a shared Unicode spinner frame. */
  static ascii(glyph: string): string {
    return Spinner.forGlyphs(glyph, { pointer: ">" })
  }

  /** Resolve a shared frame against the current component glyph profile. */
  static forGlyphs(glyph: string, glyphs?: Partial<Glyphs>): string {
    const frame = DOTS.indexOf(glyph)
    const frames = chromeGlyphs(glyphs).spinnerFrames
    return frame < 0 ? glyph : (frames[frame % frames.length] ?? "")
  }

  label: string
  private frames: readonly string[]
  private intervalMs: number
  private frame = 0
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: SpinnerOptions = {}) {
    this.label = opts.label ?? ""
    this.frames = opts.frames ?? DOTS
    this.intervalMs = opts.intervalMs ?? Spinner.INTERVAL_MS
  }

  start(onFrame: () => void): void {
    this.stop()
    this.timer = setInterval(() => {
      this.tick()
      onFrame()
    }, this.intervalMs)
  }

  /** Whether a caller already owns its animation timer. */
  get running(): boolean {
    return this.timer !== undefined
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  tick(): void {
    this.frame = (this.frame + 1) % this.frames.length
  }

  /** The current frame, for drawing the spinner inside another line. */
  get glyph(): string {
    return this.frames[this.frame] ?? ""
  }

  render(width: number, { theme, glyphs }: RenderContext): string[] {
    const shimmer = themeToken(theme, "shimmer") ?? theme.accent
    const glyph = shimmer(Spinner.forGlyphs(this.glyph, glyphs))
    const text = this.label ? `${glyph} ${theme.muted(this.label)}` : glyph
    return [truncateToWidth(text, width)]
  }
}
