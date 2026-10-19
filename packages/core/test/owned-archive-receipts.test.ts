import { afterEach, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { ConversationSpec } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { usageReceiptDestination, usageReceiptEvidence } from "../src/owned-conversations-receipts.ts"
import { type SessionHeader, SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture() {
  const home = fs.mkdtempSync(path.join(tmpdir(), "amira-owned-archive-receipts-"))
  const ai = createAi({
    dialects: [createMockDialect([{ text: "answer", usage: { cost: 0.75 } }])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  const tools = new ToolRegistry()
  const main = new Agent({ ai, model: ai.model("mock/test"), cwd: home, tree, tools, sections: [] })
  const host = new OwnedConversationManager({ ai, tree, tools, home, agent: () => main })
  cleanups.push(async () => {
    await host.drain()
    await main.dispose()
    fs.rmSync(home, { recursive: true, force: true })
  })
  const spec: ConversationSpec = {
    key: "archive-receipts",
    name: "Archive receipts",
    cwd: home,
    model: "mock/test",
    systemPrompt: "Research only.",
    callableTools: [],
  }
  return { home, owner: host.forOwner("project"), spec }
}

function ownedStore(home: string, id: string) {
  const file = fs
    .readdirSync(home, { recursive: true, encoding: "utf8" })
    .find((name) => name.endsWith(`${id}.jsonl`))
  if (!file) throw new Error("missing owned session")
  return SessionStore.open(path.join(home, file))
}

// The pre-lifecycle destination format is persisted in finished-child records.
function legacyDestination(store: SessionStore) {
  const file = process.platform === "win32" ? store.file.toLowerCase() : store.file
  return createHash("sha256")
    .update(JSON.stringify([file, store.header]))
    .digest("hex")
}

test("archive preserves known incomplete spend after a transient receipt write failure", async () => {
  const f = fixture()
  const handle = await f.owner.openOrCreate(f.spec, { askUser: async () => undefined })
  const store = ownedStore(f.home, handle.id)
  const append = fs.appendFileSync
  const failure = spyOn(fs, "appendFileSync").mockImplementation((target, ...args) => {
    if (String(target) === store.file && String(args[0]).includes('"type":"side_usage"'))
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" })
    return append(target, ...args)
  })
  try {
    await handle.complete({ messages: [] })
  } finally {
    failure.mockRestore()
  }
  const before = await f.owner.read({ id: handle.id })
  expect(before?.usage.own).toMatchObject({ knownCostUsd: 0.75, complete: false })
  await f.owner.archive({ id: handle.id })
  const archived = await f.owner.read({ id: handle.id })
  expect(archived?.archived).toBe(true)
  expect(archived?.usage.own).toMatchObject({ knownCostUsd: 0.75, complete: false })
  expect(archived?.usage.total).toMatchObject({ knownCostUsd: 0.75, complete: false })
  const evidence = usageReceiptEvidence(store)
  expect(evidence.currentStore?.header.v).toBe(3)
  expect(evidence.receipts).toContainEqual(
    expect.objectContaining({ durable: false, usage: expect.objectContaining({ cost: 0.75 }) }),
  )
})

for (const policy of [false, true]) {
  test(`receipt destinations survive archive and restore without changing legacy keys (policy: ${policy})`, async () => {
    const f = fixture()
    const spec = { ...f.spec, ...(policy ? { writeRoots: [] } : {}) }
    const handle = await f.owner.openOrCreate(spec, { askUser: async () => undefined })
    const store = ownedStore(f.home, handle.id)
    expect(store.header.v).toBe(policy ? 2 : 1)
    const identity = usageReceiptDestination(store)
    expect(legacyDestination(store)).toBe(identity)
    await f.owner.archive({ id: handle.id })
    const archived = ownedStore(f.home, handle.id)
    expect(archived.header.v).toBe(3)
    expect(usageReceiptDestination(archived)).toBe(identity)
    expect(usageReceiptEvidence(archived, undefined, identity).currentStore?.id).toBe(handle.id)
    await f.owner.unarchive({ id: handle.id })
    expect(usageReceiptDestination(ownedStore(f.home, handle.id))).toBe(identity)
  })

  test(`ordinary legacy destinations keep their persisted full-header keys (policy: ${policy})`, () => {
    const f = fixture()
    const store = SessionStore.create({ cwd: f.home, dir: f.home, ...(policy ? { writeRoots: [] } : {}) })
    store.appendMessage({ role: "user", content: [{ type: "text", text: "legacy" }] })
    const identity = usageReceiptDestination(store)
    expect(legacyDestination(store)).toBe(identity)
    expect(usageReceiptDestination(SessionStore.open(store.file))).toBe(identity)
    expect(usageReceiptEvidence(SessionStore.open(store.file), undefined, identity).currentStore?.id).toBe(
      store.id,
    )
  })
}

test("lifecycle-stable destinations still reject different files and immutable identities", async () => {
  const f = fixture()
  const handle = await f.owner.openOrCreate(f.spec, { askUser: async () => undefined })
  const stale = ownedStore(f.home, handle.id)
  const identity = usageReceiptDestination(stale)
  await f.owner.archive({ id: handle.id })
  const store = ownedStore(f.home, handle.id)
  const bytes = fs.readFileSync(store.file, "utf8")
  const copy = path.join(f.home, "copied-session.jsonl")
  fs.writeFileSync(copy, bytes)
  const copied = SessionStore.open(copy)
  expect(usageReceiptDestination(copied)).not.toBe(identity)
  expect(usageReceiptEvidence(copied, undefined, identity).currentStore).toBeUndefined()
  const changes: ((header: SessionHeader) => void)[] = [
    (header) => {
      header.id += "-replacement"
    },
    (header) => {
      header.cwd = path.dirname(f.home)
    },
    (header) => {
      header.createdAt = "2000-01-01T00:00:00.000Z"
    },
    (header) => {
      header.parent = "another-parent"
    },
    (header) => {
      header.writeRoots = []
    },
    (header) => {
      header.owned!.owner = "another-owner"
    },
    (header) => {
      header.owned!.spec.name = "another-spec"
    },
    (header) => {
      header.owned!.spec.writeRoots = []
    },
    (header) => {
      header.owned!.runtimeTools = ["another-tool"]
    },
  ]
  try {
    for (const change of changes) {
      const header = structuredClone(store.header)
      change(header)
      fs.writeFileSync(store.file, `${JSON.stringify(header)}\n${bytes.slice(bytes.indexOf("\n") + 1)}`)
      const replacement = SessionStore.open(store.file, { historical: true })
      expect(usageReceiptDestination(replacement)).not.toBe(identity)
      expect(usageReceiptEvidence(replacement, undefined, identity).currentStore).toBeUndefined()
      expect(usageReceiptEvidence(stale).currentStore).toBeUndefined()
    }
  } finally {
    fs.writeFileSync(store.file, bytes)
  }
})
