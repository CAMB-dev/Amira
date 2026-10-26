import { expect, test } from "bun:test"
import type { AskOutcome, AskQuestion, ToolCallView, ToolContext, ToolSession } from "@amira/api"
import { type AskUserDetails, type AskUserParams, askUserPresenter, askUserTool } from "../src/ask-user.ts"

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
  expect(r.persistDetails).toBe(true)
  expect(askUserPresenter.body!(view, { detail: "summary", width: 90 })).toEqual([])
  expect(askUserPresenter.body!(view, { detail: "full", width: 90 })).toEqual([
    { kind: "muted", text: "Approach", wrap: true },
    { kind: "text", text: "Which approach?", wrap: true },
    { kind: "muted", text: "Fast", marker: "unchecked", description: undefined, wrap: true },
    { kind: "text", text: "Safe", marker: "success", description: undefined, wrap: true },
  ])
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

test("summary retains per-question answers; full retains all choices, multiple marks and own words", async () => {
  const questions: AskQuestion[] = [
    ...QUESTIONS,
    {
      header: "Extras",
      question: "What else?",
      options: [{ label: "Tests", description: "Add coverage" }, { label: "Docs" }, { label: "Release" }],
      multiSelect: true,
    },
  ]
  const r = await askUserTool.execute(
    { questions },
    ctx({ answers: [{ selected: ["Safe"] }, { selected: ["Tests", "Docs"], other: "Keep it small" }] }),
  )
  const view: ToolCallView<AskUserParams, AskUserDetails> = {
    args: { questions },
    result: { ...r, details: r.details as AskUserDetails },
    text: text(r)!,
  }
  expect(askUserPresenter.body!(view, { detail: "summary", width: 90 })).toEqual([
    { kind: "muted", text: "Approach" },
    { kind: "text", text: "  Safe" },
    { kind: "muted", text: "Extras" },
    { kind: "text", text: '  Tests, Docs, (own words) "Keep it small"' },
  ])
  const full = askUserPresenter.body!(view, { detail: "full", width: 90 })
  expect(full.filter((line) => line.marker === "success").map((line) => line.text)).toEqual([
    "Safe",
    "Tests",
    "Docs",
    '(own words) "Keep it small"',
  ])
  expect(full.find((line) => line.text === "Tests")?.description).toBe("Add coverage")
  expect(full.find((line) => line.text === "Release")?.marker).toBe("unchecked")
})

test("declined and unavailable details still expose offered questions at full detail", async () => {
  for (const outcome of [{ declined: true }, { unavailable: "print mode" }] as const) {
    const r = await askUserTool.execute({ questions: QUESTIONS }, ctx(outcome))
    const view = { args: { questions: QUESTIONS }, result: r, text: text(r)! } as ToolCallView<
      AskUserParams,
      AskUserDetails
    >
    expect(askUserPresenter.body!(view, { detail: "summary", width: 90 })).toEqual([])
    const body = askUserPresenter.body!(view, { detail: "full", width: 90 })
    expect(body.filter((line) => line.marker).map((line) => line.marker)).toEqual(["unchecked", "unchecked"])
    expect(askUserPresenter.result!(view)).toContain(
      "declined" in outcome ? "declined" : "nobody could answer",
    )
    // No answer came: the row's mark is not a success check.
    expect(askUserPresenter.outcome!(view)).toBe("interrupted")
  }
  const legacy: ToolCallView<AskUserParams, AskUserDetails> = {
    args: { questions: QUESTIONS },
    result: { content: [] },
    text: "The user answered:\n1. Which approach?\n   → Safe",
  }
  expect(askUserPresenter.body!(legacy, { detail: "full", width: 90 })).toEqual([
    { kind: "text", text: "1. Which approach?", wrap: true },
    { kind: "text", text: "   → Safe", wrap: true },
  ])
})

test("text-only history never invents selections from separators inside labels", () => {
  const questions: AskQuestion[] = [
    { question: "Q1?", options: [{ label: "A" }, { label: "A\n2. Q2?\n   → B" }] },
    { question: "Q2?", options: [{ label: "C" }, { label: "B\n2. Q2?\n   → C" }] },
  ]
  const saved = "The user answered:\n1. Q1?\n   → A\n2. Q2?\n   → B\n2. Q2?\n   → C"
  const view: ToolCallView<AskUserParams, AskUserDetails> = {
    args: { questions },
    result: { content: [{ type: "text", text: saved }] },
    text: saved,
  }
  expect(askUserPresenter.result!(view)).toBeUndefined()
  expect(askUserPresenter.body!(view, { detail: "summary", width: 90 })).toEqual([])
  expect(askUserPresenter.body!(view, { detail: "full", width: 90 })).toEqual(
    saved
      .split("\n")
      .slice(1)
      .map((text) => ({ kind: "text", text, wrap: true })),
  )
})

test("text-only multi-select history retains labels and own words without recovery", () => {
  const questions: AskQuestion[] = [
    {
      question: "Which?",
      multiSelect: true,
      options: [{ label: "a, b" }, { label: "a" }, { label: "b" }],
    },
  ]
  const view: ToolCallView<AskUserParams, AskUserDetails> = {
    args: { questions },
    result: { content: [] },
    text: 'The user answered:\n1. Which?\n   → b, a, (own words) "Keep it small"',
  }
  expect(askUserPresenter.body!(view, { detail: "full", width: 90 })).toEqual([
    { kind: "text", text: "1. Which?", wrap: true },
    { kind: "text", text: '   → b, a, (own words) "Keep it small"', wrap: true },
  ])
  view.text = "The user answered:\n1. Which?\n   → a, b"
  expect(askUserPresenter.body!(view, { detail: "full", width: 90 })).toEqual([
    { kind: "text", text: "1. Which?", wrap: true },
    { kind: "text", text: "   → a, b", wrap: true },
  ])
})
