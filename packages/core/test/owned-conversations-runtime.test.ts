import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

test("the generic conversation ceiling can admit an owner's fixed note-writing tool", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "amira-owned-runtime-"))
  const mock = createMockDialect([
    { toolCalls: [{ id: "save", name: "save_note", args: { note: "confirmed" } }] },
    { text: "saved" },
  ])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const tools = new ToolRegistry()
  const tree = new AgentTree({ ai, sections: () => [] })
  const main = new Agent({ ai, model: ai.model("mock/test"), cwd: home, tools, tree, sections: [] })
  const manager = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
  const save = defineTool({
    name: "save_note",
    description: "Save a note in this conversation's owner records",
    parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    traits: { writesFiles: "paths" },
    // SessionData uses host persistence, not a model-selected output path.
    getWrittenPaths: () => [],
    execute: async ({ note }: { note: string }, context) => {
      if (!context.session?.data) throw new Error("missing bound conversation data")
      context.session.data.append("notes", { note })
      return textResult("saved")
    },
  })
  try {
    const owner = manager.forOwner("notes")
    const runtime = { askUser: async () => undefined, extraTools: [save] }
    const handle = await owner.openOrCreate(
      {
        key: "design",
        name: "Design",
        cwd: home,
        systemPrompt: "Discuss notes.",
        callableTools: ["save_note"],
      },
      runtime,
    )
    await handle.send("Save my note")
    expect(handle.data.read("notes")).toEqual([{ note: "confirmed" }])
    expect(main.data.read("notes")).toEqual([])
    await handle.release()
    await expect(owner.open(handle.id, { askUser: async () => undefined })).rejects.toThrow("missing")
    const reopened = await owner.open(handle.id, runtime)
    expect(reopened.data.read("notes")).toEqual([{ note: "confirmed" }])
    expect(mock.requests).toHaveLength(2)
  } finally {
    await manager.drain()
    await main.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
