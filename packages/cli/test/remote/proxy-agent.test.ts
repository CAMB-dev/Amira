import "../server/offline.ts"
import { expect, test } from "bun:test"
import { type AssistantMessage, emptyUsage, userMessage } from "@amira/ai"
import { Agent } from "@amira/core"
import { withCallableServerTools } from "../../../core/src/callable-server-tools.ts"
import { proxyFixture, secret } from "./model-proxy-fixture.ts"

const old: AssistantMessage = {
  role: "assistant",
  model: { provider: "p", model: "m" },
  content: [{ type: "text", text: "old reply" }],
  usage: { ...emptyUsage(), input: 100 },
  stopReason: "end",
}

test("real Agent accounting/native/tool decorators preserve the ProxyAi interface", async () => {
  let compactions = 0
  let streams = 0
  const fixture = proxyFixture(
    async function* (request) {
      streams++
      expect(request.model.caps.webSearch).toBe(false)
      yield { type: "done", message: { ...old, content: [{ type: "text", text: "completed" }] } }
    },
    1000,
    {
      methods: ["native"],
      layouts: ["tail"],
      midTurn: true,
      official: () => true,
      async compact() {
        compactions++
        return { ok: true, value: "checkpoint", summary: "old summary", usage: emptyUsage() }
      },
    },
  )
  const restricted = withCallableServerTools(fixture.proxy, new Set())
  expect(restricted.replayTarget(fixture.request.model).provider).toBe("p")
  expect(restricted.canReplay({ dialect: "fixture", value: "sig" }, fixture.request.model)).toBe(true)
  const agent = new Agent({
    ai: restricted,
    model: fixture.request.model,
    cwd: process.cwd(),
    messages: [userMessage("old"), old, userMessage("recent"), old],
    compaction: { auto: true, threshold: 0, keepTurns: 1 },
  })
  try {
    await fixture.connect()
    expect(await agent.prompt("continue")).toMatchObject({ reason: "done" })
    expect(compactions).toBe(1)
    expect(streams).toBe(1)
    for (const frame of fixture.observed) expect(frame).not.toContain(secret)
  } finally {
    await agent.dispose()
    fixture.close()
  }
})
