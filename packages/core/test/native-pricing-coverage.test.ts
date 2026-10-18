import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type Dialect, type DialectCompactOutcome, userMessage } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { conversationUsage } from "../src/owned-conversations-usage.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

for (const outcome of ["success", "failure", "fallback", "missing-receipt", "priced"] as const) {
  test(`unpriced native retry coverage survives ${outcome} and session reopen`, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "amira-native-pricing-coverage-"))
    const mock = createMockDialect([
      outcome === "failure"
        ? { error: { message: "summary failed" }, usage: { cost: 0 } }
        : { text: "fallback summary", usage: { input: 10, output: 1, cost: 0.4 } },
    ])
    let attempts = 0
    const dialect: Dialect = {
      ...mock,
      compaction: {
        methods: ["server"],
        layouts: ["tail"],
        midTurn: true,
        official: () => true,
        async compact(): Promise<DialectCompactOutcome> {
          attempts++
          const usage = {
            input: attempts === 1 ? 20 : 30,
            output: attempts === 1 ? 2 : 3,
            cacheRead: 0,
            cacheWrite: 0,
            ...(attempts === 1 ? (outcome === "priced" ? { cost: 0.2 } : {}) : { cost: 0.3 }),
          }
          if (
            attempts === 2 &&
            (outcome === "success" || outcome === "missing-receipt" || outcome === "priced")
          )
            return { ok: true, value: "checkpoint", usage }
          return {
            ok: false,
            error: { message: "native busy", status: 503 },
            unsupported: false,
            retryable: attempts === 1,
            ...(attempts === 1 && outcome === "missing-receipt" ? {} : { usage }),
          }
        },
      },
    }
    const ai = createAi({
      dialects: [dialect],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
      retry: { retries: 1, baseDelayMs: 0, nativeCompactionTimeoutMs: 0 },
    })
    if (outcome === "missing-receipt") {
      // A producer forgetting its aggregate warning cannot erase the individual physical receipt gap.
      const compact = ai.compact.bind(ai)
      ai.compact = async (...args) => ({ ...(await compact(...args)), usageIncomplete: false })
    }
    const store = SessionStore.create({
      cwd: directory,
      dir: directory,
      owned: {
        v: 1,
        owner: "test",
        spec: {
          key: "test",
          name: "Test",
          cwd: directory,
          model: "mock/test",
          systemPrompt: "",
          callableTools: [],
        },
        runtimeTools: [],
      },
    })
    store.appendMessage(userMessage("seed"))
    const tree = new AgentTree({ ai, sections: () => [] })
    const agent = new Agent({
      ai,
      tree,
      session: store,
      cwd: directory,
      model: ai.model("mock/test"),
      sections: [],
      ownedConversation: "test",
      messages: [
        userMessage("old"),
        {
          role: "assistant",
          content: [{ type: "text", text: "old reply" }],
          model: { provider: "mock", model: "test" },
        },
        userMessage("new"),
      ],
      compaction: { auto: false },
    })
    cleanups.push(async () => {
      await agent.dispose()
      rmSync(directory, { recursive: true, force: true })
    })

    expect(ai.model("mock/test").cost).toBeUndefined()
    expect(await agent.compact()).toBe(outcome !== "failure")
    expect(attempts).toBe(2)
    expect(mock.requests).toHaveLength(
      outcome === "success" || outcome === "missing-receipt" || outcome === "priced" ? 0 : 1,
    )
    const knownCostUsd = outcome === "fallback" ? 0.7 : outcome === "priced" ? 0.5 : 0.3
    const snapshots = [conversationUsage(agent).own, conversationUsage(SessionStore.open(store.file)).own]
    expect(snapshots.map((snapshot) => snapshot.knownCostUsd)).toEqual([knownCostUsd, knownCostUsd])
    expect(snapshots.map((snapshot) => snapshot.complete)).toEqual([
      outcome === "priced",
      outcome === "priced",
    ])
    const row = store.entries.find((entry) =>
      outcome === "failure" ? entry.type === "side_usage" : entry.type === "compaction",
    )
    expect(row?.accounting?.coverageIncomplete).toBe(outcome === "priced" ? undefined : true)
    expect(row?.accounting?.knownCostUsd).toBeCloseTo(knownCostUsd)
  })
}
