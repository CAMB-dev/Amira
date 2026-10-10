import type { Component, RenderContext } from "../component.ts"
import { themeToken } from "../style.ts"
import { truncateToWidth } from "../width.ts"

export interface SpinnerOptions {
  label?: string
  frames?: string[]
  intervalMs?: number
}

const DOTS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** A one-line spinner with a label. `start(onFrame)` animates it; pass the renderer's requestRender. */
export class Spinner implements Component {
  label: string
  private frames: string[]
  private intervalMs: number
  private frame = 0
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: SpinnerOptions = {}) {
    this.label = opts.label ?? ""
    this.frames = opts.frames ?? DOTS
    this.intervalMs = opts.intervalMs ?? 80
  }

  start(onFrame: () => void): void {
    this.stop()
    this.timer = setInterval(() => {
      this.tick()
      onFrame()
    }, this.intervalMs)
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

  render(width: number, { theme }: RenderContext): string[] {
    const shimmer = themeToken(theme, "shimmer") ?? theme.accent
    const glyph = shimmer(this.frames[this.frame] ?? "")
    const text = this.label ? `${glyph} ${theme.muted(this.label)}` : glyph
    return [truncateToWidth(text, width)]
  }
}
