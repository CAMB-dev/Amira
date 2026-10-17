import type { InputEvent } from "@amira/tui-kit"
import { keyLabel } from "./keybindings.ts"

/** Native terminal gestures, independent of Amira's keyboard bindings. */
export const mouseLabels = {
  drag: "shift+drag",
  right: "shift+right-click",
  middle: "shift+middle-click",
} as const

/** Mouse reporting captures native paste clicks; explain the terminal's bypass gesture. */
export function mousePasteHint(event: InputEvent): string | undefined {
  if (
    event.type !== "mouse" ||
    event.action !== "press" ||
    (event.button !== "right" && event.button !== "middle")
  )
    return
  return `Clicks go to Amira here: ${mouseLabels[event.button]} (or ${keyLabel({ name: "v", ctrl: true })}) pastes, ${mouseLabels.drag} selects natively.`
}
