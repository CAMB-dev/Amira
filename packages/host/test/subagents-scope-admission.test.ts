import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { scopeAdmission } from "../src/subagents/lifecycle.ts"
import { AgentTree } from "../src/subagents.ts"

function fixture() {
  const ai = createAi({
    dialects: [createMockDialect()],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
  })
  return scopeAdmission(new AgentTree({ ai, sections: () => [] }))
}

test("a scope fence closes admission without cancellation until cancel is called", () => {
  const scope = fixture()
  const signal = scope.signal
  let cancellations = 0
  signal.addEventListener("abort", () => {
    cancellations++
    expect(() => scope.check("parent")).toThrow(/stopping/)
    expect(() => scope.checkExecution()).toThrow(/stopping/)
  })

  const resume = scope.fence()
  expect(signal.aborted).toBe(false)
  expect(cancellations).toBe(0)
  expect(() => scope.check("parent")).toThrow(/stopping/)
  expect(() => scope.checkExecution()).toThrow(/stopping/)

  scope.cancel()
  expect(signal.aborted).toBe(true)
  expect(cancellations).toBe(1)
  scope.cancel()
  expect(cancellations).toBe(1)
  resume()
  scope.check("parent")
  scope.checkExecution()
  expect(scope.signal.aborted).toBe(false)
  expect(signal.aborted).toBe(true)
})

test("suspend still cancels synchronously and only the last hold resumes admission", () => {
  const scope = fixture()
  const signal = scope.signal
  const unfence = scope.fence()
  const resume = scope.suspend()
  expect(signal.aborted).toBe(true)
  resume()
  expect(scope.signal).toBe(signal)
  expect(() => scope.check("parent")).toThrow(/stopping/)
  expect(() => scope.checkExecution()).toThrow(/stopping/)
  unfence()
  expect(scope.signal.aborted).toBe(false)
  scope.check("parent")
  scope.checkExecution()
})

test("resuming a fence preserves stopped-parent spawn restrictions but permits execution", () => {
  const scope = fixture()
  scope.closeParent("parent")
  const resume = scope.fence()
  resume()
  expect(() => scope.check("parent")).toThrow(/ended or stopped/)
  scope.checkExecution()
})

test("a released scope cannot resume execution or spawning when its fence is lifted", () => {
  const scope = fixture()
  const resume = scope.fence()
  const signal = scope.signal
  scope.release()
  resume()
  expect(signal.aborted).toBe(true)
  expect(scope.signal).toBe(signal)
  expect(() => scope.check("parent")).toThrow(/released/)
  expect(() => scope.checkExecution()).toThrow(/released/)
})
