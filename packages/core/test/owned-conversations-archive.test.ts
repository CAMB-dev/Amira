import { afterEach, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import {
  type ConversationSpec,
  defineTool,
  type OwnedConversation,
  type OwnedConversationRef,
  type SpawnGroup,
  type ToolContext,
  type ToolSession,
  textResult,
} from "@amira/api"
import {
  SPAWN_TEST_TIMEOUT_MS,
  stopSpawn,
  waitForSpawnCondition,
  waitForSpawnExit,
  waitForSpawnWork,
} from "../../../scripts/spawn-test.ts"
import { Agent } from "../src/agent.ts"
import { ArtifactStore } from "../src/artifacts.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { ownedDirectory } from "../src/owned-conversations-storage.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture(steps: MockStep[] = [], aliasHome = false) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "amira-owned-archive-"))
  const home = aliasHome ? path.join(directory, "alias") : directory
  if (aliasHome) {
    const target = path.join(directory, "target")
    fs.mkdirSync(target)
    fs.symlinkSync(target, home, process.platform === "win32" ? "junction" : "dir")
  }
  const cwd = path.join(home, "worktree")
  fs.mkdirSync(cwd)
  const mock = createMockDialect(steps)
  const signals: AbortSignal[] = []
  const ai = createAi({
    dialects: [
      {
        ...mock,
        async *stream(request, context) {
          signals.push(context.signal)
          yield* mock.stream(request, context)
        },
      },
    ],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const tools = new ToolRegistry()
  const tree = new AgentTree({ ai, sections: () => [], maxConcurrent: 8 })
  const main = new Agent({ ai, model: ai.model("mock/test"), cwd, tools, tree, sections: [] })
  const managers: OwnedConversationManager[] = []
  const manager = () => {
    const value = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
    managers.push(value)
    return value
  }
  cleanups.push(async () => {
    for (const value of managers) await value.drain()
    await main.dispose()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const host = manager()
  const owner = host.forOwner("project")
  const spec: ConversationSpec = {
    key: "project/design",
    name: "Design",
    cwd,
    model: "mock/test",
    systemPrompt: "Research only.",
    callableTools: [],
  }
  const runtime = { askUser: async () => undefined }
  return { home, cwd, mock, signals, ai, tools, tree, main, manager, host, owner, spec, runtime }
}

const inactive = /archiv|releas|stopp|ended|cancel|abort/i
const incomplete = /archiv.*incomplete|incomplete.*archiv/i

async function rejectsIncomplete(operation: Promise<unknown>) {
  // A lifecycle mutation must reject, not queue behind the deliberately held drain.
  await expect(waitForSpawnWork("archive-incomplete rejection", operation, 1000)).rejects.toThrow(incomplete)
}

async function rejectsExecution(handle: OwnedConversation, group: SpawnGroup) {
  await expect(handle.send("stale send")).rejects.toThrow(inactive)
  await expect(handle.runTool("hold", {})).rejects.toThrow(inactive)
  await expect(handle.complete({ messages: [] })).rejects.toThrow(inactive)
  expect(() => handle.createGroup({ name: "stale group" })).toThrow(inactive)
  expect(() => group.spawn({ prompt: "stale group child", persistent: true })).toThrow(inactive)
  expect(() => handle.data.append("project.state", { stale: true })).toThrow(inactive)
}

async function until(check: () => boolean) {
  const deadline = performance.now() + 3000
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("archive fixture did not reach its gate")
    await Bun.sleep(2)
  }
}

test("archive is durable and idempotent by id or key; restore is inert and does not revive stale authority", async () => {
  const f = fixture([
    { text: "saved answer", usage: { input: 10, output: 2, cost: 0.25 } },
    { text: "explicit continuation" },
  ])
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  const group = handle.createGroup({ name: "retained group" })
  await handle.send("remember this design")
  const before = await f.owner.read({ id: handle.id })
  if (!before) throw new Error("missing live snapshot")
  expect(before.archived).toBe(false)
  await f.owner.archive({ key: handle.key })
  await f.owner.archive({ id: handle.id })
  const archived = await f.owner.read({ id: handle.id })
  expect(archived).toEqual({ ...before, archived: true })
  expect(Object.isFrozen(archived)).toBe(true)
  expect(Object.isFrozen(archived?.history[0]?.content)).toBe(true)
  expect(Object.isFrozen(archived?.usage.own.usage)).toBe(true)
  await rejectsExecution(handle, group)
  await expect(f.owner.open(handle.id, f.runtime)).rejects.toThrow(/archiv/i)
  await expect(f.owner.openOrCreate(f.spec, f.runtime)).rejects.toThrow(/archiv/i)

  await f.host.drain()
  const restarted = f.manager().forOwner("project")
  expect(await restarted.read({ key: handle.key })).toEqual(archived)
  await expect(restarted.open(handle.id, f.runtime)).rejects.toThrow(/archiv/i)
  await expect(restarted.openOrCreate(f.spec, f.runtime)).rejects.toThrow(/archiv/i)
  await restarted.archive({ id: handle.id })
  await restarted.unarchive({ key: handle.key })
  await restarted.unarchive({ id: handle.id })
  expect(await restarted.read({ id: handle.id })).toEqual(before)
  await rejectsExecution(handle, group)
  expect(f.mock.requests).toHaveLength(1)

  const restored = await restarted.openOrCreate(f.spec, f.runtime)
  expect(restored.id).toBe(handle.id)
  expect(restored).not.toBe(handle)
  expect(restored.history()).toEqual(before.history)
  expect(f.mock.requests).toHaveLength(1)
  await restored.send("continue explicitly")
  expect(f.mock.requests).toHaveLength(2)
  expect(f.main.messages).toEqual([])
})

test("idle event iterators close before archive flush, and stale release cannot forget a replacement", async () => {
  const f = fixture()
  const old = await f.owner.openOrCreate(f.spec, f.runtime)
  const iterator = old.events[Symbol.asyncIterator]()
  await f.owner.archive({ id: old.id })
  expect((await iterator.next()).done).toBe(true)
  await f.owner.unarchive({ id: old.id })
  const replacement = await f.owner.open(old.id, f.runtime)
  await old.release()
  expect(await f.owner.open(old.id, f.runtime)).toBe(replacement)
  await f.owner.archive({ id: old.id })
  await expect(replacement.send("revoked replacement")).rejects.toThrow(inactive)
  expect((await f.owner.read({ id: old.id }))?.archived).toBe(true)
})

for (const first of ["archive", "release"] as const) {
  test(`concurrent archive and release retain the lease through publication (${first} first)`, async () => {
    const f = fixture()
    const handle = await f.owner.openOrCreate(f.spec, f.runtime)
    const firstOperation = first === "archive" ? f.owner.archive({ id: handle.id }) : handle.release()
    await Promise.all([
      firstOperation,
      first === "archive" ? handle.release() : f.owner.archive({ id: handle.id }),
    ])
    expect((await f.owner.read({ id: handle.id }))?.archived).toBe(true)
    await expect(f.owner.open(handle.id, f.runtime)).rejects.toThrow(/archiv/i)
  })
}

test("archived reads and lifecycle changes need neither the former model, runtime nor cwd", async () => {
  const f = fixture([{ text: "saved answer", usage: { cost: 0.2 } }])
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  await handle.send("save")
  await f.owner.archive({ id: handle.id })
  const before = await f.owner.read({ id: handle.id })
  if (!before) throw new Error("missing archived snapshot")
  await f.host.drain()
  fs.rmSync(f.cwd, { recursive: true })
  const ai = createAi({ dialects: [], providers: [] })
  const reader = new OwnedConversationManager({
    ai,
    tree: new AgentTree({ ai, sections: () => [] }),
    tools: new ToolRegistry(),
    home: f.home,
    agent: () => {
      throw new Error("historical lifecycle must not obtain a runtime agent")
    },
  })
  cleanups.push(() => reader.drain())
  const owner = reader.forOwner("project")
  const directory = ownedDirectory(f.home, "project")
  const files = () =>
    fs
      .readdirSync(directory, { recursive: true, encoding: "utf8" })
      .filter((name) => fs.statSync(path.join(directory, name)).isFile())
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(directory, name), "utf8")])
  const evidence = files()
  expect(await owner.read({ key: handle.key })).toEqual(before)
  expect(await owner.read({ id: handle.id })).toEqual(before)
  expect(files()).toEqual(evidence)
  await expect(owner.open(handle.id, f.runtime)).rejects.toThrow()
  await expect(owner.openOrCreate(f.spec, f.runtime)).rejects.toThrow()
  expect(files()).toEqual(evidence)
  await owner.archive({ key: handle.key })
  await owner.unarchive({ id: handle.id })
  expect(await owner.read({ key: handle.key })).toEqual({ ...before, archived: false })
  expect(fs.existsSync(f.cwd)).toBe(false)
  expect(f.mock.requests).toHaveLength(1)
})

