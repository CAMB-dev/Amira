import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { gitInfo, trackWorkspace } from "../src/git.ts"
import { workspaceFor } from "../src/workspace.ts"

test("Agent.start cannot be tricked into overriding cwd and carries no turn id", async () => {
  const ai = createAi({
    dialects: [createMockDialect()],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const bus = new EventBus()
  const seen: AnyEvent[] = []
  bus.subscribe((e) => void seen.push(e))
  const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/real", systemPrompt: "", bus })
  const extra = { cwd: "/fake", resume: ["amira", "--resume", agent.sessionId] }
  agent.start("startup", extra as never)
  await bus.flush()
  const ev = seen[0] as Extract<AnyEvent, { type: "session.start" }>
  expect(ev.data.cwd).toBe("/real")
  expect(ev.data.resume).toEqual(["amira", "--resume", agent.sessionId])
  expect(ev.turnId).toBeUndefined()
  expect(ev.sessionId).toBe(agent.sessionId)
})

test("deprecated gitInfo still probes git standalone, without any provider", async () => {
  const d = await mkdtemp(path.join(tmpdir(), "amira-gitinfo-"))
  try {
    expect(await gitInfo(d)).toEqual({})
    const sh = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: d })
    sh("init", "-q", "-b", "main")
    const info = await gitInfo(d, 15_000, { dirty: true })
    expect(info).toMatchObject({ branch: "main", isWorktree: false, dirty: false })
    expect(info.repoRoot && path.resolve(info.repoRoot)).toBe(await realpath(d))
    await writeFile(path.join(d, "a.txt"), "x")
    expect((await gitInfo(d, 15_000, { dirty: true })).dirty).toBe(true)
    expect((await gitInfo(d)).dirty).toBeUndefined()
  } finally {
    await rm(d, { recursive: true, force: true })
  }
}, 30_000)

test("deprecated trackWorkspace starts the bus's host tracker, which emits from its provider", async () => {
  const bus = new EventBus()
  const seen: AnyEvent[] = []
  bus.subscribe((e) => void seen.push(e), { types: ["workspace.changed"] })
  const cwd = "/compatibility-test"
  const unregister = workspaceFor(bus).register(
    { probe: async (cwd) => ({ cwd, branch: "main", dirty: true }) },
    "test",
    () => {},
  )
  const stop = trackWorkspace(bus, "s", cwd, { initialDelayMs: 0 })
  try {
    const deadline = performance.now() + 2000
    while (!seen.length && performance.now() < deadline) await Bun.sleep(5)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ sessionId: "s", data: { cwd, branch: "main", dirty: true } })
  } finally {
    stop()
    unregister()
  }
})
