import { userMessage } from "@amira/ai"
import type { ToolLine, ViewLine, ViewSegment } from "@amira/api"
import { type Theme, truncateToWidth } from "@amira/tui-kit"
import { renderToolLines, terminalText } from "./diff-view.ts"
import { userLines } from "./format.ts"
import { glyphs } from "./glyphs.ts"

/** Semantic parts share one row; sanitizing each part keeps styling host-owned. */
export function segmentText(parts: ViewSegment[], theme: Theme): string {
  return parts.map((part) => theme[part.kind](terminalText(part.text))).join("")
}

/** View lines shared by full-screen views, panels and Markdown renderers. */
export function renderViewLines(lines: ViewLine[], theme: Theme, width: number): string[] {
  const out: string[] = []
  let plain: ToolLine[] = []
  const flush = () => {
    out.push(...renderToolLines(plain, theme, width))
    plain = []
  }
  for (const line of lines) {
    if (line.kind === "segments") {
      flush()
      out.push(truncateToWidth(segmentText(line.parts, theme), width, glyphs.more))
    } else if (line.kind === "user-message") {
      flush()
      const message = userMessage(line.text.split("\n").map(terminalText).join("\n"))
      if (line.note) message.display = { text: "", note: terminalText(line.note) }
      out.push(...userLines(theme, message, width))
    } else plain.push(line)
  }
  flush()
  return out
}

/** A semantic title is one row, even when its body equivalent would wrap or have a band. */
export function viewTitle(line: ViewLine, theme: Theme, width: number): string {
  if (line.kind === "segments") return truncateToWidth(segmentText(line.parts, theme), width, glyphs.more)
  if (line.kind === "user-message")
    return truncateToWidth(
      userLines(theme, userMessage(terminalText(line.text)))[0] ?? "",
      width,
      glyphs.more,
    )
  if (["text", "muted", "accent", "success", "warning", "error"].includes(line.kind))
    return theme[line.kind]!(truncateToWidth(terminalText(line.text), width, glyphs.more))
  return renderToolLines([line], theme, width)[0] ?? ""
}