for (const action of ["archive", "unarchive"] as const) {
  test(`${action} rejects foreign, invalid and missing refs without changing another owner's lifecycle`, async () => {
    const f = fixture()
    const handle = await f.owner.openOrCreate(f.spec, f.runtime)
    if (action === "unarchive") await f.owner.archive({ id: handle.id })
    const before = await f.owner.read({ id: handle.id })
    const foreign = f.host.forOwner("other")
    await expect(foreign[action]({ id: handle.id })).rejects.toThrow(/owner/i)
    await expect(foreign[action]({ key: handle.key })).rejects.toThrow(/missing|not found/i)
    await expect(f.owner[action]({ key: "missing" })).rejects.toThrow(/missing|not found/i)
    await expect(f.owner[action]({ id: `s_${"0".repeat(32)}` })).rejects.toThrow(/missing|not found/i)
    for (const ref of [
      { id: "../../escape" },
      { key: "" },
      { key: "bad\0key" },
      { id: handle.id, key: handle.key },
    ]) {
      await expect(f.owner[action](ref as OwnedConversationRef)).rejects.toThrow(/invalid/i)
    }
    expect(await f.owner.read({ id: handle.id })).toEqual(before)
    expect(f.mock.requests).toHaveLength(0)
  })
}

for (const source of ["send", "runTool"] as const) {
  test(`archive fences captured ${source} capabilities before physical drain and publishes only afterwards`, async () => {
    const f = fixture(source === "send" ? [{ toolCalls: [{ name: "hold", args: {} }] }] : [])
    const entered = Promise.withResolvers<ToolContext>()
    const finish = Promise.withResolvers<void>()
    f.tools.register(
      defineTool({
        name: "hold",
        description: "Hold a tool while archive drains",
        parameters: { type: "object" },
        traits: { readOnly: true },
        execute: async (_args, context) => {
          entered.resolve(context)
          // A non-cooperative tool must drain before archive acknowledges completion.
          await finish.promise
          return textResult("finished")
        },
      }),
      "test",
    )
    const handle = await f.owner.openOrCreate({ ...f.spec, callableTools: ["hold"] }, f.runtime)
    const group = handle.createGroup({ name: "retained handle group" })
    const running = (source === "send" ? handle.send("hold") : handle.runTool("hold", {})).catch(
      (error: unknown) => error,
    )
    const context = await entered.promise
    const session = context.session!
    const toolGroup = session.createGroup!({ name: "retained tool group" })
    const reader = f.manager().forOwner("project")
    let settled = false
    const archiving = f.owner.archive({ id: handle.id }).finally(() => {
      settled = true
    })
    // Attach an error observer before any assertion can interrupt cleanup.
    const outcome = archiving.then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      await until(() => context.signal.aborted)
      expect(settled).toBe(false)
      await expect(f.owner.read({ id: handle.id })).rejects.toThrow(incomplete)
      await expect(reader.read({ key: handle.key })).rejects.toThrow(incomplete)
      await rejectsIncomplete(f.owner.unarchive({ id: handle.id }))
      await rejectsIncomplete(reader.unarchive({ key: handle.key }))
      await expect(f.owner.open(handle.id, f.runtime)).rejects.toThrow(/archiv|lifecycle/i)
      await expect(f.owner.openOrCreate({ ...f.spec, callableTools: ["hold"] }, f.runtime)).rejects.toThrow(
        /archiv|lifecycle/i,
      )
      await rejectsExecution(handle, group)
      expect(() => session.data!.append("late", "during archive")).toThrow(inactive)
      expect(() => session.loadTools([])).toThrow(inactive)
      expect(() => session.expectNotice!()).toThrow(inactive)
      expect(() => session.spawn!({ prompt: "stale tool child", persistent: true })).toThrow(inactive)
      expect(() => session.createGroup!({ name: "stale tool group" })).toThrow(inactive)
      expect(() => toolGroup.spawn({ prompt: "stale captured group child" })).toThrow(inactive)
      expect(f.mock.requests).toHaveLength(source === "send" ? 1 : 0)
    } finally {
      finish.resolve()
      await running
      await outcome
    }
    const error = await outcome
    if (error) throw error
    expect((await f.owner.read({ id: handle.id }))?.archived).toBe(true)
    expect(() => session.data!.append("late", "after archive")).toThrow(inactive)
    expect(() => session.loadTools([])).toThrow(inactive)
    await f.owner.unarchive({ id: handle.id })
    await rejectsExecution(handle, group)
    expect(() => session.data!.append("late", "after unarchive")).toThrow(inactive)
    expect(() => session.loadTools([])).toThrow(inactive)
    expect(() => session.expectNotice!()).toThrow(inactive)
    expect(() => session.spawn!({ prompt: "restored stale tool child" })).toThrow(inactive)
    expect(() => session.createGroup!({ name: "restored stale tool group" })).toThrow(inactive)
    expect(() => toolGroup.spawn({ prompt: "restored stale group child" })).toThrow(inactive)
  })
}

