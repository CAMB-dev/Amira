import { expect, test } from "bun:test"
import type { AskOutcome, AskQuestion, ToolContext, ToolSession } from "@amira/api"
import { askUserPresenter, askUserTool } from "../src/ask-user.ts"

const QUESTIONS: AskQuestion[] = [
  { question: "Which approach?", header: "Approach", options: [{ label: "Fast" }, { label: "Safe" }] },
]

function ctx(outcome?: AskOutcome): ToolContext & { asked: AskQuestion[][] } {
  const asked: AskQuestion[][] = []
  const session = outcome
    ? ({
        askUser: async (q: AskQuestion[]) => {
          asked.push(q)
          return outcome
        },
      } as unknown as ToolSession)
    : undefined
  return {
    cwd: ".",
    toolCallId: "c1",
    signal: new AbortController().signal,
    update: () => {},
    asked,
    ...(session ? { session } : {}),
  }
}

const text = (r: { content: { type: string; text?: string }[] }) => r.content[0]?.text

test("the answers go back to the model under each question, and who answered", async () => {
  const c = ctx({ answers: [{ selected: ["Safe"] }], by: "the commander" })
  const r = await askUserTool.execute({ questions: QUESTIONS }, c)
  expect(c.asked).toEqual([QUESTIONS])
  expect(text(r)).toBe("The commander answered:\n1. Which approach?\n   → Safe")
  const view = { args: { questions: QUESTIONS }, result: r, text: text(r)! } as never
  expect(askUserPresenter.summary!({ questions: QUESTIONS })).toBe("Which approach?")
  expect(askUserPresenter.result!(view)).toBe("Safe by the commander")
})

test("declining, nobody to answer, and questions the schema cannot catch", async () => {
  expect(text(await askUserTool.execute({ questions: QUESTIONS }, ctx({ declined: true })))).toStartWith(
    "The user declined to answer.",
  )
  expect(
    text(await askUserTool.execute({ questions: QUESTIONS }, ctx({ unavailable: "print mode" }))),
  ).toStartWith("Nobody could answer (print mode).")
  expect(text(await askUserTool.execute({ questions: QUESTIONS }, ctx()))).toStartWith(
    "Nobody could answer (nobody can answer questions here).",
  )
  const twice = [{ question: "Q?", options: [{ label: "a" }, { label: "A" }] }]
  const r = await askUserTool.execute({ questions: twice }, ctx({ declined: true }))
  expect(r.isError).toBe(true)
  const other = [{ question: "Q?", options: [{ label: "a" }, { label: "Other…" }] }]
  expect(text(await askUserTool.execute({ questions: other }, ctx({ declined: true })))).toContain(
    'leave out the "Other" option',
  )
})
