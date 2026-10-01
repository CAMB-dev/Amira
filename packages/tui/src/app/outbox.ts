import type { UserMessage } from "@amira/api"
import { type EditorPart, type Theme, truncateToWidth, visibleWidth, wrapText } from "@amira/tui-kit"
import { userLines, userText } from "../format.ts"
import { glyphs } from "../glyphs.ts"

/** A message on its way: the text the model gets, and what the transcript shows when that differs. */
export interface Outgoing {
  text: string
  /** The text with folded pastes as their placeholders. */
  display?: string
  /** When it was typed, among the messages of this run: steering and queued ones merge in this order. */
  seq?: number
  content?: UserMessage["content"]
  parts?: EditorPart[]
}

export function outgoing(text: string, display: string | undefined): Outgoing {
  const shown = display?.trim()
  return shown && shown !== text ? { text, display: shown } : { text }
}

/** What to hand the agent: the text, or a message that shows its placeholders (MessageDisplay). */
export function toPrompt(o: Outgoing): string | UserMessage {
  if (o.content) return { role: "user", content: o.content, display: { text: o.display ?? o.text } }
  if (!o.display) return o.text
  return { role: "user", content: [{ type: "text", text: o.text }], display: { text: o.display } }
}

export function messageParts(m: UserMessage): EditorPart[] {
  return m.content.map((b) =>
    b.type === "text"
      ? b.text
      : {
          image: {
            name: b.name ?? `image.${b.mimeType.split("/")[1] ?? "png"}`,
            mimeType: b.mimeType,
            data: b.data,
          },
        },
  )
}

export function draftMessage(text: string, display: string | undefined, parts: EditorPart[]): Outgoing {
  if (!parts.some((p) => typeof p !== "string" && "image" in p)) return outgoing(text, display)
  const content = parts.flatMap<UserMessage["content"][number]>((p) =>
    typeof p === "string"
      ? [{ type: "text" as const, text: p }]
      : "paste" in p
        ? [{ type: "text" as const, text: p.paste }]
        : [{ type: "image" as const, ...p.image }],
  )
  return { text: userText({ role: "user", content }), display, content, parts }
}

/** What a message sent while a turn runs does: joins that turn, or waits for the next. */
export type WhileWorking = "steer" | "queue"

export const otherWay = (w: WhileWorking): WhileWorking => (w === "steer" ? "queue" : "steer")

/** Messages waiting above the input box (steering, queued) shown at most; the rest are counted. */
const PENDING_SHOWN = 3
/** Rows each of them takes at most. */
const PENDING_ROWS = 2

/**
 * The rows of messages waiting above the input box: "steering › …" and "queued › …", each on
 * at most two rows (the second under the text, cut with "…"), at most three of them, then how
 * many more wait. They stay a few rows, however long the messages, so the input box keeps its
 * place on the screen.
 */
export function pendingMessageRows(
  items: readonly { label: string; text: string }[],
  width: number,
  theme: Theme,
): string[] {
  const out: string[] = []
  for (const { label, text } of items.slice(0, PENDING_SHOWN)) {
    const head = `${label} ${glyphs.user} `
    const indent = visibleWidth(head)
    const flat = text.replace(/\s+/g, " ").trim()
    const rows = wrapText(flat, Math.max(8, width - indent))
    const shown = rows.slice(0, PENDING_ROWS)
    if (rows.length > PENDING_ROWS) {
      const last = shown.length - 1
      shown[last] = truncateToWidth(
        `${shown[last]} ${rows.slice(PENDING_ROWS).join(" ")}`,
        Math.max(8, width - indent),
        glyphs.more,
      )
    }
    shown.forEach((r, i) => {
      out.push(truncateToWidth(theme.muted(`${i === 0 ? head : " ".repeat(indent)}${r}`), width, glyphs.more))
    })
  }
  const more = items.length - PENDING_SHOWN
  if (more > 0) out.push(theme.muted(`+${more} more waiting`))
  return out
}

/**
 * How a user message reads while queued, or back in the editor once dropped: its display text,
 * if any. That is what the user typed (e.g. "/review-pr 123"), so sending it again re-runs it.
 */
export function messageText(m: UserMessage): string {
  return m.display?.text.trim() || userText(m)
}

/** A message on one line, cut for a list of them. */
export const oneLine = (s: string, max = 100) => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${[...flat].slice(0, max - 1).join("")}…` : flat
}

export type NoticeSteerState = "queued" | "injected" | "dropped" | "promoted"

export interface NoticeStrip {
  /** Clears notices carried by a new turn and cancels any retry timer. */
  turnStarted(prompt: UserMessage): void
  /** Handles an origin message; returns false for ordinary steering. */
  steer(message: UserMessage, state: NoticeSteerState): boolean
  /** Sets or clears the time at which held notices will be resent. */
  setRetry(at: number | undefined): void
  /** Clears notices and any retry timer when the active session changes. */
  reset(): void
  /** Pending notice lines, with the time to the next resend when one is due. */
  render(theme: Theme): string[]
  /** Releases the retry timer when the controller quits. */
  dispose(): void
}

export function createNoticeStrip(options: { theme: Theme; requestRender: () => void }): NoticeStrip {
  /** Lines of notices (background results) waiting to reach the model. */
  const pendingNotices: string[] = []
  /** When held notices are sent again after a failed turn (notice.retry); redrawn each second. */
  let noticeRetryAt: number | undefined
  let retryTimer: ReturnType<typeof setInterval> | undefined

  const setRetry = (at: number | undefined) => {
    noticeRetryAt = at
    if (at !== undefined && !retryTimer) retryTimer = setInterval(options.requestRender, 1000)
    else if (at === undefined && retryTimer) {
      clearInterval(retryTimer)
      retryTimer = undefined
    }
  }

  return {
    turnStarted(prompt) {
      // A turn woken by notices carries every one that was waiting.
      if (prompt.display?.origin) pendingNotices.length = 0
      // A turn takes held notices along, so no resend is due any more.
      setRetry(undefined)
    },
    steer(message, state) {
      if (!message.display?.origin) return false
      if (state === "queued") pendingNotices.push(...userLines(options.theme, message))
      else pendingNotices.length = 0
      return true
    },
    setRetry,
    reset() {
      pendingNotices.length = 0
      setRetry(undefined)
    },
    render(theme) {
      const retry =
        noticeRetryAt === undefined
          ? ""
          : ` · retry in ${Math.max(0, Math.ceil((noticeRetryAt - Date.now()) / 1000))}s`
      const lines = pendingNotices.length
        ? pendingNotices
        : noticeRetryAt !== undefined
          ? [`${theme.accent("◆")}${theme.muted(" sub-agents' results")}`]
          : []
      return lines.map((line) => `${line}${theme.muted(` · pending${retry}`)}`)
    },
    dispose() {
      setRetry(undefined)
    },
  }
}
