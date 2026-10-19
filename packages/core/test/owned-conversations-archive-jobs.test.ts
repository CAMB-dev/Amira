import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { type BackgroundJobSession, defineTool, textResult } from "@amira/api"
import { JobRegistry } from "@amira/proc"
import { Agent } from "../src/agent.ts"
import { SessionBackgroundJobHost } from "../src/background-jobs.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("job fixture did not reach its gate")
    await Bun.sleep(2)
  }
}

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "amira-owned-archive-jobs-"))
  const registry = new JobRegistry({
    start: (_spec, emit) => {
      emit({ type: "spawned", pid: 7000, contained: true })
      return { stop: () => emit({ type: "exit", code: null, signal: null }) }
    },
  })
  const jobs = new SessionBackgroundJobHost(registry)
  const mock = createMockDialect([{ toolCalls: [{ name: "capture", args: {} }] }])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const tools = new ToolRegistry()
  const captures = new Map<string, BackgroundJobSession>()
  tools.register(
    defineTool({
      name: "capture",
      description: "Capture a background-job capability",
      parameters: { type: "object" },
      traits: { readOnly: true },
      execute: async (_args, context) => {
        captures.set(context.session!.sessionId, context.backgroundJobs!)
        return textResult("captured")
      },
    }),
    "test",
  )
  const tree = new AgentTree({ ai, sections: () => [] })
  const main = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: home,
    tools,
    tree,
    sections: [],
    backgroundJobs: jobs,
  })
  const managers: OwnedConversationManager[] = []
  const manager = (inert = false) => {
    const value = new OwnedConversationManager({
      ai,
      tools,
      tree,
      home,
      agent: () => {
        if (inert) throw new Error("archive must not construct a runtime")
        return main
      },
    })
    managers.push(value)
    return value
  }
  const host = manager()
  const owner = host.forOwner("project")
  const spec = { key: "jobs", name: "Jobs", cwd: home, systemPrompt: "", callableTools: ["capture"] }
  const runtime = { askUser: async () => undefined }
  cleanups.push(async () => {
    await Promise.all(managers.map((value) => value.drain()))
    await main.dispose()
    await jobs.stopAll(undefined, 0)
    rmSync(home, { recursive: true, force: true })
  })
  const start = (session: BackgroundJobSession) =>
    session.start({ command: "mock job", argv: ["not-executed"], cwd: home })
  return { home, jobs, registry, mock, captures, main, manager, host, owner, spec, runtime, start }
}

test("archive immediately fences captured root and descendant background-job admission", async () => {
  const f = fixture()
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  await handle.runTool("capture", {})
  const child = handle.createGroup({ name: "children" }).spawn({ prompt: "capture", persistent: true })
  await until(() => child.state === "idle")
  const rootJobs = f.captures.get(handle.id)!
  const childJobs = f.captures.get(child.id)!
  const archiving = f.owner.archive({ id: handle.id })
  try {
    expect(() => f.start(rootJobs)).toThrow(/archiv|releas|stopp|ended/i)
    expect(() => f.start(childJobs)).toThrow(/archiv|releas|stopp|ended/i)
  } finally {
    await archiving
  }
  expect(f.registry.list()).toEqual([])
})

for (const releasing of ["none", "pending", "completed"] as const) {
  for (const failure of ["live", "throw", "omitted"] as const) {
    test(`archive retains its lease and retries root-scoped job shutdown after ${failure} (release first: ${releasing})`, async () => {
      const f = fixture()
      const handle = await f.owner.openOrCreate(f.spec, f.runtime)
      await handle.runTool("capture", {})
      const rootJob = f.start(f.captures.get(handle.id)!)
      const child = handle.createGroup({ name: "children" }).spawn({ prompt: "capture", persistent: true })
      await until(() => child.state === "idle")
      const childJob = f.start(f.captures.get(child.id)!)
      const mainJob = f.start(f.main.backgroundJobs!)
      const other = await f.host.forOwner("other").openOrCreate(f.spec, f.runtime)
      await other.runTool("capture", {})
      const otherJob = f.start(f.captures.get(other.id)!)
      const stopAll = f.registry.stopAll.bind(f.registry)
      const hook = spyOn(f.registry, "stopAll").mockImplementation(async (which = () => true) => {
        if (failure === "throw") throw new Error("mock job shutdown failed")
        return failure === "omitted" ? [] : f.registry.running().filter(which)
      })
      let attempts = 0
      try {
        const released = releasing !== "none" ? handle.release() : undefined
        if (releasing === "completed") await released
        const owner = releasing === "completed" ? f.manager(true).forOwner("project") : f.owner
        await expect(owner.archive({ id: handle.id })).rejects.toThrow(/background|job|shutdown/i)
        await released
        attempts = hook.mock.calls.length
        expect(attempts).toBeGreaterThan(0)
        await expect(owner.read({ id: handle.id })).rejects.toThrow(/incomplete/i)
        await expect(f.manager().forOwner("project").archive({ id: handle.id })).rejects.toThrow(/in use/i)
        expect(f.registry.get(rootJob.id)?.status).toBe("running")
        expect(f.registry.get(childJob.id)?.status).toBe("running")
        hook.mockImplementation((which) => stopAll(which, 0))
        await owner.archive({ id: handle.id })
        expect(hook.mock.calls.length).toBeGreaterThan(attempts)
        expect(f.registry.get(rootJob.id)?.status).toBe("stopped")
        expect(f.registry.get(childJob.id)?.status).toBe("stopped")
        expect(f.registry.get(mainJob.id)?.status).toBe("running")
        expect(f.registry.get(otherJob.id)?.status).toBe("running")
        expect((await f.owner.read({ id: handle.id }))?.archived).toBe(true)
      } finally {
        hook.mockRestore()
      }
    })
  }
}

test("owner cleanup cannot release a retained lease taken over by a new owner's archive retry", async () => {
  const f = fixture()
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  await handle.runTool("capture", {})
  f.start(f.captures.get(handle.id)!)
  const failedStop = spyOn(f.registry, "stopAll").mockImplementation(async (which = () => true) =>
    f.registry.running().filter(which),
  )
  const manager = f.manager(true)
  const owner = manager.forOwner("project")
  try {
    await handle.release()
    await expect(owner.archive({ id: handle.id })).rejects.toThrow(/background jobs/)
  } finally {
    failedStop.mockRestore()
  }
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const closeRoot = f.jobs.closeRoot.bind(f.jobs)
  let calls = 0
  const hook = spyOn(f.jobs, "closeRoot").mockImplementation(async (root, grace) => {
    if (root === handle.id) await gates[calls++]?.promise
    return closeRoot(root, grace)
  })
  const cleanup = manager.releaseOwner("project")
  let retry: Promise<void> | undefined
  try {
    await until(() => calls === 1)
    const nextOwner = manager.forOwner("project")
    retry = nextOwner.archive({ id: handle.id })
    await until(() => calls === 2)
    gates[0]!.resolve()
    await cleanup
    gates[1]!.resolve()
    await retry
    await nextOwner.archive({ id: handle.id })
    expect((await nextOwner.read({ id: handle.id }))?.archived).toBe(true)
  } finally {
    for (const gate of gates) gate.resolve()
    await Promise.allSettled([cleanup, retry])
    hook.mockRestore()
  }
})
