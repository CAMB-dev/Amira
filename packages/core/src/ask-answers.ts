import type { AskAnswer, AskQuestion } from "@amira/api"

/** Shared validation for host UI answers and owner-directed conversation callbacks. */
export function checkAskAnswers(questions: AskQuestion[], value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== questions.length)
    return `value must be an array of ${questions.length} answer(s), one per question`
  for (const [i, q] of questions.entries()) {
    const a = value[i] as Partial<AskAnswer> | null
    const at = `answer ${i + 1}`
    if (typeof a !== "object" || a === null || !Array.isArray(a.selected))
      return `${at} must be an object with "selected", an array of option labels`
    if (a.other !== undefined && (typeof a.other !== "string" || !a.other.trim()))
      return `${at}: "other" must be text`
    const labels = new Set(q.options.map((o) => o.label))
    const bad = a.selected.findIndex((label) => typeof label !== "string" || !labels.has(label))
    if (bad !== -1) return `${at}: ${JSON.stringify(a.selected[bad])} is not one of the options`
    if (new Set(a.selected).size !== a.selected.length) return `${at} names an option twice`
    const count = a.selected.length + (a.other !== undefined ? 1 : 0)
    if (!q.multiSelect && count !== 1) return `${at} must choose one option or give "other" text`
  }
  return undefined
}
