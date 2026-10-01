import type { AskAnswer, AskQuestion, AskRequest } from "@amira/api"

/** A child's questions as its commander reads them, with how to answer. */
export function askParentPrompt(req: AskRequest): string {
  const questions = req.questions.map((q, i) => {
    const how = q.multiSelect ? "choose any number" : "choose one"
    const options = q.options.map((o) => `   - ${o.label}${o.description ? `: ${o.description}` : ""}`)
    return [`${i + 1}. ${q.header ? `[${q.header}] ` : ""}${q.question} (${how})`, ...options].join("\n")
  })
  return [
    `A sub-agent working for you (session ${req.sessionId}) asks you ${req.questions.length === 1 ? "this question" : "these questions"} before it goes on:`,
    questions.join("\n\n"),
    [
      'Answer with one line per question, numbered like the questions: "1: <option label>". Where several may be chosen, separate the labels with " | ". When no option fits, write your own answer instead of a label.',
      "If the user should decide instead, reply with ASK_USER alone on the first line, and the questions go to the user. To refuse to answer, reply with DECLINE on the first line.",
    ].join(" "),
  ].join("\n\n")
}

/** Case, spacing, quotes and a "(Recommended)" mark do not matter when matching a label. */
const labelKey = (s: string) =>
  s
    .replace(/\(recommended\)/i, "")
    .replace(/^[\s"'`*_]+|[\s"'`*_.]+$/g, "")
    .toLowerCase()

/**
 * The commander's numbered answers ("1: label", "2: a | b", or its own words) as one answer
 * per question; undefined when a question has none. A single question may be answered by the
 * whole reply.
 */
export function parseParentAnswers(questions: AskQuestion[], text: string): AskAnswer[] | undefined {
  const byNumber = new Map<number, string>()
  for (const line of text.split("\n")) {
    const m = /^\s*(?:\*\*)?(\d+)(?:\*\*)?\s*[:.)-]\s*(.+)$/.exec(line)
    if (m && !byNumber.has(Number(m[1]))) byNumber.set(Number(m[1]), m[2]!.trim())
  }
  if (questions.length === 1 && !byNumber.has(1) && text.trim()) byNumber.set(1, text.trim())
  const answers: AskAnswer[] = []
  for (const [i, q] of questions.entries()) {
    const reply = byNumber.get(i + 1)
    if (!reply) return undefined
    const labels = new Map(q.options.map((o) => [labelKey(o.label), o.label]))
    const whole = labels.get(labelKey(reply))
    if (whole) {
      answers.push({ selected: [whole] })
      continue
    }
    const parts = q.multiSelect ? reply.split("|").map((p) => p.trim()) : [reply]
    const selected = parts.map((p) => labels.get(labelKey(p))).filter((l): l is string => l !== undefined)
    const rest = parts.filter((p) => !labels.has(labelKey(p)))
    answers.push({ selected: [...new Set(selected)], ...(rest.length ? { other: rest.join(" | ") } : {}) })
  }
  return answers
}
