import { agentStatusState, type MessageDisplay } from "@amira/api"
import { type Theme, truncateToWidth, visibleWidth, wrapText } from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"
import { CONTENT_INSET, contentRoom } from "./grid.ts"
import { styledStatusBadge } from "./status-badge.ts"

type NoticeRow = NonNullable<MessageDisplay["notices"]>[number]

/** Old sessions stored glyph-only completions; recover their semantic state once at the boundary. */
function storedNotice(line: string): NoticeRow {
  const prefix = /^\s*◆ /.exec(line)
  if (!prefix) return { text: line.trim() }
  // The outcome precedes the role and elapsed-time metadata, not a glyph inside the title.
  const endings = [...line.matchAll(/ ([✓✗⊘]) ([^·✓✗⊘]+) · (?=\d+(?:[smh.]|\b))/g)]
  if (endings.length !== 1) return { text: line.trim() }
  const notice = endings[0]!
  const resultStatus = notice[1] === "✓" ? "done" : notice[1] === "✗" ? "error" : "aborted"
  const metadata = line.slice(notice.index + 3)
  // In the legacy format, a successful result's field after the token count is its early-end note.
  const note = resultStatus === "done" ? / · \d+(?:\.\d+)?[kM]? tok · (.*)$/.exec(metadata)?.[1] : undefined
  const status = agentStatusState({ status: resultStatus, note })
  return { text: `${line.slice(prefix[0].length, notice.index)} · ${metadata}`, status }
}

/** Background completions are standalone root badges, not branches of a removed live tool tree. */
export function messageNoticeLines(
  theme: Theme,
  display: MessageDisplay,
  width = Number.POSITIVE_INFINITY,
): string[] {
  const notices = display.notices ?? display.text.trim().split("\n").map(storedNotice)
  return notices.flatMap((notice) => {
    const badge = notice.status ? styledStatusBadge(agentStatusState(notice.status), theme) : undefined
    const text = notice.text.trim().replaceAll(" · ", ` ${glyphs.separator} `)
    const rows = Number.isFinite(width)
      ? wrapText(
          text,
          contentRoom(width),
          Math.max(1, width - (badge ? visibleWidth(badge) + 1 : CONTENT_INSET.length)),
        )
      : text.split("\n")
    return rows.map((row, i) => {
      const line = `${i === 0 && badge ? `${badge} ` : CONTENT_INSET}${theme.muted(row)}`
      return Number.isFinite(width) ? truncateToWidth(line, Math.max(0, width), glyphs.more) : line
    })
  })
}
