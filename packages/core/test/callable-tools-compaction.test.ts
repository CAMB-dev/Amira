import { expect, test } from "bun:test"
import { createAi, createMockDialect, type ModelRequest } from "@amira/ai"
import { responsesBody } from "../../ai/src/dialects/openai-responses.ts"
import { Agent } from "../src/agent.ts"

for (const native of [false, true]) {
  test(`callableTools excludes hosted search from ${native ? "native" : "alternate-model text"} compaction`, async () => {
    const mock = createMockDialect(Array.from({ length: 5 }, () => ({ text: "ordinary reply" })))
    const nativeRequests: ModelRequest[] = []
    const ai = createAi({
      dialects: [
        {
          ...mock,
          id: "openai-responses",
          ...(native
            ? {
                compaction: {
                  methods: ["server"],
                  layouts: ["tail" as const],
                  midTurn: true,
                  official: () => true,
                  compact: async (_method: string, request: ModelRequest) => {
                    nativeRequests.push(structuredClone(request))
                    return { ok: true as const, value: "opaque checkpoint", tokens: 10 }
                  },
                },
              }
            : {}),
        },
      ],
      providers: [
        {
          id: "test",
          dialect: "openai-responses",
          baseUrl: "https://provider.invalid",
          compat: { webSearch: true },
        },
      ],
    })
    const agent = new Agent({
      ai,
      model: ai.model("test/gpt-5"),
      cwd: process.cwd(),
      callableTools: new Set(),
      depth: 1,
      parentSessionId: "parent",
      sections: [],
      compaction: { auto: false, keepTurns: 1, ...(!native ? { model: ai.model("test/writer") } : {}) },
    })
    try {
      for (const question of ["one", "two", "three"]) await agent.prompt(question)
      expect(await agent.compact()).toBe(true)
      expect(nativeRequests).toHaveLength(native ? 1 : 0)
      expect(mock.requests).toHaveLength(native ? 3 : 4)
      const compact = native ? nativeRequests[0]! : mock.requests[3]!
      expect(compact.model.id).toBe(native ? "gpt-5" : "writer")
      expect(compact.model.caps.webSearch).toBe(false)
      expect(responsesBody(compact).tools).toBeUndefined()
      expect(agent.model.caps.webSearch).toBe(true)
    } finally {
      await agent.dispose()
    }
  })
}
