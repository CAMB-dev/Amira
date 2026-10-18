import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { addUsage, createAi, createMockDialect, emptyUsage } from "@amira/ai"
import { completeAccounting, requestCoverage, usageCoverage } from "../src/accounting-coverage.ts"
import { validJournalEntry } from "../src/accounting-journal.ts"
import { reportedUsage } from "../src/accounting-receipts.ts"
import { accountingRecorded, withAccountingRequests } from "../src/accounting-requests.ts"
import { Agent } from "../src/agent.ts"
import { completeForAgent } from "../src/completion.ts"
import { conversationUsage } from "../src/owned-conversations-usage.ts"
import { type SessionEntry, SessionStore } from "../src/session-store.ts"
import { accountUsage, entryUsage, storedSessionUsage } from "../src/session-usage.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}

async function paidRequests() {
  const home = mkdtempSync(path.join(tmpdir(), "amira-coverage-property-"))
  const mock = createMockDialect([
    { text: "first", usage: { input: 3, output: 2, cost: 0.2 } },
    { error: { message: "retry", retryable: true }, usage: { input: 2, output: 1, cost: 0.1 } },
    { text: "last", usage: { input: 4, output: 2, cost: 0.3 } },
  ])
  const base = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 1, baseDelayMs: 0 },
  })
  const store = SessionStore.create({ cwd: home, dir: home })
  const agent = new Agent({
    ai: base,
    model: base.model("mock/test"),
    cwd: home,
    session: store,
    sections: [],
  })
  cleanup.push(async () => {
    await agent.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const ai = withAccountingRequests(base, agent, () => ({ store }))
  for (let request = 0; request < 2; request++) {
    for await (const event of ai.stream({ model: agent.model, systemPrompt: "", messages: [], tools: [] })) {
      if ((event.type === "request.end" || event.type === "done") && event.message.usage) {
        store.append({ type: "side_usage", model: event.message.model, usage: event.message.usage })
        accountingRecorded(agent, event.message.usage)
      }
    }
  }
  return { store, entries: JSON.parse(JSON.stringify(store.entries)) as SessionEntry[], agent, base }
}

function snapshot(entries: SessionEntry[], sessionId: string) {
  const supported = new Set(["model_change", "custom", "side_usage"])
  const records = entries.flatMap((entry) => {
    const usage = entryUsage(entry)
    return usage ? [{ usage, ...entry.accounting, durable: true }] : []
  })
  return accountUsage(records, [
    { kind: "integrity", verified: entries.every((entry) => validJournalEntry(entry, supported, sessionId)) },
    ...requestCoverage(entries),
  ])
}

test("positive coverage survives serialization before adversarial mutation", async () => {
  const { store, entries } = await paidRequests()
  expect(snapshot(entries, store.id)).toMatchObject({ knownCostUsd: expect.closeTo(0.6), complete: true })
  expect(storedSessionUsage(SessionStore.open(store.file)).complete).toBe(true)
})

for (const tail of ["receipt", "end"] as const) {
  for (const partial of [false, true]) {
    test(`v1 tail truncation ${partial ? "inside" : "before"} the final ${tail} keeps surviving request evidence incomplete`, async () => {
      const { store } = await paidRequests()
      expect(conversationUsage(store).own).toMatchObject({
        knownCostUsd: expect.closeTo(0.6),
        complete: true,
      })
      const lines = readFileSync(store.file, "utf8").trimEnd().split("\n")
      const index = lines.findLastIndex((line) => {
        const entry = JSON.parse(line)
        return tail === "receipt" ? entry.type === "side_usage" : entry.data?.phase === "end"
      })
      expect(index).toBeGreaterThan(0)
      const prefix = `${lines.slice(0, index).join("\n")}\n`
      const truncated = prefix + (partial ? lines[index]!.slice(0, Math.floor(lines[index]!.length / 2)) : "")
      writeFileSync(store.file, truncated)
      const fresh = conversationUsage(SessionStore.open(store.file)).own
      expect(fresh).toMatchObject({
        knownCostUsd: expect.closeTo(tail === "end" ? 0.6 : 0.3),
        complete: false,
      })
      expect(conversationUsage(store).own).toMatchObject({
        knownCostUsd: expect.closeTo(0.6),
        complete: false,
      })
      expect(readFileSync(store.file, "utf8")).toBe(truncated)
    })
  }
}

test("seeded drops, omissions and corruption of required request/receipt evidence never certify completeness", async () => {
  const { store, entries: baseline } = await paidRequests()
  // Deliberately untyped JSON mutations model corrupted persisted bytes, not valid TypeScript input.
  const mutations: ((entries: any[], next: () => number) => void)[] = [
    (entries, next) => {
      const rows = entries.filter((e) => e.type === "side_usage")
      entries.splice(entries.indexOf(rows[Math.floor(next() * rows.length)]), 1)
    },
    (entries) => {
      delete entries.find((e) => e.type === "side_usage").accounting.coverage
    },
    (entries) => {
      delete entries.find((e) => e.type === "side_usage").accounting.seal
    },
    (entries) => {
      delete entries.find((e) => e.type === "side_usage").accounting.knownCostUsd
    },
    (entries, next) => {
      entries.find((e) => e.type === "side_usage").usage.input += 1 + Math.floor(next() * 50)
    },
    (entries) => {
      entries.find((e) => e.type === "side_usage").accounting.knownCostUsd += 1
    },
    (entries) => {
      entries.find((e) => e.type === "side_usage").accounting.coverage.fingerprint = "0".repeat(64)
    },
    (entries) => {
      entries.find((e) => e.type === "side_usage").accounting.attempts = []
    },
    (entries) => {
      entries.find((e) => e.type === "side_usage").accounting.attempts = [null]
    },
    (entries) => {
      delete entries.find((e) => e.type === "side_usage").accounting.source
    },
    (entries) => {
      entries.find((e) => e.type === "side_usage").usage.outputReported = false
    },
    (entries) => {
      entries.find((e) => e.type === "side_usage").usage.cost = undefined
    },
    (entries) => {
      entries.splice(
        entries.findIndex((e) => e.type === "custom" && e.data.phase === "start"),
        1,
      )
    },
    (entries) => {
      entries.splice(
        entries.findIndex((e) => e.type === "custom" && e.data.phase === "end"),
        1,
      )
    },
    (entries) => {
      entries.splice(
        entries.findIndex((e) => e.type === "custom" && e.data.phase === "attempt"),
        1,
      )
    },
    (entries) => {
      delete entries.find((e) => e.type === "custom" && e.data.phase === "end").data.attemptCount
    },
    (entries) => {
      entries.find((e) => e.type === "custom" && e.data.phase === "end").data.attempts = []
    },
    (entries) => {
      entries.find((e) => e.type === "custom" && e.data.phase === "end").data.attempts[0].receipts = []
    },
    (entries) => {
      entries.find((e) => e.type === "custom" && e.data.phase === "start").data = null
    },
  ]
  for (let seed = 1; seed <= 384; seed++) {
    const next = random(seed * 7919)
    const entries = JSON.parse(JSON.stringify(baseline))
    mutations[Math.floor(next() * mutations.length)]!(entries, next)
    expect(snapshot(entries, store.id).complete).toBe(false)
  }
})

test("the completeness seam rejects absent proofs even if a caller assumes integrity", async () => {
  const { store } = await paidRequests()
  const records = store.entries
    .filter((entry) => entry.type === "side_usage")
    .map((entry) => ({ usage: entry.usage, ...entry.accounting, durable: true }))
  const requirements = [{ kind: "integrity" as const, verified: true }, ...requestCoverage(store.entries)]
  expect(accountUsage(records, true).complete).toBe(false)
  expect(accountUsage(records, requirements).complete).toBe(true)
  for (const field of ["coverage", "seal", "source", "knownCostUsd", "attempts"] as const) {
    const corrupted = JSON.parse(JSON.stringify(records))
    delete corrupted[0][field]
    expect(accountUsage(corrupted, requirements).complete).toBe(false)
  }
  const unknown = { ...emptyUsage(), input: 2 }
  expect(
    completeAccounting(
      [
        {
          usage: unknown,
          knownCostUsd: 0,
          durable: true,
          source: "reported",
          coverage: usageCoverage(unknown),
        },
      ],
      [{ kind: "integrity", verified: true }],
    ),
  ).toBe(false)
})

test("seeded omissions and corruptions cannot certify a reconciled full-state revision history", async () => {
  const { store, agent, base } = await paidRequests()
  const model = base.model("mock/test")
  const first = { ...emptyUsage(), input: 10, output: 2, cost: 0.2 }
  const partial = addUsage({ ...first, cost: 0.3 }, { ...emptyUsage(), webSearchRequests: 1 })
  const final = { ...first, cost: 0.4, webSearchRequests: 1, webSearchCost: 0.1 }
  base.stream = async function* () {
    const message = {
      role: "assistant" as const,
      model: { provider: "mock", model: "test" },
      content: [{ type: "text" as const, text: "done" }],
      stop: "stop" as const,
    }
    yield { type: "request.end", message: { ...message, usage: first } }
    yield { type: "request.end", message: { ...message, usage: partial } }
    yield { type: "done", message: { ...message, usage: final } }
  }
  await completeForAgent({ ai: base, agent, model, request: { messages: [] }, label: "revision" })
  const entries = JSON.parse(JSON.stringify(store.entries)) as SessionEntry[]
  expect(snapshot(entries, store.id)).toMatchObject({ knownCostUsd: 1, complete: true })
  const indices = entries.flatMap((entry, index) => (entry.accounting?.statements?.length ? [index] : []))
  expect(indices).toHaveLength(5)
  const next = random(0x51a7e)
  for (let run = 0; run < 192; run++) {
    const changed = JSON.parse(JSON.stringify(entries)) as SessionEntry[]
    const accounting = changed[indices[Math.floor(next() * indices.length)]!]!.accounting!
    const statement = accounting.statements![0]!
    switch (Math.floor(next() * 10)) {
      case 0:
        delete accounting.statements
        break
      case 1:
        accounting.statements!.pop()
        break
      case 2:
        statement.kind = statement.kind === "snapshot" ? "credit" : "snapshot"
        break
      case 3:
        statement.id = ""
        break
      case 4:
        statement.revision += 2
        break
      case 5:
        statement.coverage.fingerprint = ""
        break
      case 6:
        statement.knownCostUsd += 0.11
        break
      case 7:
        statement.attempts = []
        break
      case 8:
        statement.usage.outputReported = false
        break
      case 9:
        statement.usage.input += 1
        break
    }
    expect(snapshot(changed, store.id).complete).toBe(false)
  }
  for (const index of indices) {
    const changed = [...entries]
    changed.splice(index, 1)
    expect(snapshot(changed, store.id).complete).toBe(false)
  }
})

test("even individually valid receipts cannot certify non-serializable aggregate totals", () => {
  const home = mkdtempSync(path.join(tmpdir(), "amira-overflow-coverage-"))
  const store = SessionStore.create({ cwd: home, dir: home })
  try {
    for (let index = 0; index < 2; index++)
      store.append({
        type: "side_usage",
        model: { provider: "mock", model: "test" },
        usage: reportedUsage({ ...emptyUsage(), cost: 1e308 }),
      })
    expect(() => storedSessionUsage(store)).toThrow("Invalid accounting aggregate")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("pricing alone never turns an unfenced contribution into positive coverage", () => {
  const home = mkdtempSync(path.join(tmpdir(), "amira-unfenced-coverage-"))
  const store = SessionStore.create({ cwd: home, dir: home })
  try {
    store.append({
      type: "side_usage",
      model: { provider: "mock", model: "test" },
      usage: { ...emptyUsage(), input: 2, cost: 2 },
    })
    const snapshot = conversationUsage(SessionStore.open(store.file))
    expect(snapshot.own).toMatchObject({ knownCostUsd: 2, complete: false })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("hidden unknown coverage cannot become complete after zero-net aggregation and serialization", () => {
  const home = mkdtempSync(path.join(tmpdir(), "amira-hidden-coverage-"))
  const store = SessionStore.create({ cwd: home, dir: home })
  try {
    const hidden = addUsage(addUsage({ ...emptyUsage(), input: 10 }, { ...emptyUsage(), input: -10 }), {
      ...emptyUsage(),
      cost: 0.3,
    })
    store.append({
      type: "side_usage",
      model: { provider: "mock", model: "test" },
      usage: reportedUsage(hidden),
    })
    const snapshot = conversationUsage(SessionStore.open(store.file))
    expect(snapshot.own).toMatchObject({ knownCostUsd: 0.3, complete: false })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("seeded malformed, omitted and missing descendant evidence stays incomplete", () => {
  const home = mkdtempSync(path.join(tmpdir(), "amira-reference-property-"))
  const root = SessionStore.create({ cwd: home, dir: home })
  root.append({
    type: "side_usage",
    model: { provider: "mock", model: "test" },
    usage: reportedUsage({ ...emptyUsage(), input: 2, cost: 0.2 }),
  })
  const child = SessionStore.create({ cwd: home, dir: path.join(home, "subagents"), parent: root.id })
  child.append({
    type: "side_usage",
    model: { provider: "mock", model: "test" },
    usage: reportedUsage({ ...emptyUsage(), input: 20, cost: 2 }),
  })
  root.append({ type: "subagent", childSessionId: child.id, role: "worker" })
  const baseline = readFileSync(root.file, "utf8")
  const childBytes = readFileSync(child.file)
  try {
    expect(conversationUsage(SessionStore.open(root.file)).total).toMatchObject({
      knownCostUsd: 2.2,
      complete: true,
    })
    for (let seed = 1; seed <= 96; seed++) {
      const next = random(seed * 7907)
      const entries: any[] = baseline
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line))
      const marker = entries.find((entry) => entry.type === "subagent")
      const proof = entries.find(
        (entry) => entry.type === "custom" && entry.ext === "amira.accounting-references",
      )
      switch (Math.floor(next() * 7)) {
        case 0:
          marker.childSessionId = ""
          break
        case 1:
          delete marker.childSessionId
          break
        case 2:
          marker.childSessionId = "../escape"
          break
        case 3:
          marker.childSessionId = "missing-child"
          break
        case 4:
          entries.splice(entries.indexOf(marker), 1)
          break
        case 5:
          entries.splice(entries.indexOf(proof), 1)
          break
        default:
          proof.data.fingerprint = "bad"
          break
      }
      writeFileSync(root.file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
      expect(conversationUsage(SessionStore.open(root.file)).total.complete).toBe(false)
    }
    writeFileSync(root.file, baseline)
    rmSync(child.file)
    expect(conversationUsage(SessionStore.open(root.file)).total.complete).toBe(false)
    writeFileSync(child.file, childBytes)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
