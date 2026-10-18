import { afterEach, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type Dialect, type DialectCompactOutcome } from "@amira/ai"
import { reportedUsage } from "../src/accounting-receipts.ts"
import { Agent } from "../src/agent.ts"
import { lateNativeUsage } from "../src/native-compaction-usage.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { ownedDirectory, ownedId } from "../src/owned-conversations-storage.ts"
import { conversationUsage } from "../src/owned-conversations-usage.ts"
import { SessionStore } from "../src/session-store.ts"
import { Child } from "../src/subagents/child.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(timeoutMs: number) {
  const home = mkdtempSync(path.join(tmpdir(), "amira-owned-native-late-"))
  const entered = Promise.withResolvers<void>()
  const outcome = Promise.withResolvers<DialectCompactOutcome>()
  const returned = Promise.withResolvers<void>()
  const mock = createMockDialect([
    { text: "first" },
    { text: "second" },
    { text: "fallback summary", usage: { input: 10, output: 5, cost: 0.3 } },
  ])
  const dialect: Dialect = {
    ...mock,
    compaction: {
      methods: ["server"],
      layouts: ["tail"],
      midTurn: true,
      official: () => true,
      async compact() {
        entered.resolve()
        const result = await outcome.promise
        returned.resolve()
        return result
      },
    },
  }
  const ai = createAi({
    dialects: [dialect],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0, nativeCompactionTimeoutMs: timeoutMs },
  })
  const shared = new AgentTree({ ai, sections: () => [] })
  const tree = new AgentTree({ ai, shared, sections: () => [] })
  const tools = new ToolRegistry()
  const owner = "project"
  const spec = {
    key: "native",
    name: "Native",
    cwd: home,
    model: "mock/owner",
    systemPrompt: "",
    callableTools: [],
  }
  const store = SessionStore.create({
    id: ownedId(owner, spec.key),
    cwd: home,
    dir: ownedDirectory(home, owner),
    owned: { v: 1, owner, spec, runtimeTools: [] },
  })
  const agent = new Agent({
    ai,
    model: ai.model(spec.model),
    cwd: home,
    session: store,
    ownedConversation: owner,
    tree,
    tools,
    compaction: { auto: false },
    sections: [],
  })
  const main = new Agent({ ai, model: ai.model("mock/main"), cwd: home, tree: shared, tools, sections: [] })
  const reader = new OwnedConversationManager({ ai, tools, tree: shared, home, agent: () => main })
  cleanups.push(async () => {
    outcome.resolve({ ok: false, error: { message: "cleanup" }, unsupported: false, retryable: false })
    await agent.dispose()
    await main.dispose()
    await reader.drain()
    tree.releaseScope()
    rmSync(home, { recursive: true, force: true })
  })
  await agent.prompt("one")
  await agent.prompt("two")
  const payNative = () =>
    outcome.resolve({
      ok: true,
      value: "checkpoint",
      usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, cost: 2 },
    })
  return { ai, agent, main, reader, store, mock, entered, returned, payNative }
}

for (const stoppedBy of ["timeout", "cancel"] as const) {
  test(`native ${stoppedBy} retains late reported spend exactly once for the original owner`, async () => {
    const f = await fixture(stoppedBy === "timeout" ? 20 : 0)
    const operation = f.agent.compact()
    await f.entered.promise
    if (stoppedBy === "cancel") f.agent.abort()
    expect(await operation).toBe(stoppedBy === "timeout")
    const before = stoppedBy === "timeout" ? 0.3 : 0
    expect(conversationUsage(f.agent).own.knownCostUsd).toBeCloseTo(before)
    await f.agent.dispose()
    const originalHistory = SessionStore.open(f.store.file)
      .branch()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
    f.payNative()
    await f.returned.promise
    await Bun.sleep(10)
    const snapshot = await f.reader.forOwner("project").read({ id: f.store.id })
    expect(snapshot?.usage.own.knownCostUsd).toBeCloseTo(before + 2)
    expect(snapshot?.history).toEqual(originalHistory)
    expect(f.main.messages).toEqual([])
    expect((await f.reader.forOwner("project").read({ key: "native" }))?.usage).toEqual(snapshot?.usage)
    expect(f.mock.requests).toHaveLength(stoppedBy === "timeout" ? 3 : 2)
  })
}

