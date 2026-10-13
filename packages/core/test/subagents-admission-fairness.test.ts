import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { AgentTree } from "../src/subagents.ts"

const promptOf = (request: ModelRequest) => {
  const content = request.messages.at(-1)?.content[0]
  return content?.type === "text" ? content.text : ""
}

async function until(done: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!done()) {
    if (Date.now() > deadline) throw new Error("expected admission state was not reached")
    await Bun.sleep(2)
  }
}

test("the oldest ordinary child precedes later private churn when ordinary capacity frees", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-admission-fairness-"))
  const gates = new Map<string, () => void>()
  const reply = (request: ModelRequest): MockReply => {
    const until = new Promise<void>((resolve) => gates.set(promptOf(request), resolve))
    return { text: "held request", hold: { chunks: 0, until } }
  }
  const mock = createMockDialect(Array.from({ length: 30 }, () => reply))
  let active = 0
  let peak = 0
  const stream = mock.stream.bind(mock)
  mock.stream = async function* (request, context) {
    active++
    peak = Math.max(peak, active)
    try {
      yield* stream(request, context)
    } finally {
      active--
    }
  }
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, maxConcurrent: 2, sections: () => [] })
  const root = new Agent({ ai, tree, cwd: dir, model: ai.model("mock/m"), bus: new EventBus() })
  try {
    const running = tree.spawn(root, { prompt: "ordinary running" })
    await until(() => gates.has("ordinary running"))
    const oldest = tree.spawn(root, { prompt: "ordinary oldest" })
    let ephemeral = tree.spawn(root, { prompt: "ephemeral 0", ephemeral: true, maxTurns: 1 })
    await until(() => gates.has("ephemeral 0"))
    for (let i = 1; i <= 5; i++) {
      const next = tree.spawn(root, { prompt: `ephemeral ${i}`, ephemeral: true, maxTurns: 1 })
      expect(next.state).toBe("queued")
      gates.get(`ephemeral ${i - 1}`)!()
      await ephemeral.result()
      await until(() => gates.has(`ephemeral ${i}`))
      expect(oldest.state).toBe("queued")
      ephemeral = next
    }
    const later = tree.spawn(root, { prompt: "ephemeral later", ephemeral: true, maxTurns: 1 })
    expect(later.state).toBe("queued")
    gates.get("ordinary running")!()
    await running.result()
    await until(() => gates.has("ordinary oldest"))
    expect(later.state).toBe("queued")
    expect(active).toBe(2)
    expect(peak).toBe(2)
    expect(mock.requests.map(promptOf)).toEqual([
      "ordinary running",
      "ephemeral 0",
      "ephemeral 1",
      "ephemeral 2",
      "ephemeral 3",
      "ephemeral 4",
      "ephemeral 5",
      "ordinary oldest",
    ])
    gates.get("ordinary oldest")!()
    await oldest.result()
    await until(() => gates.has("ephemeral later"))
    gates.get("ephemeral later")!()
    gates.get("ephemeral 5")!()
    await Promise.all([later.result(), ephemeral.result()])
    expect(active).toBe(0)
  } finally {
    for (const release of gates.values()) release()
    await root.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
