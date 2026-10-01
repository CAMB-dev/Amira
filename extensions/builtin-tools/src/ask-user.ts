import {
  type AskAnswer,
  type AskOutcome,
  type AskQuestion,
  defineTool,
  type ToolCallView,
  type ToolLine,
  type ToolPresenter,
  textResult,
} from "@amira/api"

export const ASK_USER_TOOL = "ask_user"

export interface AskUserParams {
  questions: AskQuestion[]
}

/** What an ask_user call keeps for its presenter: the questions and how they were answered. */
export interface AskUserDetails {
  questions: AskQuestion[]
  outcome: AskOutcome
}

export const askUserTool = defineTool<AskUserParams>({
  name: ASK_USER_TOOL,
  description: [
    "Ask the user one to four multiple-choice questions and wait for the answers.",
    "- Use it only for genuine decisions that are the user's to make: a preference, a trade-off, which of several reasonable approaches to take, or a requirement that is really unclear. Never ask what you can find out yourself by reading files, running commands or searching.",
    '- Each question has 2 to 4 options that are mutually exclusive (unless multiSelect), with a short label and a description of what choosing it means. Put the option you recommend first and end its label with "(Recommended)".',
    '- The user can always answer in their own words instead ("Other"); do not add such an option yourself.',
    '- `header` is a very short name for the question (at most 12 characters), such as "Approach" or "Database".',
    "- Set multiSelect when several options may be chosen together.",
    "- Ask all related questions in one call rather than one after another. The result lists each question with the chosen label(s) or the user's own words; the user may also decline to answer.",
    "- In a sub-agent the questions go to the agent that started you, which answers them or passes them on to the user.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        description: "The questions, asked one after another and answered together",
        items: {
          type: "object",
          properties: {
            question: {
              type: "string",
              minLength: 1,
              description: "The full question, ending with a question mark",
            },
            header: {
              type: "string",
              maxLength: 12,
              description: "A short name for it, at most 12 characters",
            },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              description: "2 to 4 mutually exclusive choices; the recommended one first",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", minLength: 1, description: "A few words the user picks" },
                  description: { type: "string", description: "What choosing it means" },
                },
                required: ["label", "description"],
                additionalProperties: false,
              },
            },
            multiSelect: { type: "boolean", description: "Several options may be chosen together" },
          },
          required: ["question", "header", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
  traits: { readOnly: true, interactive: true },
  async execute({ questions }, ctx) {
    const problem = checkQuestions(questions)
    if (problem) return textResult(problem, true)
    const ask = ctx.session?.askUser
    const outcome: AskOutcome = ask
      ? await ask(questions, ctx.signal)
      : { unavailable: "nobody can answer questions here" }
    const details: AskUserDetails = { questions, outcome }
    if (ctx.signal.aborted) return { ...textResult("Aborted by the user.", true), details }
    return { ...textResult(describeOutcome(questions, outcome)), details }
  },
})

/** What the schema cannot say: labels are unique within a question and none is "Other". */
function checkQuestions(questions: AskQuestion[]): string | undefined {
  for (const [i, q] of questions.entries()) {
    const labels = q.options.map((o) => o.label.trim().toLowerCase())
    if (new Set(labels).size !== labels.length)
      return `Question ${i + 1} has two options with the same label.`
    if (labels.some((l) => /^other\b/.test(l)))
      return `Question ${i + 1}: leave out the "Other" option; the user can always answer in their own words.`
  }
  return undefined
}

/** One answer in words: the labels chosen and the user's own text. */
export function answerText(answer: AskAnswer): string {
  const parts = [...answer.selected]
  if (answer.other !== undefined) parts.push(`(own words) ${JSON.stringify(answer.other)}`)
  return parts.length ? parts.join(", ") : "(nothing chosen)"
}

/** The result the model reads. */
function describeOutcome(questions: AskQuestion[], outcome: AskOutcome): string {
  if ("unavailable" in outcome) {
    return `Nobody could answer (${outcome.unavailable}). Decide yourself where you reasonably can, and say what you assumed.`
  }
  const who = outcome.by ?? "the user"
  if ("declined" in outcome) {
    return `${capitalize(who)} declined to answer. Do not ask again; go on with what you know, or stop and explain what you need.`
  }
  const lines = questions.map((q, i) => {
    const a = outcome.answers[i]
    return `${i + 1}. ${q.question}\n   → ${a ? answerText(a) : "(no answer)"}`
  })
  return [`${capitalize(who)} answered:`, ...lines].join("\n")
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function detailsOf(call: ToolCallView<AskUserParams, unknown>): AskUserDetails | undefined {
  const d = call.result.details
  return d && typeof d === "object" && "outcome" in d ? (d as AskUserDetails) : undefined
}

const questionsOf = (args: Partial<AskUserParams>): AskQuestion[] =>
  Array.isArray(args.questions) ? args.questions.filter((q) => q && typeof q.question === "string") : []

/** Longest a question's label (its header, else the question) may be above its answer. */
const LABEL_CHARS = 40

/** `s` cut to `max` characters, whole code points, with an ellipsis when cut. */
function clipLabel(s: string, max: number): string {
  const chars = [...s.replace(/\s+/g, " ").trim()]
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("")
}

/**
 * The call shows its first question; the result, each question's label (its header, cut short)
 * with the answer under it, whole: a long label is cut, never the answer.
 */
export const askUserPresenter: ToolPresenter<AskUserParams, AskUserDetails> = {
  summary(args) {
    const qs = questionsOf(args)
    const first = qs[0]?.question ?? ""
    return qs.length > 1 ? `${first} (+${qs.length - 1} more)` : first
  },
  result(call) {
    if (call.result.isError) return undefined
    const d = detailsOf(call)
    if (!d) return undefined
    const o = d.outcome
    if ("unavailable" in o) return `nobody could answer (${o.unavailable})`
    const by = o.by ? ` by ${o.by}` : ""
    if ("declined" in o) return `declined${by}`
    if (o.answers.length === 1) return `${answerText(o.answers[0]!)}${by}`
    return `${o.answers.length} answers${by}`
  },
  body(call) {
    const d = detailsOf(call)
    if (!d || !("answers" in d.outcome) || d.outcome.answers.length < 2) return []
    const answers = d.outcome.answers
    return d.questions.flatMap((q, i): ToolLine[] => {
      const answer = answers[i] ? answerText(answers[i]) : "(no answer)"
      return [
        { kind: "muted", text: clipLabel(q.header || q.question, LABEL_CHARS) },
        ...answer.split("\n").map((l): ToolLine => ({ kind: "text", text: `  ${l}` })),
      ]
    })
  },
}