test("archive physically drains completion and retains late-abort accounting before publication", async () => {
  const finish = Promise.withResolvers<void>()
  const f = fixture([
    { text: "streaming", hold: { chunks: 1, until: finish.promise }, usage: { input: 9, cost: 0.4 } },
  ])
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  const running = handle.complete({ messages: [] }).catch((error: unknown) => error)
  let archiving: Promise<void> | undefined
  let settled = false
  try {
    await until(() => f.mock.requests.length === 1)
    archiving = f.owner.archive({ id: handle.id }).then(() => {
      settled = true
    })
    await until(() => f.signals[0]?.aborted === true)
    expect(settled).toBe(false)
    await expect(f.owner.read({ id: handle.id })).rejects.toThrow(incomplete)
    await rejectsIncomplete(f.owner.unarchive({ id: handle.id }))
  } finally {
    finish.resolve()
    await running
    await archiving
  }
  const saved = await f.owner.read({ id: handle.id })
  expect(saved?.archived).toBe(true)
  expect(saved?.history).toEqual([])
  expect(saved?.usage.own.knownCostUsd).toBe(0.4)
  expect(f.mock.requests).toHaveLength(1)
})

for (const ephemeral of [false, true]) {
  test(`archive drains ${ephemeral ? "private" : "ordinary"} descendants and cancels questions without restore replay`, async () => {
    const f = fixture([{ toolCalls: [{ name: "ask_user", args: {} }] }, { text: "explicit turn" }])
    const asked = Promise.withResolvers<AbortSignal>()
    let questions = 0
    f.tools.register(
      defineTool({
        name: "ask_user",
        description: "Ask the owner",
        parameters: { type: "object" },
        execute: async (_args, context) => {
          await context.session!.askUser!(
            [{ question: "Choose?", options: [{ label: "A" }] }],
            context.signal,
          )
          return textResult("answered")
        },
      }),
      "test",
    )
    const runtime = {
      askUser: async (_questions: unknown, context: { signal: AbortSignal }) => {
        questions++
        asked.resolve(context.signal)
        return new Promise<undefined>(() => {})
      },
    }
    const spec = { ...f.spec, callableTools: ["ask_user"] }
    const handle = await f.owner.openOrCreate(spec, runtime)
    const group = handle.createGroup({ name: "research" })
    const child = group.spawn({ prompt: "ask me", persistent: true, ephemeral })
    const signal = await asked.promise
    await f.owner.archive({ id: handle.id })
    expect(signal.aborted).toBe(true)
    expect((await child.result()).status).toBe("aborted")
    expect((await group.ended()).state).toBe("ended")
    expect(child.send("stale child message")).toBe(false)
    expect((await f.owner.read({ id: handle.id }))?.archived).toBe(true)
    await f.owner.unarchive({ key: handle.key })
    const restored = await f.owner.open(handle.id, runtime)
    expect(restored.status().busy).toBe(false)
    expect(restored.history()).toEqual([])
    expect(questions).toBe(1)
    expect(f.mock.requests).toHaveLength(1)
    expect(child.send("restore must not revive the child")).toBe(false)
    await rejectsExecution(handle, group)
    await restored.send("continue explicitly")
    expect(f.mock.requests).toHaveLength(2)
    expect(questions).toBe(1)
  })
}

