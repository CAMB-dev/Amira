import type { Component } from "../component.ts"
import { defaultTheme, type Theme } from "../style.ts"
import { truncateToWidth } from "../width.ts"

export interface SpinnerOptions {
  label?: string
  frames?: string[]
  intervalMs?: number
  theme?: Theme
}

const DOTS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** A one-line spinner with a label. `start(onFrame)` animates it; pass the renderer's requestRender. */
export class Spinner implements Component {
  label: string
  private frames: string[]
  private intervalMs: number
  private theme: Theme
  private frame = 0
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: SpinnerOptions = {}) {
    this.label = opts.label ?? ""
    this.frames = opts.frames ?? DOTS
    this.intervalMs = opts.intervalMs ?? 80
    this.theme = opts.theme ?? defaultTheme
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

  render(width: number): string[] {
    const glyph = this.theme.accent(this.frames[this.frame] ?? "")
    const text = this.label ? `${glyph} ${this.theme.muted(this.label)}` : glyph
    return [truncateToWidth(text, width)]
  }
}
