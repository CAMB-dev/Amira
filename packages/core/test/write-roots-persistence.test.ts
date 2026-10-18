import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import {
  claimOwned,
  ownedDirectory,
  ownedId,
  publishOwned,
  readOwned,
  type SavedConversation,
  validateSpec,
} from "../src/owned-conversations-storage.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function fixture(roots = true) {
  const home = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "amira-roots-saved-")))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const owner = "test-owner"
  const spec = validateSpec({
    key: "key",
    name: "test",
    model: "mock/test",
    cwd: home,
    callableTools: [],
    systemPrompt: "test",
    ...(roots ? { writeRoots: [home] } : {}),
  })
  const saved: SavedConversation = {
    v: roots ? 2 : 1,
    owner,
    id: ownedId(owner, spec.key),
    spec: { ...spec, model: "mock/test" },
    runtimeTools: [],
  }
  const directory = ownedDirectory(home, owner)
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, `${saved.id}.spec.json`)
  return { home, owner, spec, saved, directory, file }
}

test("bounded metadata and session headers carry version 2; legacy version-1 owned readers reject both", async () => {
  const { home, saved, owner, file, directory } = fixture()
  const lease = await claimOwned(home, saved, true)
  lease.store.appendDisplay({ type: "display", text: "persist", level: "info" })
  lease.release()
  publishOwned(home, saved)
  const metadata = JSON.parse(readFileSync(file, "utf8"))
  const header = JSON.parse(readFileSync(path.join(directory, `${saved.id}.jsonl`), "utf8").split("\n")[0]!)
  const legacyAccepts = (record: { v: number }) => record.v === 1
  expect(legacyAccepts(metadata)).toBe(false)
  expect(legacyAccepts(header.owned)).toBe(false)
  expect(header.v).toBe(2)
  // The pre-policy SessionStore parser checked the discriminator and id, not v.
  const legacySessionAccepts = (record: { type?: unknown; id?: unknown }) =>
    record.type === "session" && typeof record.id === "string"
  expect(legacySessionAccepts(header)).toBe(false)
  expect(readOwned(home, owner, saved.id).spec.writeRoots).toEqual([home])
  rmSync(file)
  expect(readOwned(home, owner, saved.id).spec.writeRoots).toEqual([home])
})

for (const policy of ["empty roots", "bounded roots", "inherited descendants"] as const) {
  for (const headerRoots of [false, true]) {
    test(`create rejects v1 owned ${policy} before returning a ${headerRoots ? "policy" : "legacy"} store`, () => {
      const { home, saved } = fixture(false)
      const owned = {
        v: 1 as const,
        owner: saved.owner,
        spec: {
          ...saved.spec,
          ...(policy === "inherited descendants"
            ? { descendants: "inherit" as const }
            : { writeRoots: policy === "empty roots" ? [] : [home] }),
        },
        runtimeTools: saved.runtimeTools,
      }
      const dir = path.join(home, "direct-sessions")
      expect(() =>
        SessionStore.create({
          cwd: home,
          id: "inconsistent",
          dir,
          owned,
          ...(headerRoots ? { writeRoots: [] } : {}),
        }),
      ).toThrow(/owned|version|policy/i)
      // Rejected identities cannot emit headers accepted by the pre-policy reader.
      expect(existsSync(dir)).toBe(false)
    })
  }
}

for (const policy of ["legacy", "empty roots", "bounded roots", "inherited descendants"] as const) {
  test(`direct owned ${policy} identity survives persist and reopen with consistent versions`, () => {
    const { home, saved } = fixture(false)
    const owned = {
      v: policy === "legacy" ? (1 as const) : (2 as const),
      owner: saved.owner,
      spec: {
        ...saved.spec,
        ...(policy === "inherited descendants"
          ? { descendants: "inherit" as const }
          : policy === "legacy"
            ? {}
            : { writeRoots: policy === "empty roots" ? [] : [home] }),
      },
      runtimeTools: saved.runtimeTools,
    }
    const store = SessionStore.create({ cwd: home, dir: path.join(home, "direct-sessions"), owned })
    store.appendDisplay({ type: "display", text: "persist", level: "info" })
    const persisted = JSON.parse(readFileSync(store.file, "utf8").split("\n")[0]!)
    const reopened = SessionStore.open(store.file)
    expect(reopened.header).toEqual(store.header)
    expect(reopened.header.owned).toEqual(owned)
    expect(persisted.v).toBe(owned.v)
    expect(persisted.owned.v).toBe(owned.v)
    const legacySessionAccepts = persisted.type === "session" && typeof persisted.id === "string"
    const legacyOwnedAccepts = persisted.owned.v === 1
    expect(legacySessionAccepts).toBe(policy === "legacy")
    expect(legacyOwnedAccepts).toBe(policy === "legacy")
  })
}

