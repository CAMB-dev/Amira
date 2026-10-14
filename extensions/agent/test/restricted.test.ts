import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "../../../packages/ai/src/index.ts"
import {
  Agent,
  AgentTree,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  ToolRegistry,
} from "../../../packages/core/src/index.ts"
import { createAgentExtension } from "../src/index.ts"

test("restricted agent tool refuses explicit and role-default worktrees before calling git", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "amira-restricted-agent-"))
  const saved = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = home
  await mkdir(path.join(home, "agents"))
  await writeFile(path.join(home, "agents", "coder.md"), "---\nisolation: worktree\n---\nInspect only.")
  let gitCalls = 0
  const mock = createMockDialect([
    {
      toolCalls: [
        {
          name: "agent",
          args: {
            tasks: [{ title: "Inspect the requested project", prompt: "inspect", isolation: "worktree" }],
          },
        },
      ],
    },
    { text: "refused" },
    {
      toolCalls: [
        {
          name: "agent",
          args: { tasks: [{ title: "Inspect the requested project", prompt: "inspect", role: "coder" }] },
        },
      ],
    },
    { text: "refused again" },
  ])
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const bus = new EventBus()
  const tools = new ToolRegistry()
  const interceptors = new InterceptorRegistry()
  const host = new ExtensionHost({ bus, tools, interceptors, cwd: home })
  const tree = new AgentTree({ ai, restricted: true })
  const root = new Agent({ ai, model: ai.model("mock/m"), cwd: home, bus, tools, interceptors, tree })
  try {
    expect(
      await host.load(
        createAgentExtension({
          git: async () => {
            gitCalls++
            throw new Error("git must not run")
          },
        }),
        "agent",
      ),
    ).toBe(true)
    await root.prompt("explicit worktree")
    await root.prompt("role worktree")
    expect(gitCalls).toBe(0)
    expect(tree.childrenOf(root.sessionId)).toEqual([])
    const results = root.messages.filter((message) => message.role === "toolResult")
    expect(results).toHaveLength(2)
    for (const result of results) expect(JSON.stringify(result.content)).toContain("restricted conversation")
  } finally {
    await root.dispose()
    host.unloadAll()
    if (saved === undefined) delete process.env.AMIRA_HOME
    else process.env.AMIRA_HOME = saved
    await rm(home, { recursive: true, force: true })
  }
})
