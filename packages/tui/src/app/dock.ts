// A bounded extension viewport in the bottom area; selectable content can take focus.
import type { KeyHelp } from "@amira/api"
import { type InputEvent, type RenderContext, themeToken, translateMouse, visibleWidth } from "@amira/tui-kit"
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
      description: "Scroll the dock while the input is focused",
    },
    { keys: keys.label("scroll.bottom") ?? "", description: "Follow new dock output" },
    { keys: "Wheel over dock", description: "Scroll only the dock under the pointer" },
    {
      keys: `Tab${keys.label("view.focus") ? ` (${keys.label("view.focus")} if the view needs Tab)` : ""}`,
      description: "Focus a selectable dock or return to the input",
    },
    { keys: "Esc", description: "Focus a selectable dock when the input is empty; otherwise close it" },
  ].filter((key) => key.keys.length > 0)
}

export class DockedView {
  maxHeight: number | undefined
  private height = 0
  private width = 0
  private top = 0
  private pointerFocused = false

  constructor(
    readonly viewer: ExtensionViewer,
    private keys: Keybindings,
    maxHeight?: number,
    private releaseFocus?: () => void,
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
    const surface = ctx.color ? themeToken(ctx.theme, "codeBg") : undefined
    const readable = surface && themeToken(ctx.theme, "surfaceMuted")
    const theme = readable ? { ...ctx.theme, muted: readable } : ctx.theme
    const rows = this.viewer.render(width, { ...ctx, theme, rows: this.height })
    while (rows.length < this.height) rows.push("")
    // Use the existing code surface, not the user-message band; margins remain unpainted.
    return surface
      ? rows.map((row) => surface(row + " ".repeat(Math.max(0, width - visibleWidth(row)))))
      : rows
  }

  get focusable(): boolean {
    return this.height > 0 && (this.viewer.selectable || (this.pointerFocused && this.viewer.focused))
  }

  /** The fitting pass temporarily gives docks zero rows; check only the final allocation. */
  finishLayout(): boolean {
    if (this.focusable || !this.viewer.focused) return false
    this.viewer.focused = false
    this.releaseFocus?.()
    return true
  }

  /** Bottom-area frames are positioned from the last content row, inside the outer margins. */
  place(rowsBelow: number, screenRows: number): void {
    this.top = screenRows - rowsBelow - this.height
  }

  contains(e: InputEvent): boolean {
    return (
      e.type === "mouse" && e.x >= 0 && e.x < this.width && e.y >= this.top && e.y < this.top + this.height
    )
  }

  handleInput(e: InputEvent): boolean {
    if (!this.height) return false
    if (e.type === "mouse") {
      const local = translateMouse(e, 0, this.top)
      if (!this.contains(e)) {
        if (e.button === "left" && e.action !== "wheel") this.viewer.handleDockInput(local)
        return false
      }
      if (this.viewer.focused) this.viewer.handleInput(local)
      else {
        const handled = this.viewer.handleDockInput(local)
        if (handled && e.button === "left" && e.action === "release") {
          // Inputs and reading widgets can take pointer focus without changing initial Tab routing.
          this.pointerFocused = true
          this.viewer.focused = true
        }
        if (e.action !== "wheel") return handled
      }
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