test("failed disposal leaves a visible incomplete archive and a durable fence until archive retry finalizes", async () => {
  const f = fixture()
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  const group = handle.createGroup({ name: "retained group" })
  const dispose = Agent.prototype.dispose
  let fail = true
  const hook = spyOn(Agent.prototype, "dispose").mockImplementation(function (
    this: Agent,
    ...args: Parameters<Agent["dispose"]>
  ) {
    if (this.sessionId === handle.id && fail) return Promise.reject(new Error("archive drain failed"))
    return dispose.apply(this, args)
  })
  try {
    await expect(f.owner.archive({ id: handle.id })).rejects.toThrow("archive drain failed")
    await expect(f.owner.read({ key: handle.key })).rejects.toThrow(incomplete)
    const restarted = f.manager().forOwner("project")
    await expect(restarted.read({ id: handle.id })).rejects.toThrow(incomplete)
    await expect(restarted.open(handle.id, f.runtime)).rejects.toThrow(/archiv/i)
    await expect(restarted.openOrCreate(f.spec, f.runtime)).rejects.toThrow(/archiv/i)
    await expect(f.owner.unarchive({ key: handle.key })).rejects.toThrow(incomplete)
    await expect(restarted.unarchive({ id: handle.id })).rejects.toThrow(incomplete)
    await rejectsExecution(handle, group)
    fail = false
    await f.owner.archive({ id: handle.id })
    expect((await restarted.read({ key: handle.key }))?.archived).toBe(true)
    await restarted.unarchive({ id: handle.id })
    const restored = await restarted.open(handle.id, f.runtime)
    expect(restored.id).toBe(handle.id)
    expect(f.mock.requests).toHaveLength(0)
  } finally {
    fail = false
    hook.mockRestore()
  }
})

