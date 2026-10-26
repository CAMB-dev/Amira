import type { ViewKey } from "@amira/api"
import { type Theme, truncateToWidth } from "@amira/tui-kit"
import { terminalText } from "./diff-view.ts"
import { glyphs, viewEllipsis } from "./glyphs.ts"
import { type HintItem, styleHint } from "./hint.ts"
import { keyLabel as bindingLabel } from "./keybindings.ts"

export const namedViewKeys: ReadonlySet<string> = new Set(["left", "right", "tab", "shift-tab"])
const ARROWS: ReadonlySet<string> = new Set(["left", "right"])

/** A key a view may handle: one character other than q (the host's), or a named navigation key. */
export function usableViewKey(key: string): boolean {
  return namedViewKeys.has(key) || (key.length === 1 && key !== "q")
}

/** Keys sharing a label share a footer item; empty labels keep aliases out of the footer. */
export function viewKeyHints(keys: readonly ViewKey[]): HintItem[] {
  const groups = new Map<string, string[]>()
  for (const k of keys) {
    const label = terminalText(k.label).replace(/\s+/g, " ").trim()
    if (!label || !usableViewKey(k.key)) continue
    groups.set(label, [...(groups.get(label) ?? []), k.key])
  }
  return [...groups].map(([label, names]) => ({
    text: `${names.map(keyLabel).join(names.every((n) => ARROWS.has(n)) ? (glyphs.arrowLeft.length === 1 && glyphs.arrowRight.length === 1 ? "" : "/") : " ")} ${label}`,
    // A view's own letters outlast its navigation keys.
    priority: names.some((n) => n.length === 1) ? 4 : 2,
  }))
}

/** Only advertise Esc's focus handoff when the composer is empty. */
export function viewInputHint(
  theme: Theme,
  width: number,
  toggle: string,
  inputEmpty: boolean,
  dock: boolean,
): string {
  const hints = [
    toggle && `${toggle} ${glyphs.goesTo} view`,
    inputEmpty ? `esc ${glyphs.goesTo} view` : dock && "esc close dock",
  ]
  return styleHint(
    truncateToWidth(hints.filter(Boolean).join(` ${glyphs.separator} `), width, viewEllipsis()),
    theme,
  )
}

function keyLabel(key: string): string {
  return bindingLabel({ name: key === "shift-tab" ? "tab" : terminalText(key), shift: key === "shift-tab" })
}
