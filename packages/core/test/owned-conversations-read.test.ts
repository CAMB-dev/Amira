import { afterEach, expect, test } from "bun:test"
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { ConversationSpec, OwnedConversationRef } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { ownedDirectory } from "../src/owned-conversations-storage.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "amira-owned-read-"))
  const cwd = path.join(home, "worktree")
  mkdirSync(cwd)
  const mock = createMockDialect([{ text: "saved", usage: { input: 10, output: 2, cost: 0.25 } }])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  const tools = new ToolRegistry()
  const main = new Agent({ ai, model: ai.model("mock/test"), cwd, tree, tools, sections: [] })
  const manager = new OwnedConversationManager({ ai, tree, tools, home, agent: () => main })
  cleanups.push(async () => {
    await manager.drain()
    await main.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const spec: ConversationSpec = {
    key: "project/design",
    name: "Design",
    cwd,
    systemPrompt: "Research.",
    callableTools: [],
  }
  const owner = manager.forOwner("project")
  const runtime = { askUser: async () => undefined }
  return { home, cwd, mock, ai, tree, tools, main, manager, spec, owner, runtime }
}

test("historical reads need no model, runtime, cwd or writer lease and never repair metadata", async () => {
  const f = fixture()
  const handle = await f.owner.openOrCreate({ ...f.spec, writeRoots: [f.cwd] }, f.runtime)
  await handle.send("save history")
  const live = await f.owner.read({ key: f.spec.key })
  expect(live?.usage).toEqual(handle.usage())
  expect(live?.usage.total.knownCostUsd).toBe(0.25)
  await handle.release()
  rmSync(f.cwd, { recursive: true })
  writeFileSync(f.cwd, "the former worktree is now a regular file")
  const directory = ownedDirectory(f.home, "project")
  const metadata = path.join(directory, `${handle.id}.spec.json`)
  rmSync(metadata)
  const files = () => readdirSync(directory).sort()
  const before = files()
  const bytes = readFileSync(path.join(directory, `${handle.id}.jsonl`), "utf8")
  const ai = createAi({ dialects: [], providers: [] })
  const inert = new OwnedConversationManager({
    ai,
    tools: new ToolRegistry(),
    tree: new AgentTree({ ai, sections: () => [] }),
    home: f.home,
    agent: () => {
      throw new Error("read must never obtain a runtime agent")
    },
  })
  cleanups.push(() => inert.drain())
  const reader = inert.forOwner("project")
  const saved = await reader.read({ id: handle.id })
  expect(saved).toEqual(live)
  expect(await reader.read({ key: f.spec.key })).toEqual(saved)
  expect(files()).toEqual(before)
  expect(readFileSync(path.join(directory, `${handle.id}.jsonl`), "utf8")).toBe(bytes)
  expect(Object.isFrozen(saved)).toBe(true)
  expect(Object.isFrozen(saved?.history[0]?.content)).toBe(true)
  expect(Object.isFrozen(saved?.usage.total.usage)).toBe(true)
  expect(f.mock.requests).toHaveLength(1)
})

function supportsLinks(): boolean {
  const home = mkdtempSync(path.join(tmpdir(), "amira-read-link-probe-"))
  try {
    mkdirSync(path.join(home, "target"))
    symlinkSync(path.join(home, "target"), path.join(home, "link"), "junction")
    return true
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EINVAL"].includes(String(error.code))
    )
      return false
    throw error
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}
const linksSupported = supportsLinks()

for (const metadata of [true, false]) {
  for (const replacement of ["missing", "file", "broken link", "redirected link"] as const) {
    test.skipIf(replacement.includes("link") && !linksSupported)(
      `historical reads with ${metadata ? "metadata" : "header only"} retain evidence after cwd/write-root becomes ${replacement}`,
      async () => {
        const f = fixture()
        const handle = await f.owner.openOrCreate({ ...f.spec, writeRoots: [f.cwd] }, f.runtime)
        const before = await f.owner.read({ id: handle.id })
        await handle.release()
        const directory = ownedDirectory(f.home, "project")
        const session = path.join(directory, `${handle.id}.jsonl`)
        if (!metadata) rmSync(path.join(directory, `${handle.id}.spec.json`))
        rmSync(f.cwd, { recursive: true })
        if (replacement === "file") writeFileSync(f.cwd, "repurposed worktree")
        if (replacement.includes("link")) {
          const target = path.join(f.home, "another-worktree")
          mkdirSync(target)
          symlinkSync(target, f.cwd, process.platform === "win32" ? "junction" : "dir")
          if (replacement === "broken link") rmSync(target, { recursive: true })
        }
        const files = readdirSync(directory).sort()
        const bytes = readFileSync(session, "utf8")
        expect(await f.owner.read({ id: handle.id })).toEqual(before)
        expect(await f.owner.read({ key: f.spec.key })).toEqual(before)
        expect(readdirSync(directory).sort()).toEqual(files)
        expect(readFileSync(session, "utf8")).toBe(bytes)
        expect(f.mock.requests).toHaveLength(0)
        if (replacement !== "missing") {
          expect(() => SessionStore.open(session)).toThrow()
          await expect(f.owner.open(handle.id, f.runtime)).rejects.toThrow()
        }
      },
    )
  }
}

test("historical descendant costs survive replacement of their former write-root directory", async () => {
  const f = fixture()
  const handle = await f.owner.openOrCreate({ ...f.spec, writeRoots: [f.cwd] }, f.runtime)
  const child = handle.createGroup({ name: "research" }).spawn({ prompt: "research", context: "fresh" })
  expect((await child.result()).status).toBe("done")
  await handle.stop()
  const before = handle.usage()
  expect(before.own.knownCostUsd).toBe(0)
  expect(before.total.knownCostUsd).toBe(0.25)
  expect(before.descendants).toHaveLength(1)
  await handle.release()
  rmSync(f.cwd, { recursive: true })
  writeFileSync(f.cwd, "former child execution directory")
  // Force a fresh evidence read, as in a new process, without changing any receipt.
  appendFileSync(path.join(ownedDirectory(f.home, "project"), "subagents", `${child.id}.jsonl`), "\n")
  const reader = new OwnedConversationManager({
    ai: f.ai,
    tree: f.tree,
    tools: f.tools,
    home: f.home,
    agent: () => {
      throw new Error("read must not obtain an execution agent")
    },
  })
  cleanups.push(() => reader.drain())
  expect((await reader.forOwner("project").read({ id: handle.id }))?.usage).toEqual(before)
  expect(f.mock.requests).toHaveLength(1)
})

test("reads return undefined only for missing records and reject foreign or invalid identities", async () => {
  const f = fixture()
  expect(await f.owner.read({ key: "missing" })).toBeUndefined()
  expect(await f.owner.read({ id: `s_${"0".repeat(32)}` })).toBeUndefined()
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  const foreign = f.manager.forOwner("other")
  await expect(foreign.read({ id: handle.id })).rejects.toThrow("owner")
  expect(await foreign.read({ key: handle.key })).toBeUndefined()
  for (const ref of [
    { id: "../../escape" },
    { key: "" },
    { key: "bad\0key" },
    { id: handle.id, key: handle.key },
  ]) {
    await expect(f.owner.read(ref as OwnedConversationRef)).rejects.toThrow("invalid")
  }
  await handle.release()
  const directory = ownedDirectory(f.home, "project")
  const session = path.join(directory, `${handle.id}.jsonl`)
  const original = readFileSync(session, "utf8")
  writeFileSync(session, "corrupt\n")
  await expect(f.owner.read({ id: handle.id })).rejects.toThrow()
  writeFileSync(session, original)
  rmSync(session)
  await expect(f.owner.read({ key: f.spec.key })).rejects.toThrow("missing")
})

for (const metadata of [true, false]) {
  test(`historical ${metadata ? "metadata" : "header-only"} reads reject corrupt policy structures without resolving roots`, async () => {
    const f = fixture()
    const handle = await f.owner.openOrCreate({ ...f.spec, writeRoots: [f.cwd] }, f.runtime)
    await handle.release()
    const directory = ownedDirectory(f.home, "project")
    const session = path.join(directory, `${handle.id}.jsonl`)
    const specFile = path.join(directory, `${handle.id}.spec.json`)
    const bytes = readFileSync(session, "utf8")
    const lines = bytes.split("\n")
    const header = JSON.parse(lines[0]!)
    const saved = JSON.parse(readFileSync(specFile, "utf8"))
    if (!metadata) rmSync(specFile)
    rmSync(f.cwd, { recursive: true })
    writeFileSync(f.cwd, "repurposed worktree")
    for (const invalid of [
      { writeRoots: ["relative"] },
      { writeRoots: null },
      { writeRoots: [f.cwd, f.cwd] },
      { writeRoots: [path.join(f.cwd, "nested"), f.cwd] },
      { writeRoots: [`${f.cwd}${path.sep}nested${path.sep}..`] },
      { futurePolicy: true },
      { descendants: "future" },
      { callableTools: [42] },
      { model: null },
      { systemPrompt: 42 },
      { cwd: "relative" },
    ]) {
      if (metadata) writeFileSync(specFile, JSON.stringify({ ...saved, spec: { ...saved.spec, ...invalid } }))
      else {
        lines[0] = JSON.stringify({
          ...header,
          owned: { ...header.owned, spec: { ...header.owned.spec, ...invalid } },
        })
        writeFileSync(session, lines.join("\n"))
      }
      await expect(f.owner.read({ id: handle.id })).rejects.toThrow()
    }
    expect(f.mock.requests).toHaveLength(0)
  })
}

test("historical reads reject header identity mismatches and unknown header policies", async () => {
  const f = fixture()
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  await handle.release()
  const directory = ownedDirectory(f.home, "project")
  const session = path.join(directory, `${handle.id}.jsonl`)
  const lines = readFileSync(session, "utf8").split("\n")
  const header = JSON.parse(lines[0]!)
  for (const invalid of [
    { ...header, id: `s_${"0".repeat(32)}` },
    { ...header, cwd: path.dirname(f.cwd) },
    { ...header, owned: { ...header.owned, owner: "other" } },
    { ...header, owned: { ...header.owned, runtimeTools: ["unavailable"] } },
    { ...header, owned: { ...header.owned, spec: { ...header.owned.spec, name: "other" } } },
    { ...header, type: "session-policy", v: 2, futurePolicy: true },
    { ...header, type: "session-policy", v: 2, writeRoots: ["relative"] },
  ]) {
    lines[0] = JSON.stringify(invalid)
    writeFileSync(session, lines.join("\n"))
    await expect(f.owner.read({ id: handle.id })).rejects.toThrow()
  }
  expect(f.mock.requests).toHaveLength(0)
})

test("another manager reads persisted evidence without acquiring the live writer", async () => {
  const f = fixture()
  const handle = await f.owner.openOrCreate(f.spec, f.runtime)
  await handle.send("save")
  const reader = new OwnedConversationManager({
    ai: f.ai,
    tree: f.tree,
    tools: f.tools,
    home: f.home,
    agent: () => f.main,
  })
  cleanups.push(() => reader.drain())
  const snapshot = await reader.forOwner("project").read({ id: handle.id })
  expect(snapshot?.usage.total.knownCostUsd).toBe(0.25)
  expect(snapshot?.usage.total.complete).toBe(false)
  expect(snapshot?.history).toEqual(handle.history())
  expect(handle.status().busy).toBe(false)
  await handle.send("writer still works")
  expect(f.mock.requests).toHaveLength(2)
})
