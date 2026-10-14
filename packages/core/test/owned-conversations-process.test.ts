import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

test("a foreign host conflicts with the lease, then reopens persisted history inertly", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "amira-owned-process-"))
  const mock = createMockDialect([{ text: "saved answer" }])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const tools = new ToolRegistry()
  const tree = new AgentTree({ ai, sections: () => [] })
  const main = new Agent({ ai, model: ai.model("mock/test"), cwd: home, tools, tree, sections: [] })
  const manager = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
  const worker = async (id: string) => {
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "owned-conversations-worker.ts"), home, id],
      {
        cwd: path.resolve(import.meta.dir, "../../.."),
        env: { ...process.env, HOME: home, USERPROFILE: home, AMIRA_HOME: path.join(home, ".amira") },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    return JSON.parse(stdout)
  }
  try {
    const handle = await manager.forOwner("notes").openOrCreate(
      {
        key: "design",
        name: "Design",
        cwd: home,
        systemPrompt: "Research.",
        callableTools: [],
      },
      { askUser: async () => undefined },
    )
    await handle.send("remember this")
    const conflict = await worker(handle.id)
    expect(conflict.error).toContain("in use")
    expect(conflict.requests).toBe(0)
    await handle.release()
    expect(await worker(handle.id)).toEqual({ id: handle.id, roles: ["user", "assistant"], requests: 0 })
    expect(mock.requests).toHaveLength(1)
  } finally {
    await manager.drain()
    await main.dispose()
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)
