import { type ScrollView, type Theme, truncateToWidth } from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"
import { keyLabel } from "./keybindings.ts"

/** Where a scrolled body is: "following" at its end, else "12–30 of 80". */
export function scrollPosition(view: ScrollView): string {
  const p = view.position
  return p.following
    ? "following"
    : `${Math.min(p.total, p.top + 1)}–${Math.min(p.total, p.top + p.height)} of ${p.total}`
}

/** A full-screen banner for a main-session dialog waiting for an answer. */
export function waitingLine(theme: Theme, title: string, width: number): string {
  return theme.warning(
    truncateToWidth(
      `${glyphs.warning} Waiting for you: ${title} · ${keyLabel({ name: "escape" })} to answer`,
      width,
      glyphs.more,
    ),
  )
}
