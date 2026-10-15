import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { Permissions } from "../src/permissions/policy.ts"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

for (const invalidReport of ["outside", "changed-inside", "empty", "throws"] as const) {
  for (const invalidAt of [2, 3]) {
    test(`report ${invalidAt} that ${invalidReport} is refused before approval and execution without rewind`, async () => {
      const cwd = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "amira-write-reports-")))
      cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
      const root = path.join(cwd, "allowed")
      const home = path.join(cwd, "home")
      mkdirSync(root)
      mkdirSync(home)
      let reports = 0
      let executed = 0
      let approved = 0
      const mock = createMockDialect([
        { toolCalls: [{ name: "writer", args: {}, id: "write" }] },
        { text: "done" },
      ])
      const ai = createAi({
        dialects: [mock],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
        retry: { retries: 0 },
      })
      const agent = new Agent({
        ai,
        model: ai.model("mock/test"),
        cwd,
        sections: [],
        writeRoots: [root],
        fileRewindSettings: { enabled: false },
        permissions: new Permissions({
          mode: "auto",
          protect: { homedir: home, amiraHome: path.join(home, ".amira"), env: {} },
        }),
        approve: async () => {
          approved++
          return { approved: true }
        },
      })
      cleanups.push(() => agent.dispose())
      // The third report must also fail before an interceptor's question is presented.
      if (invalidAt === 3)
        agent.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "review write" }))
      // Presentation recovery must not erase a non-overridable ceiling denial.
      agent.interceptors.add("tool.call.after", (value) => {
        value.result.isError = false
        return { action: "modify", value }
      })
      agent.tools.register(
        {
          name: "writer",
          description: "test writer",
          parameters: { type: "object" },
          traits: { writesFiles: "paths" },
          getWrittenPaths: () => {
            reports++
            if (reports >= invalidAt) {
              if (invalidReport === "throws") throw new Error("report failed")
              if (invalidReport === "empty") return []
              if (invalidReport === "changed-inside") return [path.join(root, "different")]
              return [path.join(cwd, "outside")]
            }
            return [path.join(root, "safe")]
          },
          execute: async () => {
            executed++
            return textResult("must not execute")
          },
        },
        "test",
      )
      await agent.prompt("go")
      expect({ executed, approved }).toEqual({ executed: 0, approved: 0 })
      expect(agent.messages.find((message) => message.role === "toolResult")?.isError).toBe(true)
    })
  }
}
