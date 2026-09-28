import type { Component, RenderContext } from "../component.ts"
import type { InputEvent } from "../keys.ts"

/** Which part of the content a `ScrollView` shows. */
export interface ScrollPosition {
  /** Index of the first line shown. */
  top: number
  /** Rows the view shows. */
  height: number
  /** Lines of content, as of the last render. */
  total: number
  /** Whether the view keeps to the end as content arrives. */
  following: boolean
}

/**
 * A window of `height` rows onto content that may be much longer, e.g. a transcript. It
 * follows the tail by default: new lines at the end stay in view. Scrolling up stops that, so
 * what is being read stays put while content grows; scrolling back to the bottom (or End)
 * follows again. Keys: ↑↓ one row, PgUp/PgDn a page, Home/End the start and the end. On the
 * alternate screen with alternate scroll mode the mouse wheel arrives as ↑↓ as well.
 */
export class ScrollView implements Component {
  /** Rows to show; set by the parent before each render. Always rendered as exactly this many. */
  height = 10
  private top = 0
  private total = 0
  private following = true

  constructor(private content: (width: number, ctx: RenderContext) => string[]) {}

  render(width: number, ctx: RenderContext): string[] {
    const lines = this.content(width, ctx)
    this.total = lines.length
    const max = this.maxTop()
    this.top = this.following ? max : Math.min(this.top, max)
    const out = lines.slice(this.top, this.top + this.height)
    while (out.length < this.height) out.push("")
    return out
  }

  get position(): ScrollPosition {
    return { top: this.top, height: this.height, total: this.total, following: this.following }
  }

  /** Scrolls by `rows` (negative is up). Reaching the end follows the tail again. */
  scrollBy(rows: number): void {
    const max = this.maxTop()
    this.top = Math.max(0, Math.min(max, this.top + rows))
    this.following = this.top >= max
  }

  scrollToTop(): void {
    this.top = 0
    this.following = this.maxTop() === 0
  }

  scrollToEnd(): void {
    this.following = true
    this.top = this.maxTop()
  }

  handleInput(e: InputEvent): boolean {
    if (e.type !== "key" || e.ctrl || e.alt) return false
    const page = Math.max(1, this.height - 1)
    switch (e.name) {
      case "up":
        this.scrollBy(-1)
        return true
      case "down":
        this.scrollBy(1)
        return true
      case "pageup":
        this.scrollBy(-page)
        return true
      case "pagedown":
        this.scrollBy(page)
        return true
      case "home":
        this.scrollToTop()
        return true
      case "end":
        this.scrollToEnd()
        return true
    }
    return false
  }

  private maxTop(): number {
    return Math.max(0, this.total - this.height)
  }
}
