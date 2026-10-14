// A bounded extension viewport in the bottom area; it never takes composer focus.
import type { KeyHelp } from "@amira/api"
import { type InputEvent, type RenderContext, themeToken, visibleWidth } from "@amira/tui-kit"
import type { ExtensionViewer } from "../extension-view.ts"
import type { Keybindings } from "../keybindings.ts"

/** Rows include title, header and host controls, and never displace the input. */
export function dockHeight(screenRows: number, available: number, requested?: number): number {
  const cap =
    requested !== undefined && Number.isFinite(requested)
      ? Math.max(5, Math.floor(requested))
      : Math.max(5, Math.floor(screenRows * 0.4))
  return Math.max(0, Math.min(cap, Math.floor(available)))
}

export function dockKeyHelp(keys: Keybindings): KeyHelp[] {
  return [
    {
      keys: [keys.label("scroll.page-up"), keys.label("scroll.page-down")].filter(Boolean).join("/"),
      description: "Scroll the dock; typing and arrows stay in the input",
    },
    { keys: keys.label("scroll.bottom") ?? "", description: "Follow new dock output" },
    { keys: "Wheel over dock", description: "Scroll only the dock under the pointer" },
    { keys: "Esc", description: "Close the dock first; the next Esc cancels or interrupts" },
  ].filter((key) => key.keys.length > 0)
}

export class DockedView {
  maxHeight: number | undefined
  private height = 0
  private width = 0
  private top = 0

  constructor(
    readonly viewer: ExtensionViewer,
    private keys: Keybindings,
    maxHeight?: number,
  ) {
    this.maxHeight = maxHeight
  }

  get visible(): boolean {
    return this.height > 0
  }

  /** A covered dock must recompute its demand when its next visible frame is drawn. */
  hide(): void {
    this.height = 0
  }

  render(width: number, ctx: RenderContext, available: number): string[] {
    this.width = width
    this.height = dockHeight(ctx.rows, available, this.maxHeight)
    if (!this.height) return []
    const rows = this.viewer.render(width, { ...ctx, rows: this.height })
    while (rows.length < this.height) rows.push("")
    // Use the existing code surface, not the user-message band; margins remain unpainted.
    const surface = ctx.color ? themeToken(ctx.theme, "codeBg") : undefined
    return surface
      ? rows.map((row) => surface(row + " ".repeat(Math.max(0, width - visibleWidth(row)))))
      : rows
  }

  /** Bottom-area frames are positioned from the last content row, inside the outer margins. */
  place(rowsBelow: number, screenRows: number): void {
    this.top = screenRows - rowsBelow - this.height
  }

  handleInput(e: InputEvent): boolean {
    if (!this.height) return false
    if (e.type === "mouse") {
      if (
        e.action !== "wheel" ||
        e.x < 0 ||
        e.x >= this.width ||
        e.y < this.top ||
        e.y >= this.top + this.height
      )
        return false
      this.viewer.handleDockInput({ ...e, y: e.y - this.top })
      return true
    }
    if (
      !this.keys.is(e, "scroll.page-up") &&
      !this.keys.is(e, "scroll.page-down") &&
      !this.keys.is(e, "scroll.bottom")
    )
      return false
    this.viewer.handleDockInput(e)
    return true
  }
}
