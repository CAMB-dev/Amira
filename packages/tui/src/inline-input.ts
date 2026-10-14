import { ACTIONS, type Action } from "./keybindings.ts"
import type { TranscriptView, ViewHost } from "./view.ts"

/** Keys of the full-screen view that do nothing inline; the first press says so. */
const FULLSCREEN_KEYS = ["find", "scroll.page-up", "scroll.page-down", "select.start"] as const
const INPUT_ACTIONS = (Object.keys(ACTIONS) as Action[]).filter((a) => ACTIONS[a].scope === "input")

/** Inline's key hints, without claiming keys that belong to the input. */
export function inlineInput(host: ViewHost): Pick<TranscriptView, "handleInput" | "detailNote"> {
  let fullscreenNoted = false
  return {
    detailNote(level) {
      const cycle = host.keys.label("tool-output")
      return `Tool output: ${level} (applies to tool results from now on${cycle ? `; ${cycle} toggles summary/full` : ""})`
    },
    handleInput(e) {
      // Find, the page keys and block selection are the full-screen view's: said once, not
      // ignored without a word.
      if (fullscreenNoted || e.type !== "key") return false
      const action = FULLSCREEN_KEYS.find((a) => host.keys.is(e, a))
      // A key the input has an action for too (bound to both) is the input's.
      if (!action || INPUT_ACTIONS.some((a) => host.keys.is(e, a))) return false
      // With text, Ctrl+↑ moves in it as ↑ does.
      if (action === "select.start" && !host.editorEmpty()) return false
      fullscreenNoted = true
      host.showNote(
        `${host.keys.label(action) ?? "That key"} is for full-screen mode (--fullscreen, or tui.mode "fullscreen"). Inline, the terminal's own scrollback and find work.`,
      )
      return true
    },
  }
}
