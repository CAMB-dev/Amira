import { expect, test } from "bun:test"
import { textResult, toolResultText } from "@amira/api"
import { agentPresenter } from "../src/index.ts"

const view = (text: string) => {
  const result = textResult(text)
  return { args: { tasks: [] }, result, text: toolResultText(result) }
}

test("at the full level an agent call shows every report, its headings as headings", () => {
  const call = view("## One · explorer · s_1 · done\n\nfirst\n\n## Two · coder · s_2 · done\n\nsecond")
  expect(agentPresenter.result!(call)).toBe("2 reports")
  const body = agentPresenter.body!(call, { detail: "full", width: 80 })
  expect(body[0]).toEqual({ kind: "accent", text: "One · explorer · s_1 · done" })
  expect(body.filter((l) => l.kind === "accent").map((l) => l.text)).toEqual([
    "One · explorer · s_1 · done",
    "Two · coder · s_2 · done",
  ])
  expect(body.some((l) => l.text.startsWith("##"))).toBe(false)
  expect(agentPresenter.body!(call, { detail: "summary", width: 80 })).toEqual([])
})