test("repeated delivery of the same late native receipt books its stable identity once", async () => {
  const f = await fixture(0)
  const receipt = {
    id: "late-physical-attempt",
    late: true,
    usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, cost: 2, reasoning: undefined },
  }
  const record = lateNativeUsage(f.agent, { provider: "mock", model: "owner" })
  record(receipt)
  record({ ...receipt, usage: { ...receipt.usage } })
  // A fresh observer also reconciles the persisted receipt identity rather than charging again.
  lateNativeUsage(f.agent, { provider: "mock", model: "owner" })(receipt)
  expect(conversationUsage(f.agent).own.knownCostUsd).toBe(2)
  expect(conversationUsage(f.agent).own.complete).toBe(true)
  expect(f.agent.tree?.usage.cost).toBe(2)
})

test("late receipt identity follows a replacement writer and deduplicates fresh observers", async () => {
  const f = await fixture(0)
  const model = { provider: "mock", model: "owner" }
  const original = lateNativeUsage(f.agent, model)
  await f.agent.dispose()
  const store = SessionStore.open(f.store.file)
  const replacement = new Agent({
    ai: f.ai,
    model: f.ai.model("mock/owner"),
    cwd: f.agent.cwd,
    session: store,
    ownedConversation: "project",
    tree: f.agent.tree,
    sections: [],
  })
  cleanups.push(() => replacement.dispose())
  const receipt = {
    id: "late-after-writer-replacement",
    late: true,
    usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, cost: 2 },
  }
  original(receipt)
  lateNativeUsage(f.agent, model)({ ...receipt, usage: { ...receipt.usage } })
  lateNativeUsage(replacement, model)({ ...receipt, usage: { ...receipt.usage } })
  expect(conversationUsage(replacement).own.knownCostUsd).toBe(2)
  expect(f.agent.tree?.usage.cost).toBe(2)
  expect(conversationUsage(SessionStore.open(f.store.file)).own.knownCostUsd).toBe(2)
})

test("failed late receipts remain visible across writer replacement and reconcile without recharging", async () => {
  const f = await fixture(0)
  const model = { provider: "mock", model: "owner" }
  const original = lateNativeUsage(f.agent, model)
  await f.agent.dispose()
  const store = SessionStore.open(f.store.file)
  const replacement = new Agent({
    ai: f.ai,
    model: f.ai.model("mock/owner"),
    cwd: f.agent.cwd,
    session: store,
    ownedConversation: "project",
    tree: f.agent.tree,
    sections: [],
  })
  cleanups.push(() => replacement.dispose())
  const receipt = {
    id: "failed-late-after-writer-replacement",
    late: true,
    usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, cost: 2 },
  }
  const append = fs.appendFileSync
  const failure = spyOn(fs, "appendFileSync").mockImplementation((file, ...args) => {
    if (String(file) === store.file) throw Object.assign(new Error("disk full"), { code: "ENOSPC" })
    return append(file, ...args)
  })
  try {
    original(receipt)
    expect(f.agent.tree?.usage.cost).toBe(2)
    expect(conversationUsage(f.agent).own.knownCostUsd).toBe(2)
    expect(conversationUsage(replacement).own).toMatchObject({ knownCostUsd: 2, complete: false })
    lateNativeUsage(replacement, model)({ ...receipt, usage: { ...receipt.usage } })
    expect(f.agent.tree?.usage.cost).toBe(2)
  } finally {
    failure.mockRestore()
  }
  const pending = conversationUsage(replacement)
  const bytes = fs.readFileSync(store.file, "utf8")
  expect(conversationUsage(SessionStore.open(store.file)).own).toMatchObject({
    knownCostUsd: 2,
    complete: false,
  })
  expect((await f.reader.forOwner("project").read({ key: "native" }))?.usage.own.knownCostUsd).toBe(2)
  expect(fs.readFileSync(store.file, "utf8")).toBe(bytes)
  const recovered = reportedUsage(receipt.usage, receipt.id)
  store.append({ type: "side_usage", model, usage: recovered, label: "recovered receipt" })
  const settled = conversationUsage(replacement)
  expect(settled.own.knownCostUsd).toBe(2)
  expect(settled.own.complete).toBe(true)
  expect(settled.revision).toBe(pending.revision + 1)
  expect(conversationUsage(SessionStore.open(store.file))).toEqual(settled)
  expect(conversationUsage(f.agent).own.knownCostUsd).toBe(2)
  expect(conversationUsage(SessionStore.open(store.file)).own.knownCostUsd).toBe(2)
  lateNativeUsage(replacement, model)(receipt)
  expect(f.agent.tree?.usage.cost).toBe(2)
})

