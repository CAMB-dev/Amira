import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { gitInfo, trackWorkspace } from "../src/git.ts"

// git is slow to start on Windows, especially under load.
setDefaultTimeout(60_000)

const dirs: string[] = []
async function tempDir() {
  const d = await mkdtemp(path.join(os.tmpdir(), "amira-git-"))
  dirs.push(d)
  return d
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function run(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" })
  expect(await p.exited).toBe(0)
}

async function repo(): Promise<string> {
  const d = await tempDir()
  await run(d, "init", "-q", "-b", "trunk")
  await run(
    d,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "x",
  )
  return d
}

test("a repository with commits reports root, branch and head with native separators", async () => {
  const d = await repo()
  const info = await gitInfo(d)
  expect(info.repoRoot).toBe(path.normalize(await import("node:fs/promises").then((fs) => fs.realpath(d))))
  expect(info.branch).toBe("trunk")
  expect(info.head).toMatch(/^[0-9a-f]{4,}$/)
  expect(info.isWorktree).toBe(false)
})

test("a repository without commits still reports root and branch", async () => {
  const d = await tempDir()
  await run(d, "init", "-q", "-b", "fresh")
  const info = await gitInfo(d)
  expect(info.repoRoot).toBeTruthy()
  expect(info.branch).toBe("fresh")
  expect(info.head).toBeUndefined()
})

test("detached HEAD omits branch but keeps head; linked worktrees are detected", async () => {
  const d = await repo()
  await run(d, "checkout", "-q", "--detach")
  const detached = await gitInfo(d)
  expect(detached.branch).toBeUndefined()
  expect(detached.head).toBeTruthy()

  const wt = path.join(await tempDir(), "wt")
  await run(d, "worktree", "add", "-q", "-b", "side", wt)
  const info = await gitInfo(wt)
  expect(info.isWorktree).toBe(true)
  expect(info.branch).toBe("side")
})

test("a directory outside any repository reports nothing", async () => {
  const d = await tempDir()
  // GIT_CEILING_DIRECTORIES keeps git from finding a repository above the temp dir.
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(d)
  try {
    expect(await gitInfo(d)).toEqual({})
  } finally {
    delete process.env.GIT_CEILING_DIRECTORIES
  }
})

test("trackWorkspace emits once in the background and again only on change", async () => {
  const d = await repo()
  const bus = new EventBus()
  const seen: AnyEvent[] = []
  bus.subscribe((e) => void seen.push(e), { types: ["workspace.changed"] })
  const stop = trackWorkspace(bus, "s", d)
  while (seen.length === 0) await Bun.sleep(20)
  bus.emit("turn.end", { reason: "done", steps: 0 }, { sessionId: "s" })
  await Bun.sleep(1500)
  expect(seen).toHaveLength(1)
  await run(d, "checkout", "-q", "-b", "next")
  bus.emit("turn.end", { reason: "done", steps: 0 }, { sessionId: "s" })
  while (seen.length < 2) await Bun.sleep(20)
  stop()
  expect((seen[1] as Extract<AnyEvent, { type: "workspace.changed" }>).data.branch).toBe("next")
}, 60_000)

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

async function nextWorkspace(bus: EventBus, seen: AnyEvent[], n: number) {
  bus.emit("turn.end", { reason: "done", steps: 0 }, { sessionId: "s" })
  const deadline = performance.now() + 30_000
  while (seen.length < n && performance.now() < deadline) await Bun.sleep(20)
}

test("trackWorkspace notices commits made in a linked worktree", async () => {
  const d = await repo()
  const wt = path.join(await tempDir(), "wt")
  await run(d, "worktree", "add", "-q", "-b", "side", wt)
  const bus = new EventBus()
  const seen: AnyEvent[] = []
  bus.subscribe((e) => void seen.push(e), { types: ["workspace.changed"] })
  const stop = trackWorkspace(bus, "s", wt, { initialDelayMs: 0 })
  while (seen.length === 0) await Bun.sleep(20)
  await Bun.sleep(20)
  await run(
    wt,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "y",
  )
  await nextWorkspace(bus, seen, 2)
  stop()
  expect(seen).toHaveLength(2)
  const [a, b] = seen as Extract<AnyEvent, { type: "workspace.changed" }>[]
  expect(b!.data.head).not.toBe(a!.data.head)
  expect(b!.data.isWorktree).toBe(true)
})

test("trackWorkspace picks up a repository created after startup", async () => {
  const d = await tempDir()
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(d)
  try {
    const bus = new EventBus()
    const seen: AnyEvent[] = []
    bus.subscribe((e) => void seen.push(e), { types: ["workspace.changed"] })
    const stop = trackWorkspace(bus, "s", d, { initialDelayMs: 0 })
    while (seen.length === 0) await Bun.sleep(20)
    expect((seen[0] as Extract<AnyEvent, { type: "workspace.changed" }>).data.branch).toBeUndefined()
    await run(d, "init", "-q", "-b", "later")
    await nextWorkspace(bus, seen, 2)
    stop()
    expect((seen[1] as Extract<AnyEvent, { type: "workspace.changed" }>).data.branch).toBe("later")
  } finally {
    delete process.env.GIT_CEILING_DIRECTORIES
  }
})

test("gitInfo says whether the working tree has changes when asked", async () => {
  const d = await repo()
  expect((await gitInfo(d)).dirty).toBeUndefined()
  expect((await gitInfo(d, 15_000, { dirty: true })).dirty).toBe(false)
  await writeFile(path.join(d, "new.txt"), "x")
  expect((await gitInfo(d, 15_000, { dirty: true })).dirty).toBe(true)
})

test("trackWorkspace checks for changes after a turn that ran a writing tool, not a reading one", async () => {
  const d = await repo()
  const bus = new EventBus()
  const seen: AnyEvent[] = []
  bus.subscribe((e) => void seen.push(e), { types: ["workspace.changed"] })
  const dirty = (i: number) => (seen[i] as Extract<AnyEvent, { type: "workspace.changed" }>).data.dirty
  const ran = (name: string, parentSessionId?: string) =>
    bus.emit(
      "tool.execute.end",
      { toolCallId: "t", name, result: { content: [] }, durationMs: 1 },
      { sessionId: parentSessionId ? "c" : "s", ...(parentSessionId ? { parentSessionId } : {}) },
    )
  const stop = trackWorkspace(bus, "s", d, { initialDelayMs: 0 })
  while (seen.length === 0) await Bun.sleep(20)
  expect(dirty(0)).toBe(false)
  // A turn that only read changed nothing: git does not run, so a file written meanwhile is not seen.
  await writeFile(path.join(d, "new.txt"), "x")
  ran("read")
  bus.emit("turn.end", { reason: "done", steps: 1 }, { sessionId: "s" })
  await Bun.sleep(1500)
  expect(seen).toHaveLength(1)
  // A tool that may write (a sub-agent's too) has the next turn end check.
  ran("write", "s")
  await nextWorkspace(bus, seen, 2)
  expect(dirty(1)).toBe(true)
  // A check that finds the same facts says nothing.
  ran("bash")
  bus.emit("turn.end", { reason: "done", steps: 1 }, { sessionId: "s" })
  await Bun.sleep(1500)
  expect(seen).toHaveLength(2)
  // Committing elsewhere shows at the next turn end, even one without tools.
  await run(d, "add", "-A")
  await run(
    d,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "y",
  )
  await nextWorkspace(bus, seen, 3)
  stop()
  expect(dirty(2)).toBe(false)
}, 60_000)
