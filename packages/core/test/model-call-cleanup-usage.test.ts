import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { type Ai, createAi, createMockDialect, emptyUsage } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { conversationUsage } from "../src/owned-conversations-usage.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"

for (const terminal of ["done", "error"] as const) {
  for (const corrected of [0.1, 0.3, "omitted", "omitted-clean"] as const) {
    const omitted = typeof corrected === "string"
    const failing = corrected !== "omitted-clean"
    test(`normal ${terminal} retains ${omitted ? "known amounts after sparse cleanup" : `cleanup correction to ${corrected}`} ${failing ? "before iterator failure" : "at normal EOF"}`, async () => {
      const home = mkdtempSync(path.join(tmpdir(), "amira-model-cleanup-"))
      const base = createAi({
        dialects: [createMockDialect()],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
        retry: { retries: 0 },
      })
      const ai: Ai = {
        ...base,
        async *stream(request) {
          const message = {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "actual reply" }],
            model: { provider: request.model.provider, model: request.model.id },
            usage: { ...emptyUsage(), input: 20, output: 2, cost: 0.2 },
          }
          try {
            yield terminal === "done"
              ? { type: "done", message }
              : {
                  type: "error",
                  message,
                  error: { message: "provider failure" },
                  retryable: false,
                }
          } finally {
            yield {
              type: "request.end",
              message: {
                ...message,
                content: [],
                usage: omitted
                  ? { ...emptyUsage(), input: 20, output: 2 }
                  : { ...emptyUsage(), input: 30, output: 3, cost: corrected },
              },
            }
            // biome-ignore lint/correctness/noUnsafeFinally: simulate a reported receipt from failing cleanup.
            if (failing) throw new Error("cleanup failure")
          }
        },
      }
      const store = SessionStore.create({
        cwd: home,
        dir: home,
        owned: {
          v: 1,
          owner: "test",
          spec: {
            key: "cleanup",
            name: "Cleanup",
            cwd: home,
            model: "mock/owned",
            systemPrompt: "",
            callableTools: [],
          },
          runtimeTools: [],
        },
      })
      const tree = new AgentTree({ ai, sections: () => [] })
      const agent = new Agent({
        ai,
        model: ai.model("mock/owned"),
        cwd: home,
        session: store,
        ownedConversation: "test",
        tree,
        sections: [],
        compaction: { auto: false },
      })
      try {
        const cost = omitted ? 0.2 : corrected
        expect((await agent.prompt("work")).reason).toBe(terminal === "error" || failing ? "error" : "done")
        expect(tree.usage.cost).toBeCloseTo(cost)
        for (const source of [agent, SessionStore.open(store.file)]) {
          const snapshot = conversationUsage(source)
          expect(snapshot.own).toMatchObject({ knownCostUsd: cost, complete: false })
          expect(snapshot.own.usage.input).toBe(omitted ? 20 : 30)
        }
        expect(agent.messages.at(-1)?.content).toEqual([{ type: "text", text: "actual reply" }])
      } finally {
        await agent.dispose()
        tree.releaseScope()
        rmSync(home, { recursive: true, force: true })
      }
    })
  }
}
