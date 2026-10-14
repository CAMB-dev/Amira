import { truncateToWidth, visibleWidth } from "../width.ts"

/** Wrap a form's key hint between actions, keeping each key and its label together. */
export function wrapFormHint(hint: string, width: number, separator: string): string[] {
  const lines: string[] = []
  let line = ""
  for (const part of hint.split(separator)) {
    const next = line ? line + separator + part : part
    if (line && visibleWidth(next) > width) {
      lines.push(truncateToWidth(line, width, "…"))
      line = part
    } else line = next
  }
  lines.push(truncateToWidth(line, width, "…"))
  return lines
}
