import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"

function makeAgent(steps: MockStep[], interceptors = new InterceptorRegistry()) {
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: process.cwd(),
    interceptors,
    sections: [],
  })
  return { agent, mock, interceptors }
}

test("turn.beforeEnd blocks premature stop, injects continuation, and passes once satisfied", async () => {
  const { agent, interceptors } = makeAgent([{ text: "first draft" }, { text: "verified final answer" }])
  const seen: { stopHookActive: boolean; stopBlockCount: number; steps: number; text: string }[] = []
  const steers: string[] = []
  agent.bus.subscribe((event) => {
    if (event.type === "turn.steer" && event.data.state === "injected") {
      const text = event.data.message.content.find((b) => b.type === "text")?.text ?? ""
      steers.push(text)
    }
  })

  interceptors.add("turn.beforeEnd", (v) => {
    const text = v.lastMessage.content.find((b) => b.type === "text")?.text ?? ""
    seen.push({
      stopHookActive: v.stopHookActive,
      stopBlockCount: v.stopBlockCount,
      steps: v.steps,
      text,
    })
    if (v.stopBlockCount === 0) {
      v.displayText = "Goal check failed: run tests"
      return { action: "block", reason: "Tests are still failing. Fix them before stopping." }
    }
    return { action: "pass" }
  })

  const result = await agent.prompt("finish the task")
  expect(result).toEqual({ reason: "done", steps: 2 })
  expect(seen).toEqual([
    { stopHookActive: false, stopBlockCount: 0, steps: 1, text: "first draft" },
    { stopHookActive: true, stopBlockCount: 1, steps: 2, text: "verified final answer" },
  ])
  expect(steers).toEqual(["Tests are still failing. Fix them before stopping."])
  await agent.dispose()
})

test("turn.beforeEnd enforces host max consecutive block cap against infinite loops", async () => {
  const steps: MockStep[] = Array.from({ length: 40 }, (_, i) => ({ text: `attempt ${i + 1}` }))
  const { agent, interceptors } = makeAgent(steps)
  let calls = 0
  interceptors.add("turn.beforeEnd", () => {
    calls++
    return { action: "block", reason: "keep going forever" }
  })

  const result = await agent.prompt("loop test")
  expect(result.reason).toBe("done")
  expect(calls).toBe(32)
  expect(result.steps).toBe(33)
  await agent.dispose()
})

test("turn.beforeEnd is aborted immediately when user interrupts with abort()", async () => {
  const { agent, interceptors } = makeAgent([{ text: "done?" }])
  let hookAborted = false
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })

  interceptors.add(
    "turn.beforeEnd",
    (_v, ctx) => {
      started()
      return new Promise((_, reject) => {
        ctx.signal.addEventListener(
          "abort",
          () => {
            hookAborted = true
            reject(new Error("aborted"))
          },
          { once: true },
        )
      })
    },
    { timeoutMs: 30_000 },
  )

  const pending = agent.prompt("work")
  const endCauses: (string | undefined)[] = []
  agent.bus.subscribe((e) => {
    if (e.type === "turn.end") endCauses.push(e.data.abortCause)
  })
  await running
  expect(agent.busy).toBe(true)
  agent.abort()
  const result = await pending
  await agent.bus.flush()
  expect(result.reason).toBe("aborted")
  expect(endCauses).toEqual(["user"])
  expect(hookAborted).toBe(true)
  await agent.dispose()
})

test("turn.beforeEnd failures pass safely without trapping the turn", async () => {
  const errors: string[] = []
  const interceptors = new InterceptorRegistry({
    onError: (point, source, error) => errors.push(`${point}:${source}:${error}`),
  })
  const { agent } = makeAgent([{ text: "all set" }], interceptors)
  interceptors.add(
    "turn.beforeEnd",
    () => {
      throw new Error("verifier exploded")
    },
    {},
    "goal-ext",
  )

  const result = await agent.prompt("hi")
  expect(result).toEqual({ reason: "done", steps: 1 })
  expect(errors).toEqual(["turn.beforeEnd:goal-ext:verifier exploded"])
  await agent.dispose()
})
