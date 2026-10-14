import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { Permissions } from "../src/permissions/policy.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

for (const actor of ["root", "descendant"] as const) {
  for (const action of ["block", "ask-denied", "ask-approved"] as const) {
    test(`host ${action} interceptors protect the owned ${actor} without leaking events or consulting models`, async () => {
      const home = mkdtempSync(path.join(tmpdir(), "amira-owned-interceptors-"))
      const mock = createMockDialect([
        { toolCalls: [{ name: "read", id: "read-call", args: {} }] },
        { text: "Tool was denied" },
      ])
      const ai = createAi({
        dialects: [mock],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
        retry: { retries: 0 },
      })
      const intercepted: string[] = []
      const approvals: string[] = []
      const interceptors = new InterceptorRegistry()
      interceptors.add("tool.call.before", (call, context) => {
        expect(call.name).toBe("read")
        intercepted.push(context.sessionId)
        return { action: action === "block" ? "block" : "ask", reason: "Host requires approval" }
      })
      let executions = 0
      const tools = new ToolRegistry()
      tools.register(
        defineTool({
          name: "read",
          description: "Read",
          parameters: { type: "object" },
          traits: { readOnly: true },
          execute: async () => {
            executions++
            return textResult("must not execute")
          },
        }),
        "fixture",
      )
      const tree = new AgentTree({ ai, sections: () => [] })
      const main = new Agent({
        ai,
        model: ai.model("mock/test"),
        cwd: home,
        tools,
        tree,
        interceptors,
        sections: [],
        permissions: new Permissions({
          approver: async (request) => {
            approvals.push(request.sessionId)
            return { approved: action === "ask-approved", reason: "Human decision" }
          },
        }),
      })
      const manager = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
      const mainToolEvents: string[] = []
      main.bus.subscribe((event) => {
        if (event.type === "tool.execute.end") mainToolEvents.push(event.sessionId)
      })
      try {
        const owned = await manager
          .forOwner("notes")
          .openOrCreate(
            { key: "design", name: "Design", cwd: home, systemPrompt: "Research", callableTools: ["read"] },
            { askUser: async () => undefined },
          )
        let sessionId = owned.id
        if (actor === "root") await owned.send("try read")
        else {
          const child = owned.createGroup({ name: "Research" }).spawn({ prompt: "try read" })
          sessionId = child.id
          expect((await child.result()).status).toBe("done")
        }
        expect(intercepted).toEqual([sessionId])
        expect(approvals).toEqual(action === "block" ? [] : [sessionId])
        expect(executions).toBe(action === "ask-approved" ? 1 : 0)
        expect(mock.requests).toHaveLength(2)
        await main.bus.flush()
        expect(mainToolEvents).toEqual([])
      } finally {
        await manager.drain()
        await main.dispose()
        rmSync(home, { recursive: true, force: true })
      }
    })
  }
}
