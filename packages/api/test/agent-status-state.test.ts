import { expect, test } from "bun:test"
import { agentStatusState, subagentStateText } from "../src/index.ts"

const cases = [
  [{ status: "done", note: "turn limit reached" }, "stopped"],
  [{ status: "done", note: "stopped gracefully" }, "stopped"],
  [{ status: "done", note: "" }, "stopped"],
  [{ status: "done", note: undefined }, "done"],
  [{ status: "error", note: "ended early" }, "failed"],
  [{ status: "aborted" }, "stopped"],
  [{ status: "running", paused: true }, "paused"],
  [{ status: "working", paused: true }, "paused"],
  [{ status: "working", paused: false }, "working"],
  [{ status: "queued" }, "queued"],
  [{ status: "idle", paused: true }, "idle"],
  [{ startedAt: 1 }, "working"],
  [{ startedAt: 1, paused: true }, "paused"],
  [{ startedAt: 1, queued: true }, "queued"],
  [{ startedAt: 1, idle: true }, "idle"],
  [{ end: { status: "done", note: "" }, paused: true }, "stopped"],
  [{ end: { status: "error" }, paused: true }, "failed"],
  [{ end: { status: "done" } }, "done"],
] as const

for (const [source, expected] of cases) {
  test(`display state ${JSON.stringify(source)} is ${expected}`, () => {
    expect(agentStatusState(source)).toBe(expected)
    expect(subagentStateText(source)).toBe(expected)
  })
}

test("legacy status strings retain their display vocabulary", () => {
  for (const [source, expected] of [
    ["queued", "queued"],
    ["running", "working"],
    ["working", "working"],
    ["idle", "idle"],
    ["paused", "paused"],
    ["done", "done"],
    ["error", "failed"],
    ["failed", "failed"],
    ["aborted", "stopped"],
    ["stopped", "stopped"],
  ] as const)
    expect(agentStatusState(source)).toBe(expected)
})
