import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type ModelRequest } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"

const head = "PRIVATE DISPLAY HEAD"
const details = "PRIVATE DISPLAY DETAILS"
const display = { type: "display" as const, level: "info" as const, text: head, details }

function expectNoDisplay(request: ModelRequest) {
  const sent = JSON.stringify(request)
  expect(sent).not.toContain(head)
  expect(sent).not.toContain(details)
  expect(request.messages.length).toBeGreaterThan(0)
}

test("session forks and ordinary/ephemeral subagent forks exclude retained display entries from provider requests", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-display-forks-"))
  const mock = createMockDialect(Array.from({ length: 6 }, () => ({ text: "main reply" })))
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const tree = new AgentTree({ ai, sections: () => [] })
  const store = SessionStore.create({ cwd: dir, dir })
  const parent = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: dir,
    session: store,
    tree,
    sections: [],
  })
  let fork: Agent | undefined
  try {
    store.append(display)
    await parent.prompt("ordinary history")
    store.append(display)
    const copied = SessionStore.open(store.file).fork()
    expect(copied.branch().filter((entry) => entry.type === "display")).toHaveLength(2)
    fork = new Agent({ ai, model: parent.model, cwd: dir, session: copied, sections: [] })
    await fork.prompt("fork continuation")
    for (const ephemeral of [false, true]) {
      const child = tree.spawn(parent, {
        prompt: "forked side question",
        context: "fork",
        ephemeral,
        maxTurns: 1,
      })
      expect((await child.result()).status).toBe("done")
    }
    expect(mock.requests).toHaveLength(4)
    for (const request of mock.requests) {
      expectNoDisplay(request)
      expect(JSON.stringify(request.messages)).toContain("ordinary history")
    }
    expect(store.branch().filter((entry) => entry.type === "display")).toHaveLength(2)
  } finally {
    await fork?.dispose()
    await parent.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const native of [false, true]) {
  test(`${native ? "native" : "text"} compaction and its next provider request exclude display entries`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amira-display-compaction-"))
    const mock = createMockDialect(Array.from({ length: 6 }, () => ({ text: "ordinary reply" })))
    const compactions: ModelRequest[] = []
    const ai = createAi({
      dialects: [
        {
          ...mock,
          ...(native
            ? {
                compaction: {
                  methods: ["server"],
                  layouts: ["tail" as const],
                  midTurn: true,
                  official: () => true,
                  compact: async (_method: string, request: ModelRequest) => {
                    compactions.push(structuredClone(request))
                    return { ok: true as const, value: "opaque checkpoint", tokens: 10 }
                  },
                },
              }
            : {}),
        },
      ],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    })
    const store = SessionStore.create({ cwd: dir, dir })
    const agent = new Agent({
      ai,
      model: ai.model("mock/m"),
      cwd: dir,
      session: store,
      sections: [],
      compaction: { auto: false, keepTurns: 1 },
    })
    try {
      for (const question of [
        "first ordinary question",
        "second ordinary question",
        "third ordinary question",
      ]) {
        store.append(display)
        await agent.prompt(question)
      }
      expect(await agent.compact()).toBe(true)
      expect(store.branch().some((entry) => entry.type === "compaction")).toBe(true)
      await agent.prompt("continue after compaction")
      expect(compactions).toHaveLength(native ? 1 : 0)
      expect(mock.requests).toHaveLength(native ? 4 : 5)
      for (const request of [...mock.requests, ...compactions]) expectNoDisplay(request)
      const summaryRequest = native ? compactions[0]! : mock.requests[3]!
      expect(JSON.stringify(summaryRequest.messages)).toContain("first ordinary question")
      expect(store.branch().filter((entry) => entry.type === "display")).toHaveLength(3)
    } finally {
      await agent.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
