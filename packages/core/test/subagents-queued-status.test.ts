import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { AgentTree } from "../src/subagents.ts"

test("initial waiting is readable from child.state without requiring replayed start events", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-queued-status-"))
  let release!: () => void
  const until = new Promise<void>((resolve) => {
    release = resolve
  })
  const ai = createAi({
    dialects: [createMockDialect([{ text: "held", hold: { chunks: 0, until } }])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, maxConcurrent: 1, sections: () => [] })
  const root = new Agent({ ai, tree, model: ai.model("mock/m"), cwd: dir, sections: [] })
  try {
    tree.spawn(root, { prompt: "occupy slot" })
    const child = tree.spawn(root, { prompt: "side question", ephemeral: true, maxTurns: 1 })
    expect(child.state).toBe("queued")
    const events: AnyEvent[] = []
    const collected = (async () => {
      for await (const event of child.events) events.push(event)
    })()
    child.abort()
    await child.result()
    await collected
    expect(events.some((event) => event.type === "subagent.start")).toBe(false)
    expect(events.some((event) => event.type === "subagent.end")).toBe(true)
  } finally {
    release()
    await root.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const doc of ["extensions.md", "zh/extensions.md"]) {
  test(`${doc}: waiting guidance uses child.state instead of promising a replayed initial start`, () => {
    const text = readFileSync(new URL(`../../../docs/${doc}`, import.meta.url), "utf8")
    const guidance = text.split("\n").find((line) => line.includes('`child.state === "queued"`'))
    expect(guidance).toBeDefined()
    expect(guidance).not.toMatch(/`child\.events`[^。\n]*(?:initial|首轮)[^。\n]*`subagent\.start`/)
  })
}

test("the ChildSession.events API comment describes the initial state without promising replay", () => {
  const text = readFileSync(new URL("../../api/src/subagents.ts", import.meta.url), "utf8")
  const comment = text.match(
    /\/\*\*\s*\n\s*\* The events of this child[\s\S]*?\*\/(?=\s*readonly events)/,
  )?.[0]
  expect(comment).toBeDefined()
  expect(comment).not.toContain("miss nothing")
  expect(comment).toContain("not replayed")
  expect(comment).toContain("child.state")
})