test("pending receipts follow canonical aliases but not a copied session with identical header identity", async () => {
  const f = await fixture(0)
  const receipt = {
    id: "pending-file-identity",
    late: true,
    usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, cost: 2 },
  }
  const append = fs.appendFileSync
  const failure = spyOn(fs, "appendFileSync").mockImplementation((file, ...args) => {
    if (String(file) === f.store.file) throw Object.assign(new Error("disk full"), { code: "ENOSPC" })
    return append(file, ...args)
  })
  try {
    lateNativeUsage(f.agent, { provider: "mock", model: "owner" })(receipt)
  } finally {
    failure.mockRestore()
  }
  const other = path.join(f.agent.cwd, "copied-session.jsonl")
  fs.copyFileSync(f.store.file, other)
  expect(conversationUsage(SessionStore.open(other)).own.knownCostUsd).toBe(0)
  const alias = process.platform === "win32" ? f.store.file.toUpperCase() : f.store.file
  expect(conversationUsage(SessionStore.open(alias)).own).toMatchObject({ knownCostUsd: 2, complete: false })
})

test("pending private late receipts retain attribution without making replacement own spend incomplete", async () => {
  const f = await fixture(0)
  const group = f.agent.tree!.createGroup(f.agent, { name: "private late research" })
  const child = group.spawn({
    prompt: "PRIVATE PROMPT",
    title: "private worker",
    ephemeral: true,
    maxTurns: 1,
  })
  await child.result()
  if (!(child instanceof Child)) throw new Error("expected the core child implementation")
  const model = { provider: "mock", model: "owner" }
  const record = lateNativeUsage(child.agent, model)
  await f.agent.dispose()
  const store = SessionStore.open(f.store.file)
  const replacement = new Agent({
    ai: f.ai,
    model: f.ai.model("mock/owner"),
    cwd: f.agent.cwd,
    session: store,
    ownedConversation: "project",
    tree: f.agent.tree,
    sections: [],
  })
  cleanups.push(() => replacement.dispose())
  const receipt = {
    id: "pending-private-late",
    late: true,
    usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, cost: 2 },
  }
  const append = fs.appendFileSync
  const failure = spyOn(fs, "appendFileSync").mockImplementation((file, ...args) => {
    if (String(file) === store.file) throw Object.assign(new Error("disk full"), { code: "ENOSPC" })
    return append(file, ...args)
  })
  try {
    record(receipt)
  } finally {
    failure.mockRestore()
  }
  const pending = conversationUsage(replacement)
  expect(pending.own).toMatchObject({ knownCostUsd: 0, complete: true })
  expect(pending.total).toMatchObject({ knownCostUsd: 2.3, complete: false })
  expect(pending.descendants.find((row) => row.sessionId === child.id)).toMatchObject({
    parentSessionId: f.agent.sessionId,
    groupId: group.id,
    ephemeral: true,
    usage: { knownCostUsd: 2.3, complete: false },
  })
  lateNativeUsage(replacement, model)(receipt)
  expect(f.agent.tree?.usage.cost).toBe(2.3)
  expect(group.info().usage.cost).toBe(2.3)
  expect(fs.readFileSync(store.file, "utf8")).not.toContain("PRIVATE PROMPT")
})

