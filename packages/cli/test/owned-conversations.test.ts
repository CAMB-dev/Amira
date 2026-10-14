import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import type { AnyEvent, Extension, ExtensionAPI, OwnedConversation, OwnedConversations } from "@amira/api"
import { SessionStore } from "@amira/core"
import { createCommandHost } from "../src/control.ts"
import { createSession } from "../src/session.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function setup(steps: MockStep[], extension?: Extension) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-cli-owned-"))
  const home = path.join(dir, "home")
  const oldHome = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = home
  cleanup.push(async () => {
    if (oldHome === undefined) delete process.env.AMIRA_HOME
    else process.env.AMIRA_HOME = oldHome
    await rm(dir, { recursive: true, force: true })
  })
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  let api!: ExtensionAPI
  const session = await createSession({
    ai,
    model: "mock/main",
    cwd: dir,
    extensions: [],
    noBuiltins: false,
    store: SessionStore.create({ cwd: dir, dir: path.join(dir, "main") }),
    builtins: async () => [
      {
        source: "test:owner",
        extension: async (a) => {
          api = a
          await extension?.(a)
        },
      },
    ],
  })
  const commands = createCommandHost({ session, cwd: dir })
  cleanup.push(async () => {
    await session.host.runExitHandlers()
    await commands.agent.dispose()
  })
  const spec = { key: "design", name: "Design", cwd: dir, systemPrompt: "Research", callableTools: [] }
  const runtime = { askUser: async () => undefined }
  return { session, commands, mock, api, spec, runtime, dir }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for owned conversation")
    await Bun.sleep(2)
  }
}

for (const change of ["clear", "resume", "rewind", "fork"] as const) {
  test(`main ${change} cannot stop or retarget an owned conversation`, async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { session, commands, mock, api, spec, runtime } = await setup([
      { text: "main before" },
      { text: "owned answer", hold: { chunks: 0, until: gate }, usage: { input: 7, output: 3 } },
      { text: "main after" },
      { text: "owned again" },
    ])
    const owned = await api.conversations!.openOrCreate(spec, runtime)
    await commands.control.send("main before")
    const mainId = commands.agent.sessionId
    const mainEvents: AnyEvent[] = []
    commands.agent.bus.subscribe((event) => void mainEvents.push(event))
    const sending = owned.send("owned before switch")
    await until(() => mock.requests.length === 2)
    expect(owned.status().busy).toBe(true)
    if (change === "clear") await commands.control.newSession!()
    if (change === "resume") {
      await commands.control.newSession!()
      await commands.control.resume!(mainId)
    }
    if (change === "rewind") await commands.control.rewind!(0, { restoreFiles: false })
    if (change === "fork") await commands.control.fork!()
    expect(owned.status().busy).toBe(true)
    owned.data.append("test.bound", { mainId })
    await commands.control.send("main after switch")
    release()
    await sending
    await owned.send("owned next turn")
    expect(owned.id).not.toBe(commands.agent.sessionId)
    expect(owned.data.read("test.bound")).toEqual([{ mainId }])
    expect(commands.control.data!.read("test.bound")).toEqual([])
    expect(
      owned
        .history()
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual([[{ type: "text", text: "owned before switch" }], [{ type: "text", text: "owned next turn" }]])
    await commands.agent.bus.flush()
    expect(mainEvents.some((event) => event.sessionId === owned.id)).toBe(false)
    expect(session.tree.usage).toMatchObject({ input: 7, output: 3 })
    expect(commands.control.sessions!().some((saved) => saved.id === owned.id)).toBe(false)
  })
}

test("owner unload drains work and releases its lease without stopping main children", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { session, commands, api, spec, runtime, mock } = await setup([
    { text: "main child ready" },
    { text: "interrupted owned", hold: { chunks: 0, until: gate } },
    { text: "main child continued" },
  ])
  const child = session.tree.spawn(commands.agent, { prompt: "main child", persistent: true })
  await until(() => child.state === "idle")
  const owned = await api.conversations!.openOrCreate(spec, runtime)
  const sending = owned.send("owned working")
  await until(() => mock.requests.length === 2)
  expect(session.host.unload("test:owner")).toBe(true)
  let drained = false
  const draining = session.host.drain().then(() => {
    drained = true
  })
  await Bun.sleep(10)
  expect(drained).toBe(false)
  release()
  await draining
  await sending
  expect(child.state).toBe("idle")
  expect(child.send("continue main child")).toBe(true)
  await until(() => child.turns === 2 && child.state === "idle")
  await expect(owned.send("released")).rejects.toThrow("released")
  release()
  let reopened!: OwnedConversation
  expect(
    await session.host.load(async (a) => {
      reopened = await a.conversations!.openOrCreate(spec, runtime)
    }, "test:owner"),
  ).toBe(true)
  expect(reopened.id).toBe(owned.id)
  expect(reopened.status().busy).toBe(false)
})

test("failed extension startup rolls back conversations and reload awaits owner cleanup", async () => {
  let failed!: OwnedConversation
  let stale!: OwnedConversations
  const { session, api, spec, runtime, mock } = await setup([])
  expect(
    await session.host.load(async (a) => {
      stale = a.conversations!
      failed = await stale.openOrCreate({ ...spec, key: "partial" }, runtime)
      throw new Error("partial load")
    }, "test:partial"),
  ).toBe(false)
  await expect(failed.send("released")).rejects.toThrow("released")
  await expect(stale.openOrCreate(spec, runtime)).rejects.toThrow()
  let fresh!: OwnedConversation
  expect(
    await session.host.load(async (a) => {
      fresh = await a.conversations!.openOrCreate({ ...spec, key: "partial" }, runtime)
    }, "test:partial"),
  ).toBe(true)
  expect(fresh.id).toBe(failed.id)
  const owned = await api.conversations!.openOrCreate(spec, runtime)
  expect((await session.reload()).failed).toEqual([])
  await expect(owned.send("released by reload")).rejects.toThrow("released")
  expect(mock.requests).toHaveLength(0)
})

test("generic store resume refuses owned history before a destructive switch callback", async () => {
  const { session, api, spec, runtime } = await setup([])
  const handle = await api.conversations!.openOrCreate(spec, runtime)
  await handle.release()
  const directory = path.join(process.env.AMIRA_HOME!, "owned-conversations")
  const files = await readdir(directory, { recursive: true })
  const file = files.find((entry) => entry.endsWith(`${handle.id}.jsonl`))
  if (!file) throw new Error("missing owned history fixture")
  const store = SessionStore.open(path.join(directory, file))
  let switched = false
  expect(() =>
    session.resume(store, session.agent.model, (construct) => {
      switched = true
      return construct()
    }),
  ).toThrow("owned conversation")
  expect(switched).toBe(false)
  expect(session.agent.status).toBe("idle")
  expect(() => store.fork()).toThrow("owned conversation")
})
