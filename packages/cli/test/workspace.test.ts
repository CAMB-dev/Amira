import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent, Extension, WorkspaceFacts } from "@amira/api"
import { Agent, EventBus } from "@amira/core"
import agentExtension from "../../../extensions/agent/src/index.ts"
import statusExtension from "../../../extensions/status/src/index.ts"
import { createReloadReplay } from "../src/session/extension-loading.ts"
import { createSession } from "../src/session.ts"

const mockAi = () =>
  createAi({ dialects: [createMockDialect()], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })

async function until(check: () => boolean) {
  const deadline = performance.now() + 30_000
  while (!check() && performance.now() < deadline) await Bun.sleep(10)
  expect(check()).toBe(true)
}

test("the built-in agent supplies workspace events, while no-builtins leaves the host without a provider", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "amira-workspace-cli-"))
  try {
    for (const noBuiltins of [false, true]) {
      const session = await createSession({
        cwd,
        noBuiltins,
        extensions: [],
        ai: mockAi(),
        builtins: async () => [{ source: "builtin:agent", extension: agentExtension }],
      })
      const seen: AnyEvent[] = []
      session.agent.bus.subscribe((e) => void seen.push(e), { types: ["workspace.changed"] })
      try {
        await session.host.load(statusExtension, "test:status")
        session.agent.start("startup")
        if (noBuiltins) {
          await Bun.sleep(600)
          expect(seen).toEqual([])
        } else {
          await until(() => seen.length === 1)
          expect(seen[0]).toMatchObject({ sessionId: session.agent.sessionId, data: { cwd } })
        }
        expect(session.host.status.snapshot().find((i) => i.id === "place")?.text).toBe(path.basename(cwd))
      } finally {
        await session.agent.dispose("exit")
        session.host.unloadAll()
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}, 60_000)

test("reload replays the current workspace and replaces the provider without duplicate events", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "amira-workspace-reload-"))
  let probes = 0
  let branch = "main"
  const provider: Extension = (api) => {
    api.registerWorkspaceProvider({
      probe: async (cwd) => {
        probes++
        return { cwd, branch, dirty: true }
      },
    })
  }
  const session = await createSession({
    cwd,
    noBuiltins: false,
    extensions: [],
    ai: mockAi(),
    builtins: async () => [
      { source: "test:provider", extension: provider },
      { source: "builtin:status", extension: statusExtension },
    ],
  })
  const seen: AnyEvent[] = []
  session.agent.bus.subscribe((e) => void seen.push(e), { types: ["workspace.changed"] })
  const place = () => session.host.status.snapshot().find((i) => i.id === "place")?.text
  try {
    session.agent.start("startup")
    await until(() => seen.length === 1)
    expect(place()).toBe("main*")
    expect((await session.reload()).failed).toEqual([])
    await session.agent.bus.flush()
    expect(place()).toBe("main*")
    await until(() => probes === 2)
    await session.agent.bus.flush()
    expect(seen).toHaveLength(1)
    branch = "next"
    session.agent.bus.emit("turn.end", { reason: "done", steps: 0 }, { sessionId: session.agent.sessionId })
    await until(() => seen.length === 2)
    expect(place()).toBe("next*")
  } finally {
    await session.agent.dispose("exit")
    session.host.unloadAll()
    await rm(cwd, { recursive: true, force: true })
  }
})

test("reload never replays workspace facts from the previous top-level session", async () => {
  const ai = mockAi()
  const bus = new EventBus()
  const replay = createReloadReplay(bus)
  const old = new Agent({ ai, model: ai.model("mock/m"), cwd: "/old", bus })
  old.start("startup")
  bus.emit("workspace.changed", { cwd: "/old", branch: "old" }, { sessionId: old.sessionId })
  const current = new Agent({ ai, model: ai.model("mock/m"), cwd: "/new", bus })
  current.start("resume")
  await bus.flush()
  expect(replay(current).filter((e) => e.type === "workspace.changed")).toEqual([])
  // Even a late foreign event must not get replayed into the new session.
  const facts: WorkspaceFacts = { cwd: "/old", branch: "stale" }
  bus.emit("workspace.changed", facts, { sessionId: old.sessionId })
  await bus.flush()
  expect(replay(current).filter((e) => e.type === "workspace.changed")).toEqual([])
})
