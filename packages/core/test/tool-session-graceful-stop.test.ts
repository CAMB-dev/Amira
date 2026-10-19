import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { defineTool, type ToolContext, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { SessionStore } from "../src/session-store.ts"
import { Child } from "../src/subagents/child.ts"
import { scopeAdmission } from "../src/subagents/lifecycle.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), "amira-tool-session-graceful-stop-"))
  const mock = createMockDialect([{ toolCalls: [{ name: "hold", args: {} }] }, { text: "finished" }])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const entered = Promise.withResolvers<ToolContext>()
  const finish = Promise.withResolvers<void>()
  const tools = new ToolRegistry()
  tools.register(
    defineTool({
      name: "hold",
      description: "Hold the current tool while its persistent child is stopped",
      parameters: { type: "object" },
      traits: { readOnly: true },
      execute: async (_args, context) => {
        entered.resolve(context)
        await finish.promise
        return textResult("finished")
      },
    }),
    "test",
  )
  tools.register(
    defineTool({
      name: "deferred",
      description: "Load a deferred tool during the current turn",
      exposure: "deferred",
      parameters: { type: "object" },
      execute: async () => textResult("loaded"),
    }),
    "test",
  )
  const tree = new AgentTree({ ai, sections: () => [] })
  const root = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd,
    tools,
    tree,
    sections: [],
    session: SessionStore.create({ cwd, dir: path.join(cwd, "sessions") }),
  })
  cleanups.push(async () => {
    finish.resolve()
    await root.dispose()
    rmSync(cwd, { recursive: true, force: true })
  })
  const child = tree.spawn(root, { prompt: "hold", persistent: true })
  if (!(child instanceof Child)) throw new Error("expected tree child")
  return { tree, child, entered: entered.promise, finish }
}

test("an ordinary persistent child's graceful stop allows its current tool operations but rejects spawning", async () => {
  const f = fixture()
  const context = await f.entered
  const session = context.session!
  const group = session.createGroup!({ name: "captured before stop" })

  f.child.stop("finish the current turn")

  expect(context.signal.aborted).toBe(false)
  expect(() => session.spawn!({ prompt: "late child" })).toThrow(/ended or stopped/)
  expect(() => session.createGroup!({ name: "late group" })).toThrow(/ended or stopped/)
  expect(() => group.spawn({ prompt: "late group child" })).toThrow(/ended or stopped/)
  session.data!.append("progress", "completed after stop")
  expect(session.data!.read("progress")).toEqual(["completed after stop"])
  const saved = await session.outputs!.save({ text: "completed output", tool: "hold" })
  expect(session.outputs!.find(saved.id)).toEqual(saved)
  expect(session.loadTools(["deferred"])).toEqual(["deferred"])
  expect(context.signal.aborted).toBe(false)

  f.finish.resolve()
  expect((await f.child.result()).status).toBe("done")
})

for (const action of ["fence", "suspend", "release", "dispose"] as const) {
  test(`${action} still revokes a gracefully stopping child's current tool operations`, async () => {
    const f = fixture()
    const context = await f.entered
    const session = context.session!
    const scope = scopeAdmission(f.tree)
    f.child.stop("finish the current turn")
    let resume: (() => void) | undefined
    let disposing: Promise<void> | undefined
    if (action === "dispose") disposing = f.child.agent.dispose()
    else if (action === "release") scope.release()
    else resume = scope[action]()

    try {
      if (action === "fence") {
        expect(context.signal.aborted).toBe(false)
        expect(scope.signal.aborted).toBe(false)
      }
      if (action === "dispose") scope.checkExecution()
      const revoked = /stopping|released/
      expect(() => session.data!.append("late", "not written")).toThrow(revoked)
      expect(session.data!.read("late")).toEqual([])
      expect(() => session.loadTools(["deferred"])).toThrow(revoked)
      expect(session.deferredTools().find((tool) => tool.name === "deferred")?.loaded).toBe(false)
      await expect(session.outputs!.save({ text: "not saved", tool: "hold" })).rejects.toThrow(revoked)
      resume?.()
      if (resume) {
        // Lifting a scope hold restores execution, never the stopped parent's spawn admission.
        session.data!.append("resumed", "finished")
        expect(session.loadTools(["deferred"])).toEqual(["deferred"])
        expect(() => session.spawn!({ prompt: "still forbidden" })).toThrow(/ended or stopped/)
      }
    } finally {
      resume?.()
      f.finish.resolve()
      await f.child.result()
      await disposing
    }
    if (action === "dispose") {
      expect(() => session.data!.append("late", "after disposal")).toThrow(/released/)
      expect(() => session.loadTools([])).toThrow(/released/)
      await expect(session.outputs!.save({ text: "after disposal", tool: "hold" })).rejects.toThrow(
        /released/,
      )
    }
  })
}
