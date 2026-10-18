import { type AskAnswer, sectionOf } from "@amira/api"
import { bold, type Theme, wrapText } from "@amira/tui-kit"
import type { DialogAnswer, DialogRequest } from "./dialog.ts"
import { glyphs } from "./glyphs.ts"

/** The marker gutter used by committed answered-question rows. */
const BAR_WIDTH = 2

/** The labels of a confirm's choices, which its echo repeats. */
export const CONFIRM_LABELS = {
  yes: "Yes",
  always: "Yes, and don't ask again this session",
  no: "No",
} as const

/** The "don't ask again" choice, saying how far it reaches when the asker says so. */
export const alwaysLabel = (always: boolean | string) =>
  typeof always === "string" && always.trim()
    ? `Yes, and don't ask again ${always.trim()}`
    : CONFIRM_LABELS.always

/**
 * What stays in the transcript once a dialog is answered: a line per question under the same
 * empty marker gutter, "  Allow bash? › Yes". A secret answer is never shown.
 */
export function dialogEchoLines(
  r: DialogRequest,
  answer: DialogAnswer,
  theme: Theme,
  width = Number.POSITIVE_INFINITY,
): string[] {
  // Completed questions are transcript content, not a live typing container.
  const line = (question: string, shown: string) => {
    const text = `${bold(theme.text(question))} ${theme.muted(`${glyphs.pointer} ${shown}`)}`
    const rows = Number.isFinite(width) ? wrapText(text, Math.max(1, width - BAR_WIDTH)) : [text]
    return rows.map((l) => `  ${l}`)
  }
  if (answer === undefined) return line(r.title, "cancelled")
  if (r.kind === "ask" && Array.isArray(answer)) {
    return r.questions.flatMap((q, i) =>
      line(q.question, answer[i] ? askAnswerText(answer[i]) : "(no answer)"),
    )
  }
  if (r.kind === "select" && typeof answer === "object" && "option" in answer) {
    const key =
      answer.key &&
      sectionOf(r.sections, r.options.indexOf(answer.option))?.keys?.find((k) => k.key === answer.key)
    return line(r.title, key ? `${answer.option} ${glyphs.separator} ${key.label}` : answer.option)
  }
  if (r.kind === "input" && r.secret) return line(r.title, "(hidden)")
  if (r.kind === "input" && answer === "") return line(r.title, "(empty)")
  if (r.kind === "confirm") {
    const shown =
      answer === true
        ? CONFIRM_LABELS.yes
        : answer === false
          ? CONFIRM_LABELS.no
          : answer === "always"
            ? alwaysLabel(r.always ?? true)
            : typeof answer === "object" && "other" in answer
              ? JSON.stringify(answer.other)
              : String(answer)
    return line(r.title, shown)
  }
  return line(r.title, String(answer))
}

/** An ask answer in words: the labels chosen, then the text typed, quoted. */
function askAnswerText(a: AskAnswer): string {
  const parts = [...a.selected, ...(a.other !== undefined ? [JSON.stringify(a.other)] : [])]
  return parts.length ? parts.join(", ") : "(none)"
}
