import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { SPAWN_TEST_TIMEOUT_MS, stopSpawn, waitForSpawnCondition } from "../../../scripts/spawn-test.ts"
import { Agent } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

for (const phase of ["request", "question"] as const) {
  test(
    `a process crash during ${phase} reopens stopped and inert, then explicitly continues`,
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), "amira-owned-interrupted-"))
      const mock = createMockDialect([{ text: "explicit continuation" }])
      const ai = createAi({
        dialects: [mock],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
        retry: { retries: 0 },
      })
      const tools = new ToolRegistry()
      const tree = new AgentTree({ ai, sections: () => [] })
      const main = new Agent({ ai, model: ai.model("mock/test"), cwd: home, tools, tree, sections: [] })
      const manager = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
      const worker = Bun.spawn(
        [process.execPath, path.join(import.meta.dir, "owned-conversations-crash-worker.ts"), home, phase],
        {
          cwd: path.resolve(import.meta.dir, "../../.."),
          env: { ...process.env, HOME: home, USERPROFILE: home, AMIRA_HOME: path.join(home, ".amira") },
          stdout: "ignore",
          stderr: "pipe",
        },
      )
      try {
        const ready = path.join(home, "ready.json")
        await waitForSpawnCondition(`crash worker ${worker.pid} reaches ${phase}`, () => {
          if (existsSync(ready)) return true
          if (worker.exitCode !== null)
            throw new Error(`crash worker ${worker.pid} exited (${worker.exitCode}) before ${phase}`)
          return false
        })
        const { id } = JSON.parse(readFileSync(ready, "utf8"))
        await stopSpawn(worker, `crash worker ${phase}`)
        let questions = 0
        const handle = await manager.forOwner("notes").open(id, {
          askUser: async () => {
            questions++
            return undefined
          },
        })
        expect(handle.status()).toEqual({ state: "stopped", busy: false })
        expect(handle.history().filter((message) => message.role === "user")).toHaveLength(1)
        expect(mock.requests).toHaveLength(0)
        expect(questions).toBe(0)
        await handle.send("Continue explicitly")
        expect(handle.status()).toEqual({ state: "idle", busy: false })
        expect(mock.requests).toHaveLength(1)
        expect(questions).toBe(0)
      } finally {
        await stopSpawn(worker, `crash worker ${phase} cleanup`)
        await manager.drain()
        await main.dispose()
        rmSync(home, { recursive: true, force: true })
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}
