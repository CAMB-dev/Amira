import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { gitInfo, trackWorkspace } from "../src/git.ts"
import { workspaceFor } from "../src/workspace.ts"

test("Agent.start cannot be tricked into overriding cwd and carries no turn id", async () => {
  const ai = createAi({
    dialects: [createMockDialect()],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const bus = new EventBus()
  const seen: AnyEvent[] = []
  bus.subscribe((e) => void seen.push(e))
  const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/real", systemPrompt: "", bus })
  const extra = { cwd: "/fake", resume: ["amira", "--resume", agent.sessionId] }
  agent.start("startup", extra as never)
  await bus.flush()
  const ev = seen[0] as Extract<AnyEvent, { type: "session.start" }>
  expect(ev.data.cwd).toBe("/real")
  expect(ev.data.resume).toEqual(["amira", "--resume", agent.sessionId])
  expect(ev.turnId).toBeUndefined()
  expect(ev.sessionId).toBe(agent.sessionId)
})

test("deprecated wrappers delegate to the host provider and return no facts without one", async () => {
  const bus = new EventBus()
  const seen: AnyEvent[] = []
  bus.subscribe((e) => void seen.push(e), { types: ["workspace.changed"] })
  const cwd = "/compatibility-test"
  expect(await gitInfo(cwd)).toEqual({})
  const unregister = workspaceFor(bus).register(
    { probe: async (cwd) => ({ cwd, branch: "main", dirty: true }) },
    "test",
    cwd,
    () => {},
  )
  const stop = trackWorkspace(bus, "s", cwd, { initialDelayMs: 0 })
  try {
    expect(await gitInfo(cwd)).toEqual({ branch: "main" })
    expect(await gitInfo(cwd, 100, { dirty: true })).toEqual({ branch: "main", dirty: true })
    const deadline = performance.now() + 2000
    while (!seen.length && performance.now() < deadline) await Bun.sleep(5)
    expect(seen).toHaveLength(1)
  } finally {
    stop()
    unregister()
  }
  expect(await gitInfo(cwd)).toEqual({})
})
