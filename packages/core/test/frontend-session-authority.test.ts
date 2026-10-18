import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { createLocalAgentPort } from "../src/frontend/local-port.ts"
import { frontendIdentity } from "../src/frontend/port.ts"

test("a failed switched projection does not strand current controls behind its old snapshot", async () => {
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agents = Array.from(
    { length: 3 },
    () => new Agent({ ai, model: ai.model("mock/m"), cwd: "/workspace", systemPrompt: "" }),
  )
  const [first, broken, recovered] = agents as [Agent, Agent, Agent]
  broken.messages.push({
    role: "toolResult",
    toolCallId: "bad",
    toolName: "bad",
    content: [],
    isError: true,
    details: Number.POSITIVE_INFINITY,
  })
  let switched!: (next: Agent) => void
  let commands = 0
  let aborts = 0
  const abort = broken.abort.bind(broken)
  broken.abort = () => {
    aborts++
    abort()
  }
  const port = createLocalAgentPort({
    agent: first,
    commands: {
      onSwitch: (listener) => {
        switched = listener
        return () => {}
      },
      run: async () => {
        commands++
        switched(recovered)
        return { ok: true, output: [] }
      },
    },
  })
  const original = port.snapshot
  try {
    switched(broken)
    expect(port.snapshot).toBe(original)
    expect(frontendIdentity(port)).toEqual({ sessionId: broken.sessionId, sessionGeneration: 2 })
    expect(Object.isFrozen(port.identity)).toBe(true)
    await expect(port.execute("state.read", {})).rejects.toThrow("Frontend data")
    await port.execute("turn.abort", {}, frontendIdentity(port))
    expect(aborts).toBe(1)
    expect(await port.execute("command.run", { line: "/clear" }, frontendIdentity(port))).toEqual({
      ok: true,
      output: [],
    })
    expect(commands).toBe(1)
    expect(port.snapshot.state.sessionId).toBe(recovered.sessionId)
    await expect(
      port.execute("turn.abort", {}, { sessionGeneration: original.sessionGeneration }),
    ).rejects.toMatchObject({ code: "stale_session" })
  } finally {
    await port.detach()
    for (const agent of agents) await agent.dispose()
  }
})
