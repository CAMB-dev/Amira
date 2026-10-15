import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { Child } from "../src/subagents/child.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), "amira-subagents-lifecycle-"))
  const mock = createMockDialect(Array.from({ length: 12 }, () => ({ text: "ready" })))
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  const root = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd,
    tree,
    tools: new ToolRegistry(),
    sections: [],
  })
  cleanups.push(async () => {
    tree.abortAll("test cleanup")
    await tree.waitForChildren()
    await root.dispose()
    rmSync(cwd, { recursive: true, force: true })
  })
  return { tree, root }
}

function childAgent(child: unknown): Agent {
  if (!(child instanceof Child)) throw new Error("expected tree child")
  return child.agent
}

async function idle(child: { state: string }) {
  const deadline = Date.now() + 3000
  while (child.state !== "idle") {
    if (Date.now() > deadline) throw new Error("child did not become idle")
    await Bun.sleep(2)
  }
}

for (const nested of [false, true]) {
  test(`abortChildren preserves an ordinary idle ${nested ? "child" : "root"} parent's spawn authority`, async () => {
    const { tree, root } = fixture()
    let parent = root
    if (nested) {
      const child = tree.spawn(root, { prompt: "stay available", persistent: true })
      await idle(child)
      parent = childAgent(child)
    }
    const oldGroup = tree.createGroup(parent, { name: "old work" })
    const oldChild = oldGroup.spawn({ prompt: "old child", persistent: true })
    await idle(oldChild)

    tree.abortChildren(parent.sessionId, "cancel old work")

    const group = tree.createGroup(parent, { name: "new work" })
    const direct = tree.spawn(parent, { prompt: "new direct child" })
    const grouped = group.spawn({ prompt: "new grouped child" })
    expect((await oldChild.result()).status).toBe("aborted")
    expect((await direct.result()).status).toBe("done")
    expect((await grouped.result()).status).toBe("done")
    expect(() => oldGroup.spawn({ prompt: "stale group" })).toThrow(/ended/)
    expect(() => tree.spawn(childAgent(oldChild), { prompt: "ended child" })).toThrow(/ended/)
    expect(parent.busy).toBe(false)
  })
}

for (const nested of [false, true]) {
  test(`disposing an ordinary idle ${nested ? "child" : "root"} permanently revokes captured parent authority`, async () => {
    const { tree, root } = fixture()
    let parent = root
    if (nested) {
      const child = tree.spawn(root, { prompt: "stay available", persistent: true })
      await idle(child)
      parent = childAgent(child)
    }
    const group = tree.createGroup(parent, { name: "captured group" })
    const disposing = parent.dispose()
    const refused = () => {
      expect(() => tree.spawn(parent, { prompt: "late child" })).toThrow(/ended/)
      expect(() => tree.createGroup(parent, { name: "late group" })).toThrow(/ended/)
      expect(() => group.spawn({ prompt: "late grouped child" })).toThrow(/ended/)
    }
    refused()
    await disposing
    refused()
  })
}

for (const ephemeral of [false, true]) {
  test(`an ended ${ephemeral ? "private" : "ordinary"} child permanently revokes captured parent authority`, async () => {
    const { tree, root } = fixture()
    const child = tree.spawn(root, { prompt: "finish", ephemeral })
    const parent = childAgent(child)
    const group = tree.createGroup(parent, { name: "captured group" })
    if (ephemeral) {
      await idle(child)
      child.stop()
    }
    expect((await child.result()).status).toBe("done")
    await tree.waitForChildren(root.sessionId)
    expect(() => tree.spawn(parent, { prompt: "late child" })).toThrow(/ended/)
    expect(() => tree.createGroup(parent, { name: "late group" })).toThrow(/ended/)
    expect(() => group.spawn({ prompt: "late grouped child" })).toThrow(/ended/)
  })
}
