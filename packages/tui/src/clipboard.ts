import type { Message } from "@amira/api"
import { isSummaryMessage } from "@amira/core"
import { osc, type Terminal } from "@amira/tui-kit"
import { compactTokens } from "./format.ts"
import { keyLabel } from "./keybindings.ts"

/**
 * Puts `text` on the clipboard (OSC 52) and says so in a note, naming `what` it was, with
 * `fallback` (how to select it otherwise, should the terminal not take OSC 52); says there
 * is nothing to copy instead when it is blank.
 */
export function copyToClipboard(
  terminal: Terminal,
  text: string,
  what: string,
  showNote: (text: string) => void,
  fallback = `${keyLabel({ name: "drag", shift: true })} selects text.`,
): void {
  if (!text.trim()) {
    showNote(`Nothing to copy in ${what}.`)
    return
  }
  terminal.write(osc.clipboard(text))
  showNote(
    `Copied ${what} (${compactTokens(text.length)} characters) to the clipboard. Not there? ${fallback}`,
  )
}

/** The text of the session's last reply with any, as the model wrote it (Markdown). */
export function lastReplyText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    // A compaction's acknowledgement is no reply of the model's.
    if (m.role !== "assistant" || isSummaryMessage(m)) continue
    const text = m.content
      .flatMap((b) => (b.type === "text" && b.text.trim() ? [b.text.trim()] : []))
      .join("\n\n")
    if (text) return text
  }
  return ""
}
