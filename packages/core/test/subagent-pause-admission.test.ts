import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { type ChildSession, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

for (const stopCleanly of [false, true]) {
  test(`${stopCleanly ? "clean stop" : "resume"} admits descendants held behind a paused parent's slot`, async () => {
    const entered = Promise.withResolvers<void>()
    const spawn = Promise.withResolvers<void>()
    const spawned = Promise.withResolvers<ChildSession>()
    const mock = createMockDialect([
      { toolCalls: [{ name: "child", args: {} }] },
      { text: "grandchild finished" },
      { text: "parent finished" },
    ])
    const ai = createAi({
      dialects: [mock],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      retry: { retries: 0 },
    })
    const tree = new AgentTree({ ai, maxConcurrent: 1, sections: () => [] })
    const tools = new ToolRegistry()
    tools.register(
      defineTool({
        name: "child",
        description: "Start a child when released",
        parameters: { type: "object" },
        execute: async (_args, ctx) => {
          entered.resolve()
          await spawn.promise
          const child = ctx.session!.spawn!({ prompt: "grandchild" })
          spawned.resolve(child)
          return textResult((await child.result()).text)
        },
      }),
      "test",
    )
    const root = new Agent({ ai, model: ai.model("mock/m"), cwd: process.cwd(), tree, tools })
    try {
      const parent = tree.spawn(root, { prompt: "parent", persistent: stopCleanly })
      await entered.promise
      expect(tree.pause(parent.id)).toBe(true)
      spawn.resolve()
      const child = await spawned.promise
      await Bun.sleep(10)
      expect(child.state).toBe("queued")
      expect(mock.requests).toHaveLength(1)
      if (stopCleanly) parent.stop("enough")
      else expect(tree.resume(parent.id)).toBe(true)
      expect((await child.result()).status).toBe("done")
      expect((await parent.result()).status).toBe("done")
      expect(mock.requests).toHaveLength(3)
    } finally {
      spawn.resolve()
      await root.dispose()
    }
  })
}