for (const opening of ["open", "openOrCreate"] as const) {
  for (const first of ["open", "archive"] as const) {
    test(`${opening} racing archive (${first} first) cannot retain executable authority`, async () => {
      const f = fixture()
      const old = await f.owner.openOrCreate(f.spec, f.runtime)
      await old.release()
      const open = () =>
        opening === "open" ? f.owner.open(old.id, f.runtime) : f.owner.openOrCreate(f.spec, f.runtime)
      const archiving = first === "archive" ? f.owner.archive({ id: old.id }) : undefined
      const pending = open().then(
        (handle) => ({ handle }),
        (error: unknown) => ({ error }),
      )
      await (archiving ?? f.owner.archive({ id: old.id }))
      const result = await pending
      if ("handle" in result) await expect(result.handle.send("race loser")).rejects.toThrow(inactive)
      else expect(String(result.error)).toMatch(/archiv|abort|cancel|lifecycle/i)
      expect((await f.owner.read({ key: old.key }))?.archived).toBe(true)
      await expect(open()).rejects.toThrow(/archiv/i)
      expect(f.mock.requests).toHaveLength(0)
    })
  }
}

test("archiving one conversation does not cancel main, another owner or its same-owner sibling", async () => {
  const finish = Promise.withResolvers<void>()
  const f = fixture([
    { text: "main streaming reply", hold: { chunks: 1, until: finish.promise } },
    { text: "other streaming reply", hold: { chunks: 1, until: finish.promise } },
    { text: "sibling streaming reply", hold: { chunks: 1, until: finish.promise } },
    { text: "other continues" },
    { text: "sibling continues" },
  ])
  const target = await f.owner.openOrCreate(f.spec, f.runtime)
  const otherOwner = f.host.forOwner("other")
  const other = await otherOwner.openOrCreate(f.spec, f.runtime)
  const sibling = await f.owner.openOrCreate({ ...f.spec, key: "project/review" }, f.runtime)
  const mainTurn = f.tree.runRoot(f.main, () => f.main.prompt("main work"), new AbortController().signal)
  await until(() => f.mock.requests.length === 1)
  const otherTurn = other.send("other work")
  await until(() => f.mock.requests.length === 2)
  const siblingTurn = sibling.send("sibling work")
  try {
    await until(() => f.mock.requests.length === 3)
    await f.owner.archive({ id: target.id })
    expect(f.main.busy).toBe(true)
    expect(other.status().busy).toBe(true)
    expect(sibling.status().busy).toBe(true)
    expect(f.signals.every((signal) => !signal.aborted)).toBe(true)
    expect((await otherOwner.read({ id: other.id }))?.archived).toBe(false)
    expect((await f.owner.read({ id: sibling.id }))?.archived).toBe(false)
  } finally {
    finish.resolve()
    await Promise.all([mainTurn, otherTurn, siblingTurn])
  }
  await other.send("continue other")
  await sibling.send("continue sibling")
  expect(f.mock.requests).toHaveLength(5)
})

function spawnWorker(home: string, mode: string, id?: string) {
  return Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "owned-conversations-archive-worker.ts"),
      home,
      mode,
      ...(id ? [id] : []),
    ],
    {
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: { ...process.env, HOME: home, USERPROFILE: home, AMIRA_HOME: path.join(home, ".amira") },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
}