test("legacy unbounded metadata retains legacy behavior without adding a ceiling", async () => {
  const { home, saved, owner } = fixture(false)
  publishOwned(home, saved)
  expect(readOwned(home, owner, saved.id).v).toBe(1)
  expect(readOwned(home, owner, saved.id).spec.writeRoots).toBeUndefined()
  const lease = await claimOwned(home, saved, true)
  expect(lease.store.header.v).toBe(1)
  lease.release()
})

test("downgraded, future-version and unknown metadata policy fields fail closed", () => {
  const { home, saved, owner, file } = fixture()
  for (const invalid of [
    { ...saved, v: 1 },
    { ...saved, v: 3 },
    { ...saved, futurePolicy: true },
    { ...saved, spec: { ...saved.spec, futurePolicy: true } },
    { ...saved, spec: { ...saved.spec, writeRoots: ["relative"] } },
    { ...saved, spec: { ...saved.spec, writeRoots: null } },
  ]) {
    writeFileSync(file, JSON.stringify(invalid))
    expect(() => readOwned(home, owner, saved.id)).toThrow()
    expect(() => readOwned(home, owner, saved.id, { historical: true })).toThrow()
  }
})

test("downgraded, future and unknown session header policy formats fail closed", async () => {
  const { home, saved, directory } = fixture()
  const lease = await claimOwned(home, saved, true)
  const header = structuredClone(lease.store.header)
  lease.release()
  const file = path.join(directory, `${saved.id}.jsonl`)
  for (const invalid of [
    { ...header, v: 1 },
    { ...header, v: 3 },
    { ...header, futurePolicy: true },
    { ...header, writeRoots: ["relative"] },
    { ...header, writeRoots: [home, home] },
    { ...header, owned: { ...header.owned, v: 3 } },
    { ...header, owned: { ...header.owned, v: 1 } },
    { ...header, owned: { ...header.owned, spec: { ...saved.spec, futurePolicy: true } } },
  ]) {
    writeFileSync(file, `${JSON.stringify(invalid)}\n`)
    expect(() => SessionStore.open(file)).toThrow()
    expect(() => SessionStore.open(file, { historical: true })).toThrow()
  }
})

test("owned reopen cannot drop or widen persisted writeRoots, including header-only recovery", async () => {
  const { home, saved, owner, file } = fixture()
  const mock = createMockDialect()
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
  })
  const tools = new ToolRegistry()
  const tree = new AgentTree({ ai, sections: () => [] })
  const main = new Agent({ ai, cwd: home, model: ai.model("mock/test"), tools, tree, sections: [] })
  const manager = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
  cleanups.push(() => main.dispose())
  cleanups.push(() => manager.drain())
  const owned = manager.forOwner(owner)
  const runtime = { askUser: async () => undefined }
  const handle = await owned.openOrCreate(saved.spec, runtime)
  await handle.release()
  await expect(owned.openOrCreate({ ...saved.spec, writeRoots: undefined }, runtime)).rejects.toThrow(
    "differs",
  )
  await expect(
    owned.openOrCreate({ ...saved.spec, writeRoots: [path.dirname(home)] }, runtime),
  ).rejects.toThrow("differs")
  rmSync(file)
  const reopened = await owned.open(saved.id, runtime)
  expect(reopened.id).toBe(saved.id)
  expect(mock.requests).toHaveLength(0)
})

test("historical header parsing validates root spelling without granting execution authority", () => {
  const { home } = fixture()
  const root = path.join(home, "old-worktree")
  mkdirSync(root)
  const store = SessionStore.create({ cwd: home, dir: path.join(home, "sessions"), writeRoots: [root] })
  store.appendDisplay({ type: "display", text: "persist", level: "info" })
  rmSync(root, { recursive: true })
  writeFileSync(root, "repurposed worktree")
  const historical = SessionStore.open(store.file, { historical: true })
  expect(historical.header.writeRoots).toEqual([root])
  expect(historical.entries).toEqual(store.entries)
  expect(() => SessionStore.open(store.file)).toThrow()
  expect(() => historical.claim()).toThrow()
  expect(() => historical.fork(null)).toThrow()
})

test("bounded ordinary child session headers retain their narrowed ceiling on restore and fork", async () => {
  const { home } = fixture()
  const nested = path.join(home, "nested")
  const store = SessionStore.create({ cwd: home, dir: path.join(home, "sessions"), writeRoots: [nested] })
  store.appendDisplay({ type: "display", text: "persist", level: "info" })
  const restored = SessionStore.open(store.file)
  expect(restored.header.v).toBe(2)
  // This ordinary child has no owned marker to protect it from a legacy Agent.
  expect(restored.header.type === "session" && typeof restored.header.id === "string").toBe(false)
  expect(restored.header.writeRoots).toEqual([nested])
  expect(restored.fork(null).header.writeRoots).toEqual([nested])
  const mock = createMockDialect()
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
  })
  const agent = new Agent({
    ai,
    cwd: home,
    model: ai.model("mock/test"),
    session: restored,
    writeRoots: [home],
    sections: [],
  })
  cleanups.push(() => agent.dispose())
  expect(agent.writeRoots).toEqual([nested])
  expect(Object.isFrozen(agent.writeRoots)).toBe(true)
})