function failAfterReceiptAppend(file: string, marker = '"type":"side_usage"') {
  let landed = false
  let failed = false
  const appendFile = fs.appendFileSync
  const statFile = fs.statSync
  const append = spyOn(fs, "appendFileSync").mockImplementation(
    new Proxy(appendFile, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args)
        if (String(args[0]) === file && String(args[1]).includes(marker)) landed = true
        return result
      },
    }),
  )
  const stat = spyOn(fs, "statSync").mockImplementation(
    new Proxy(statFile, {
      apply(target, receiver, args) {
        if (String(args[0]) === file && landed && !failed) {
          failed = true
          throw Object.assign(new Error("stat failed after successful append"), { code: "EIO" })
        }
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  return {
    failed: () => failed,
    restore: () => {
      append.mockRestore()
      stat.mockRestore()
    },
  }
}

test("an appended late receipt whose following stat fails reconciles exactly once", async () => {
  const f = await fixture(0)
  const receipt = {
    id: "appended-before-stat-failure",
    late: true,
    usage: {
      input: 20,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 2,
    },
  }
  const failure = failAfterReceiptAppend(f.store.file)
  try {
    lateNativeUsage(f.agent, { provider: "mock", model: "owner" })(receipt)
    expect(failure.failed()).toBe(true)
    expect(conversationUsage(f.agent).own.knownCostUsd).toBe(2)
    expect(conversationUsage(f.agent).own.complete).toBe(false)
    expect(conversationUsage(SessionStore.open(f.store.file)).own.knownCostUsd).toBe(2)
  } finally {
    failure.restore()
  }
  const fresh = SessionStore.open(f.store.file)
  expect(fresh.entries.filter((entry) => entry.accounting?.receiptId === receipt.id)).toHaveLength(1)
  expect(f.agent.tree?.usage.cost).toBe(2)
})

test("private receipt append/stat failures retain one attributed charge without a retry duplicate", async () => {
  const f = await fixture(0)
  const group = f.agent.tree!.createGroup(f.agent, { name: "private research" })
  const failure = failAfterReceiptAppend(f.store.file)
  let id = ""
  try {
    const child = group.spawn({
      prompt: "PRIVATE PROMPT",
      title: "private worker",
      ephemeral: true,
      maxTurns: 1,
    })
    id = child.id
    expect((await child.result()).status).toBe("done")
    expect(failure.failed()).toBe(true)
  } finally {
    failure.restore()
  }
  const snapshot = conversationUsage(f.agent)
  expect(snapshot.own.knownCostUsd).toBe(0)
  expect(snapshot.total.knownCostUsd).toBe(0.3)
  expect(snapshot.descendants.find((row) => row.sessionId === id)).toMatchObject({
    parentSessionId: f.agent.sessionId,
    groupId: group.id,
    ephemeral: true,
    usage: { knownCostUsd: 0.3 },
  })
  const fresh = SessionStore.open(f.store.file)
  expect(fresh.entries.filter((entry) => entry.type === "side_usage")).toHaveLength(1)
  expect(conversationUsage(fresh).total.knownCostUsd).toBe(0.3)
  expect(f.agent.tree?.usage.cost).toBe(0.3)
  expect(fs.readFileSync(f.store.file, "utf8")).not.toContain("PRIVATE PROMPT")
})

test("remembered settled receipts missing from current disk evidence remain known but incomplete", async () => {
  const f = await fixture(0)
  const earlier = fs.readFileSync(f.store.file)
  lateNativeUsage(f.agent, { provider: "mock", model: "owner" })({
    id: "later-removed-durable-receipt",
    late: true,
    usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, cost: 2 },
  })
  expect(conversationUsage(f.agent).own).toMatchObject({ knownCostUsd: 2, complete: true })
  await f.agent.dispose()
  fs.writeFileSync(f.store.file, earlier)
  expect(conversationUsage(SessionStore.open(f.store.file)).own).toMatchObject({
    knownCostUsd: 2,
    complete: false,
  })
  expect(conversationUsage(f.agent).own).toMatchObject({ knownCostUsd: 2, complete: false })
})

test("a torn late receipt append keeps its full reported amount visible and incomplete", async () => {
  const f = await fixture(0)
  const append = fs.appendFileSync
  const failure = spyOn(fs, "appendFileSync").mockImplementation(
    new Proxy(append, {
      apply(target, receiver, args) {
        if (String(args[0]) === f.store.file && String(args[1]).includes('"type":"side_usage"')) {
          const partial = String(args[1]).slice(0, Math.floor(String(args[1]).length / 2))
          Reflect.apply(target, receiver, [args[0], partial, ...args.slice(2)])
          throw Object.assign(new Error("partial receipt write"), { code: "ENOSPC" })
        }
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  const receipt = {
    id: "torn-late-receipt",
    late: true,
    usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, cost: 2 },
  }
  try {
    lateNativeUsage(f.agent, { provider: "mock", model: "owner" })(receipt)
  } finally {
    failure.mockRestore()
  }
  expect(conversationUsage(f.agent).own).toMatchObject({ knownCostUsd: 2, complete: false })
  const fresh = SessionStore.open(f.store.file)
  expect(fresh.accountingDurable).toBe(false)
  expect(conversationUsage(fresh).own).toMatchObject({ knownCostUsd: 2, complete: false })
  lateNativeUsage(f.agent, { provider: "mock", model: "owner" })(receipt)
  expect(f.agent.tree?.usage.cost).toBe(2)
})

test("a completion whose first receipt lands before stat failure is not also retained as another charge", async () => {
  const f = await fixture(0)
  await f.agent.prompt("consume the fixture summary reply")
  await f.agent.dispose()
  const owned = await f.reader.forOwner("project").open(f.store.id, { askUser: async () => undefined })
  f.mock.push({ text: "paid completion", usage: { input: 20, output: 2, cost: 2 } })
  const failure = failAfterReceiptAppend(f.store.file)
  try {
    expect((await owned.complete({ messages: [] })).text).toBe("paid completion")
    expect(failure.failed()).toBe(true)
  } finally {
    failure.restore()
  }
  expect(f.main.tree?.usage.cost).toBe(2.3)
  expect(owned.usage().own.knownCostUsd).toBe(2.3)
  expect(conversationUsage(SessionStore.open(f.store.file)).own.knownCostUsd).toBe(2.3)
})

test("a reply whose first write lands before stat failure retains only its original receipt", async () => {
  const f = await fixture(0)
  const failure = failAfterReceiptAppend(f.store.file, '"role":"assistant"')
  try {
    await f.agent.prompt("paid reply")
    expect(failure.failed()).toBe(true)
  } finally {
    failure.restore()
  }
  expect(f.agent.tree?.usage.cost).toBe(0.3)
  expect(conversationUsage(f.agent).own.knownCostUsd).toBe(0.3)
  expect(conversationUsage(SessionStore.open(f.store.file)).own.knownCostUsd).toBe(0.3)
})

test("a timely native receipt is not added again beside its persisted compaction aggregate", async () => {
  const f = await fixture(0)
  const operation = f.agent.compact()
  await f.entered.promise
  f.payNative()
  expect(await operation).toBe(true)
  expect(conversationUsage(f.agent).own.knownCostUsd).toBe(2)
  await f.agent.dispose()
  expect((await f.reader.forOwner("project").read({ key: "native" }))?.usage.own.knownCostUsd).toBe(2)
})