async function archiveInWorker(home: string, id: string) {
  const worker = spawnWorker(home, "archive", id)
  try {
    const [stdout, stderr, code] = await waitForSpawnWork(
      "archive worker output",
      Promise.all([
        new Response(worker.stdout).text(),
        new Response(worker.stderr).text(),
        waitForSpawnExit(worker, "archive worker"),
      ]),
    )
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    return JSON.parse(stdout)
  } finally {
    await stopSpawn(worker, "archive worker cleanup")
  }
}

test(
  "a subprocess archive conflicts with the live writer without fencing it, then persists after release",
  async () => {
    const f = fixture([{ text: "writer remains usable" }])
    const handle = await f.owner.openOrCreate(f.spec, f.runtime)
    const conflict = await archiveInWorker(f.home, handle.id)
    expect(conflict.error).toMatch(/in use|writer|lease|conflict/i)
    expect(conflict.requests).toBe(0)
    expect((await f.owner.read({ id: handle.id }))?.archived).toBe(false)
    await handle.send("still writable")
    const history = handle.history()
    await handle.release()
    expect(await archiveInWorker(f.home, handle.id)).toEqual({ archived: true, requests: 0 })
    expect((await f.owner.read({ id: handle.id }))?.history).toEqual(history)
    await expect(f.owner.open(handle.id, f.runtime)).rejects.toThrow(/archiv/i)
    await expect(f.owner.openOrCreate(f.spec, f.runtime)).rejects.toThrow(/archiv/i)
    expect(f.mock.requests).toHaveLength(1)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "crash during drain preserves an incomplete fence; archive retry finalizes before inert unarchive",
  async () => {
    const f = fixture([{ text: "explicit continuation" }])
    const worker = spawnWorker(f.home, "crash-drain")
    try {
      const ready = path.join(f.home, "archive-ready.json")
      await waitForSpawnCondition("archive crash worker reaches physical drain", () => {
        if (fs.existsSync(ready)) return true
        if (worker.exitCode !== null)
          throw new Error(`archive crash worker exited (${worker.exitCode}) before drain`)
        return false
      })
      const { id } = JSON.parse(fs.readFileSync(ready, "utf8"))
      // Observing from another process must not report fully archived before the drain completes.
      await expect(f.owner.read({ id })).rejects.toThrow(incomplete)
      await expect(f.owner.unarchive({ id })).rejects.toThrow(incomplete)
      await stopSpawn(worker, "archive crash at drain")
      await expect(f.owner.read({ id })).rejects.toThrow(incomplete)
      await expect(f.owner.open(id, f.runtime)).rejects.toThrow(/archiv/i)
      await expect(
        f.owner.openOrCreate({ ...f.spec, callableTools: ["ask_user"] }, f.runtime),
      ).rejects.toThrow(/archiv/i)
      await expect(f.owner.unarchive({ key: f.spec.key })).rejects.toThrow(incomplete)
      await f.owner.archive({ id })
      const archived = await f.owner.read({ id })
      if (!archived) throw new Error("missing recovered archive")
      expect(archived.archived).toBe(true)
      expect(archived?.history.filter((message) => message.role === "user")).toHaveLength(1)
      expect(f.mock.requests).toHaveLength(0)
      await f.owner.unarchive({ key: f.spec.key })
      let questions = 0
      const handle = await f.owner.open(id, {
        askUser: async () => {
          questions++
          return undefined
        },
      })
      expect(handle.status()).toEqual({ state: "stopped", busy: false })
      expect(handle.history()).toEqual(archived.history)
      expect(f.mock.requests).toHaveLength(0)
      expect(questions).toBe(0)
      await handle.send("continue explicitly")
      expect(f.mock.requests).toHaveLength(1)
      expect(questions).toBe(0)
    } finally {
      await stopSpawn(worker, "archive crash worker cleanup")
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

for (const phase of ["upgrade", "publication"] as const) {
  test(
    `crash before ${phase} rename keeps the archive incomplete and recoverable`,
    async () => {
      const f = fixture()
      const worker = spawnWorker(f.home, `crash-${phase}`)
      try {
        const [code, stderr] = await Promise.all([
          waitForSpawnExit(worker, "archive persistence crash"),
          new Response(worker.stderr).text(),
        ])
        expect({ code, stderr }).toEqual({ code: 77, stderr: "" })
        const { id } = JSON.parse(fs.readFileSync(path.join(f.home, "archive-ready.json"), "utf8"))
        const metadata = JSON.parse(
          fs.readFileSync(path.join(ownedDirectory(f.home, "project"), `${id}.spec.json`), "utf8"),
        )
        expect(metadata).toMatchObject({ v: 3, lifecycle: "archiving" })
        await expect(f.owner.open(id, f.runtime)).rejects.toThrow(/archiv/i)
        await expect(f.owner.read({ id })).rejects.toThrow(incomplete)
        await expect(f.owner.unarchive({ id })).rejects.toThrow(incomplete)
        await f.owner.archive({ id })
        const snapshot = await f.owner.read({ id })
        expect(snapshot?.archived).toBe(true)
        expect(snapshot?.history).toEqual([])
        await f.owner.unarchive({ id })
        const handle = await f.owner.open(id, f.runtime)
        expect(handle.status().busy).toBe(false)
        expect(f.mock.requests).toHaveLength(0)
      } finally {
        await stopSpawn(worker, "archive persistence crash cleanup")
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}

test("post-rename migration failure retains a retryable fenced writer", async () => {
  const f = fixture([{ text: "saved before migration" }], true)
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  await handle.send("save")
  const history = handle.history()
  // Session writers canonicalize parents (including macOS /var and symlinked temp homes).
  const file = fs.realpathSync(path.join(ownedDirectory(f.home, "project"), `${handle.id}.jsonl`))
  const rename = fs.renameSync
  let fail = true
  const hook = spyOn(fs, "renameSync").mockImplementation((source, target) => {
    rename(source, target)
    if (fail && String(target) === file) {
      fail = false
      throw new Error("post-rename directory sync failed")
    }
  })
  try {
    await expect(f.owner.archive({ id: handle.id })).rejects.toThrow("post-rename")
  } finally {
    hook.mockRestore()
  }
  await expect(f.owner.read({ id: handle.id })).rejects.toThrow(incomplete)
  await expect(handle.send("blocked")).rejects.toThrow(inactive)
  await f.owner.archive({ id: handle.id })
  expect((await f.owner.read({ id: handle.id }))?.history).toEqual(history)
  expect(f.mock.requests).toHaveLength(1)
})

test("lifecycle-bearing records reject legacy readers and missing, downgraded or unsupported lifecycle metadata", async () => {
  const f = fixture()
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  await f.owner.archive({ id: handle.id })
  const directory = ownedDirectory(f.home, "project")
  const metadata = path.join(directory, `${handle.id}.spec.json`)
  const bytes = fs.readFileSync(metadata, "utf8")
  const saved = JSON.parse(bytes)
  const header = JSON.parse(
    fs.readFileSync(path.join(directory, `${handle.id}.jsonl`), "utf8").split("\n")[0]!,
  )
  // Both old parser gates must fail, including hosts whose session parser ignored v.
  expect([1, 2].includes(saved.v)).toBe(false)
  expect(["session", "session-policy"].includes(header.type)).toBe(false)
  expect(saved.spec).toEqual({ ...f.spec, descendants: "research" })
  for (const replacement of [
    undefined,
    { ...saved, lifecycle: undefined },
    { ...saved, lifecycle: "future-state" },
    { ...saved, v: 4 },
    { ...saved, v: 1, lifecycle: undefined },
  ]) {
    if (replacement) fs.writeFileSync(metadata, JSON.stringify(replacement))
    else fs.rmSync(metadata)
    try {
      await expect(f.owner.read({ id: handle.id })).rejects.toThrow()
      await expect(f.owner.open(handle.id, f.runtime)).rejects.toThrow()
      await expect(f.owner.archive({ id: handle.id })).rejects.toThrow()
      await expect(f.owner.unarchive({ id: handle.id })).rejects.toThrow()
    } finally {
      fs.writeFileSync(metadata, bytes)
    }
  }
  expect((await f.owner.read({ id: handle.id }))?.archived).toBe(true)
  expect(f.mock.requests).toHaveLength(0)
})

test("initial creation racing archive cannot publish an executable race loser", async () => {
  const f = fixture()
  const opening = f.owner.openOrCreate(f.spec, f.runtime)
  const archiving = f.owner.archive({ key: f.spec.key })
  const [opened, archived] = await Promise.allSettled([opening, archiving])
  if (opened.status === "fulfilled") {
    expect(archived.status).toBe("fulfilled")
    await expect(opened.value.send("race loser")).rejects.toThrow(inactive)
  } else if (archived.status === "fulfilled") {
    expect((await f.owner.read({ key: f.spec.key }))?.archived).toBe(true)
  } else {
    expect(String(archived.reason)).toMatch(/not found|missing/i)
    expect(await f.owner.read({ key: f.spec.key })).toBeUndefined()
  }
  expect(f.mock.requests).toHaveLength(0)
})

test("questions captured from completed tools are cancelled and revoked by archive", async () => {
  const f = fixture()
  let captured!: ToolSession
  let asked = 0
  let signal: AbortSignal | undefined
  f.tools.register(
    defineTool({
      name: "capture",
      description: "Capture tool capabilities",
      parameters: { type: "object" },
      traits: { readOnly: true },
      execute: async (_args, context) => {
        captured = context.session!
        return textResult("captured")
      },
    }),
    "test",
  )
  const handle = await f.owner.openOrCreate(
    { ...f.spec, callableTools: ["capture"] },
    {
      askUser: async (_questions, context) => {
        asked++
        signal = context.signal
        return new Promise(() => {})
      },
    },
  )
  await handle.runTool("capture", {})
  const questions = [{ question: "Choose?", options: [{ label: "A" }] }]
  const pending = captured.askUser!(questions)
  await until(() => asked === 1)
  await f.owner.archive({ id: handle.id })
  expect(signal?.aborted).toBe(true)
  expect(await pending).toEqual({ declined: true })
  await expect(captured.askUser!(questions)).rejects.toThrow(inactive)
  await f.owner.unarchive({ id: handle.id })
  await expect(captured.askUser!(questions)).rejects.toThrow(inactive)
  expect(asked).toBe(1)
  expect(f.mock.requests).toHaveLength(0)
})

test("archive drains artifact saves admitted through completed tools before acknowledging publication", async () => {
  const f = fixture()
  let captured!: ToolSession
  f.tools.register(
    defineTool({
      name: "capture",
      description: "Capture output capability",
      parameters: { type: "object" },
      traits: { readOnly: true },
      execute: async (_args, context) => {
        captured = context.session!
        return textResult("captured")
      },
    }),
    "test",
  )
  const handle = await f.owner.openOrCreate({ ...f.spec, callableTools: ["capture"] }, f.runtime)
  await handle.runTool("capture", {})
  const finish = Promise.withResolvers<void>()
  const save = ArtifactStore.prototype.save
  const hook = spyOn(ArtifactStore.prototype, "save").mockImplementation(async function (
    this: ArtifactStore,
    options,
  ) {
    if (this.sessionId === handle.id) await finish.promise
    return save.call(this, options)
  })
  let settled = false
  const saving = captured.outputs!.save({ tool: "capture", text: "retained output" })
  const archiving = f.owner.archive({ id: handle.id }).then(() => {
    settled = true
  })
  try {
    await Bun.sleep(10)
    expect(settled).toBe(false)
    await expect(f.owner.read({ id: handle.id })).rejects.toThrow(incomplete)
  } finally {
    finish.resolve()
    await saving
    await archiving
    hook.mockRestore()
  }
  const artifact = await saving
  expect(fs.readFileSync(artifact.path, "utf8")).toBe("retained output")
  expect((await f.owner.read({ id: handle.id }))?.archived).toBe(true)
  await expect(captured.outputs!.save({ tool: "capture", text: "late output" })).rejects.toThrow(inactive)
  expect(f.mock.requests).toHaveLength(0)
})

for (const boundary of ["cancel", "release-wait"] as const) {
  test(
    `archiving is durable before the ${boundary} crash boundary`,
    async () => {
      const f = fixture()
      const worker = spawnWorker(f.home, `crash-${boundary}`)
      try {
        const [code, stderr] = await Promise.all([
          waitForSpawnExit(worker, "archive cancellation/release crash"),
          new Response(worker.stderr).text(),
        ])
        expect({ code, stderr }).toEqual({ code: 77, stderr: "" })
        const { id } = JSON.parse(fs.readFileSync(path.join(f.home, "archive-ready.json"), "utf8"))
        const metadata = JSON.parse(
          fs.readFileSync(path.join(ownedDirectory(f.home, "project"), `${id}.spec.json`), "utf8"),
        )
        expect(metadata.lifecycle).toBe("archiving")
        await expect(f.owner.open(id, f.runtime)).rejects.toThrow(/archiv/i)
        await expect(f.owner.unarchive({ id })).rejects.toThrow(incomplete)
        await expect(f.owner.read({ id })).rejects.toThrow(incomplete)
        await f.owner.archive({ id })
        expect((await f.owner.read({ id }))?.archived).toBe(true)
        expect(f.mock.requests).toHaveLength(0)
      } finally {
        await stopSpawn(worker, "archive cancellation/release crash cleanup")
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}
