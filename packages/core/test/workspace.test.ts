import { afterEach, expect, spyOn, test } from "bun:test"
import type { AnyEvent, ToolTraits, WorkspaceFacts, WorkspaceProvider } from "@amira/api"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"
import { workspaceFor } from "../src/workspace.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const off of cleanup.splice(0).reverse()) off()
})

async function until(check: () => boolean) {
  const deadline = performance.now() + 2000
  while (!check() && performance.now() < deadline) await Bun.sleep(5)
  expect(check()).toBe(true)
}

function setup(provider?: WorkspaceProvider) {
  const bus = new EventBus()
  const seen: AnyEvent[] = []
  bus.subscribe((e) => void seen.push(e))
  const host = new ExtensionHost({
    bus,
    cwd: "/work",
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  const tracker = workspaceFor(bus)
  if (provider)
    cleanup.push(
      tracker.register(provider, "test", (error) => {
        bus.emit("extension.error", { source: "test", error }, { sessionId: "host" })
      }),
    )
  cleanup.push(() => {
    host.unloadAll()
    bus.emit("session.end", { reason: "exit" }, { sessionId: "s" })
  })
  const start = (options = { initialDelayMs: 0 }) => cleanup.push(tracker.start("s", "/work", options))
  const turn = () => bus.emit("turn.end", { reason: "done", steps: 1 }, { sessionId: "s" })
  const tool = (traits?: ToolTraits, child = false) =>
    bus.emit(
      "tool.execute.end",
      {
        toolCallId: "t",
        name: "custom",
        result: { content: [] },
        durationMs: 1,
        traits,
      },
      child ? { sessionId: "child", parentSessionId: "s" } : { sessionId: "s" },
    )
  const workspace = () => seen.filter((e) => e.type === "workspace.changed")
  return { bus, host, tracker, start, turn, tool, seen, workspace }
}

test("initial probing waits 500 ms; the host stamps and deduplicates facts", async () => {
  let calls = 0
  let branch = "main"
  const f = setup({
    probe: async (cwd) => {
      calls++
      return { cwd, branch }
    },
  })
  const before = Date.now()
  f.bus.emit(
    "session.start",
    { cwd: "/work", reason: "startup", model: { provider: "mock", model: "m" } },
    { sessionId: "s" },
  )
  await f.bus.flush()
  await Bun.sleep(100)
  expect(calls).toBe(0)
  await until(() => f.workspace().length === 1)
  expect(f.workspace()[0]).toMatchObject({ sessionId: "s", data: { cwd: "/work", branch: "main" } })
  expect(f.workspace()[0]!.ts - before).toBeGreaterThanOrEqual(450)
  expect(f.workspace()[0]!.seq).toBeGreaterThan(1)
  expect(f.workspace()[0]!.turnId).toBeUndefined()
  f.turn()
  await until(() => calls === 2)
  await f.bus.flush()
  expect(f.workspace()).toHaveLength(1)
  branch = "next"
  f.turn()
  await until(() => f.workspace().length === 2)
})

test("only explicit writesFiles false skips dirty checks; child and unknown tools stay conservative", async () => {
  const kinds: (string | undefined)[] = []
  let dirty = false
  const f = setup({
    stamp: () => "same",
    probe: async (cwd, _signal, kind) => {
      kinds.push(kind)
      return { cwd, dirty }
    },
  })
  f.start()
  await until(() => f.workspace().length === 1)
  dirty = true
  f.tool({ writesFiles: false }, true)
  f.turn()
  await f.bus.flush()
  expect(kinds).toEqual(["full"])
  for (const [traits, child] of [
    [undefined, false],
    [{ readOnly: true }, false],
    [{ writesFiles: "paths" }, true],
  ] as const) {
    f.tool(traits, child)
    f.turn()
    await f.bus.flush()
  }
  expect(kinds).toEqual(["full", "dirty", "dirty", "dirty"])
  expect(f.workspace()).toHaveLength(2)
  expect(f.workspace()[1]!.data.dirty).toBe(true)
})

test("unchanged metadata rechecks external edits at 60 seconds; changed stamps force a full probe", async () => {
  const clock = spyOn(Date, "now")
  let now = 1000
  clock.mockImplementation(() => now)
  cleanup.push(() => clock.mockRestore())
  let stamp = "none"
  const kinds: (string | undefined)[] = []
  const f = setup({
    stamp: () => stamp,
    probe: async (cwd, _signal, kind) => {
      kinds.push(kind)
      return { cwd }
    },
  })
  f.start()
  await until(() => kinds.length === 1)
  now += 59_999
  f.turn()
  await f.bus.flush()
  expect(kinds).toEqual(["full"])
  now++
  f.turn()
  await f.bus.flush()
  expect(kinds).toEqual(["full", "dirty"])
  stamp = "appeared"
  f.turn()
  await f.bus.flush()
  expect(kinds).toEqual(["full", "dirty", "full"])
})

test("concurrent requests coalesce; a full probe wins over dirty requests", async () => {
  const pending: ((facts: WorkspaceFacts) => void)[] = []
  const kinds: (string | undefined)[] = []
  let stamp = "a"
  const f = setup({
    stamp: () => stamp,
    probe: (_cwd, _signal, kind) => {
      kinds.push(kind)
      return new Promise((resolve) => pending.push(resolve))
    },
  })
  f.start()
  await until(() => pending.length === 1)
  pending.shift()!({ cwd: "/work" })
  await until(() => f.workspace().length === 1)
  f.tool()
  f.turn()
  await f.bus.flush()
  expect(kinds).toEqual(["full", "dirty"])
  for (let i = 0; i < 5; i++) {
    f.tool()
    f.turn()
  }
  stamp = "b"
  f.turn()
  await f.bus.flush()
  expect(pending).toHaveLength(1)
  pending.shift()!({ cwd: "/work" })
  await until(() => kinds.length === 3)
  expect(kinds).toEqual(["full", "dirty", "full"])
  pending.shift()!({ cwd: "/work", branch: "new" })
  await until(() => f.workspace().length === 2)
})

test("session switches abort and drop stale results; child starts never replace the root", async () => {
  const pending: { cwd: string; signal: AbortSignal; resolve(facts: WorkspaceFacts): void }[] = []
  const f = setup({
    probe: (cwd, signal) => new Promise((resolve) => pending.push({ cwd, signal, resolve })),
  })
  f.start()
  await until(() => pending.length === 1)
  f.bus.emit(
    "session.start",
    { cwd: "/child", reason: "startup", model: { provider: "mock", model: "m" } },
    { sessionId: "child", parentSessionId: "s" },
  )
  await f.bus.flush()
  expect(pending[0]!.signal.aborted).toBe(false)
  f.bus.emit(
    "session.start",
    { cwd: "/next", reason: "resume", model: { provider: "mock", model: "m" } },
    { sessionId: "next" },
  )
  await f.bus.flush()
  expect(pending[0]!.signal.aborted).toBe(true)
  pending[0]!.resolve({ cwd: "/work", branch: "stale" })
  await until(() => pending.length === 2)
  pending[1]!.resolve({ cwd: "/next", branch: "current" })
  await until(() => f.workspace().length === 1)
  expect(f.workspace()[0]).toMatchObject({ sessionId: "next", data: { cwd: "/next", branch: "current" } })
  f.bus.emit("session.end", { reason: "exit" }, { sessionId: "next" })
  await f.bus.flush()
  expect(pending[1]!.signal.aborted).toBe(true)
})

test("no provider produces no events; late registration, unload and reload are safe", async () => {
  const f = setup()
  f.start()
  f.turn()
  await f.bus.flush()
  await Bun.sleep(20)
  expect(f.workspace()).toEqual([])
  let calls = 0
  const extension = (api: import("@amira/api").ExtensionAPI) => {
    api.registerWorkspaceProvider({
      probe: async (cwd) => {
        calls++
        return { cwd, branch: "main" }
      },
    })
  }
  expect(await f.host.load(extension, "provider")).toBe(true)
  await until(() => f.workspace().length === 1)
  expect(await f.host.load(extension, "duplicate")).toBe(false)
  await f.bus.flush()
  expect(f.seen.find((e) => e.type === "extension.error")?.data).toMatchObject({
    error: "Workspace provider is already registered by provider",
  })
  f.host.unload("provider")
  f.tool()
  f.turn()
  await f.bus.flush()
  expect(calls).toBe(1)
  expect(await f.host.load(extension, "provider")).toBe(true)
  await until(() => calls === 2)
  await f.bus.flush()
  expect(f.workspace()).toHaveLength(1)
})

test("unload cancels scheduled and in-flight probes, even if a provider ignores abort", async () => {
  const f = setup()
  let signal: AbortSignal | undefined
  let resolve!: (facts: WorkspaceFacts) => void
  await f.host.load((api) => {
    api.registerWorkspaceProvider({
      probe: (_cwd, s) => {
        signal = s
        return new Promise((r) => {
          resolve = r
        })
      },
    })
  }, "provider")
  f.start({ initialDelayMs: 30 })
  f.host.unload("provider")
  await Bun.sleep(50)
  expect(signal).toBeUndefined()
  await f.host.load((api) => {
    api.registerWorkspaceProvider({
      probe: (_cwd, s) => {
        signal = s
        return new Promise((r) => {
          resolve = r
        })
      },
    })
  }, "provider")
  await until(() => signal !== undefined)
  f.host.unload("provider")
  expect(signal!.aborted).toBe(true)
  resolve({ cwd: "/work", branch: "stale" })
  await f.bus.flush()
  expect(f.workspace()).toEqual([])
})

test("unavailable facts, provider errors and a mismatched cwd never emit invalid events", async () => {
  let mode = 0
  const f = setup({
    probe: async (cwd) => {
      if (mode === 0) return undefined
      if (mode === 1) throw new Error("offline")
      return { cwd: mode === 2 ? "/wrong" : cwd, branch: "ok" }
    },
  })
  f.start()
  await Bun.sleep(20)
  for (mode = 1; mode <= 2; mode++) {
    f.turn()
    await f.bus.flush()
  }
  expect(f.workspace()).toEqual([])
  expect(f.seen.filter((e) => e.type === "extension.error")).toHaveLength(2)
  f.turn()
  await until(() => f.workspace().length === 1)
})

test("a failed extension load releases its provider registration", async () => {
  const f = setup()
  const provider = { probe: async (cwd: string) => ({ cwd }) }
  expect(
    await f.host.load((api) => {
      api.registerWorkspaceProvider(provider)
      throw new Error("load failed")
    }, "bad"),
  ).toBe(false)
  expect(
    await f.host.load((api) => {
      api.registerWorkspaceProvider(provider)
    }, "good"),
  ).toBe(true)
})
