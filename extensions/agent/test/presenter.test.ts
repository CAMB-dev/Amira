import { expect, test } from "bun:test"
import { textResult, toolResultText } from "@amira/api"
import { agentPresenter } from "../src/index.ts"

const view = (text: string) => {
  const result = textResult(text)
  return { args: { tasks: [] }, result, text: toolResultText(result) }
}

test("several reports sum up by how each ended; a failure among them is no success", () => {
  const mixed = view(
    "## A · explorer · s_1 · done (2s, 1k tokens)\n\na\n\n## B · coder · s_2 · error (1s, 2k tokens)\n\nb\n\n## C · coder · s_3 · aborted (1s, 2k tokens)\n\nc\n\n## D · coder · s_4 · done (1s, 2k tokens)\n\nd",
  )
  expect(agentPresenter.result!(mixed)).toBe("2 done · 1 failed · 1 stopped")
  expect(agentPresenter.outcome!(mixed)).toBe("failed")
  // Headings without a state keep the plain count.
  expect(agentPresenter.result!(view("## One\n\na\n\n## Two\n\nb"))).toBe("2 reports")
})

test("at the full level an agent call shows every report, its headings as headings", () => {
  const call = view("## One · explorer · s_1 · done\n\nfirst\n\n## Two · coder · s_2 · done\n\nsecond")
  expect(agentPresenter.result!(call)).toBe("2 done")
  expect(agentPresenter.outcome!(call)).toBeUndefined()
  const body = agentPresenter.body!(call, { detail: "full", width: 80 })
  expect(body[0]).toEqual({ kind: "accent", text: "One · explorer · s_1 · done" })
  expect(body.filter((l) => l.kind === "accent").map((l) => l.text)).toEqual([
    "One · explorer · s_1 · done",
    "Two · coder · s_2 · done",
  ])
  expect(body.some((l) => l.text.startsWith("##"))).toBe(false)
  expect(agentPresenter.body!(call, { detail: "summary", width: 80 })).toEqual([])
})
