// Owns the shared-workspace presentation: the viewer banner and the role/viewer status items.
import type { FrontendAttachment } from "@amira/core"
import { type Theme, truncateToWidth } from "@amira/tui-kit"
import { glyphs, viewEllipsis } from "../glyphs.ts"
import type { StatusEntry } from "../status-bar.ts"

/** Shown when a viewer presses the interrupt key: the turn belongs to the controller. */
export const VIEWER_STOP_NOTICE =
  "This TUI is a read-only viewer, so it cannot stop the turn. Use /take to take control."

/** Shown when a viewer tries to send; the draft stays in the input. */
export const VIEWER_INPUT_NOTICE =
  "This TUI is a read-only viewer, so nothing was sent. Use /take to take control; your message is still in the input."

/**
 * Terminal controls (C0, DEL, C1), the soft hyphen, the Arabic letter mark, line/paragraph
 * separators, bidi and zero-width format characters.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are what is removed
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00AD\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g

/**
 * Client names are self-reported by other processes: whatever the transport did, nothing
 * that could steer the terminal reaches the screen, and no name takes over the line.
 */
export function plainLabel(text: string, max = 96): string {
  const chars = Array.from(text.replace(UNSAFE, "").replace(/\s+/g, " ").trim())
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("")
}

/** One warning row above the input while this TUI only watches; none while it controls. */
export function attachmentBanner(
  attachment: FrontendAttachment | undefined,
  theme: Theme,
  width: number,
): string[] {
  if (attachment?.role !== "viewer") return []
  const sep = ` ${glyphs.separator} `
  const controller = attachment.controller ? plainLabel(attachment.controller) : undefined
  const who = controller ? `${controller} controls this workspace` : "no client controls this workspace"
  const text = attachment.notice
    ? `${plainLabel(attachment.notice, 160)} Read-only viewer${sep}/take to take control`
    : `Read-only viewer${sep}${who}${sep}/take to take control`
  return [theme.warning(truncateToWidth(`${glyphs.warning} ${text}`, width, viewEllipsis()))]
}

/** Status items: a viewer says so in place of "Remote connected"; a controller counts its viewers. */
export function attachmentStatus(
  attachment: FrontendAttachment | undefined,
  connection: string,
): StatusEntry[] {
  const viewers = attachment?.role === "controller" ? attachment.viewers : 0
  return [
    {
      id: "connection",
      align: "left",
      tone: connection !== "connected" || attachment?.role === "viewer" ? "warning" : "muted",
      priority: 100,
      text:
        connection === "connected" && attachment?.role === "viewer"
          ? "Remote viewer"
          : `Remote ${connection}`,
    },
    // Always visible while someone watches: a viewer reads everything this TUI shows.
    ...(viewers > 0
      ? [
          {
            id: "viewers",
            align: "left",
            tone: "accent",
            priority: 100,
            text: viewers === 1 ? "1 viewer" : `${viewers} viewers`,
          } as const,
        ]
      : []),
  ]
}
