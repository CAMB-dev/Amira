import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, emptyUsage } from "@amira/ai"
import { reportedUsage } from "../src/accounting-receipts.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { ownedDirectory, ownedId } from "../src/owned-conversations-storage.ts"
import { conversationUsage } from "../src/owned-conversations-usage.ts"
import { SessionStore } from "../src/session-store.ts"
import { consultationUsageRecorder } from "../src/subagents/consultation-usage.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function home() {
  const result = mkdtempSync(path.join(tmpdir(), "amira-accounting-recovery-"))
  homes.push(result)
  return result
}

for (const field of ["missing usage", "null input"] as const) {
  test(`a structurally damaged receipt (${field}) cannot certify zero spend`, () => {
    const directory = home()
    const store = SessionStore.create({ cwd: directory, dir: directory })
    store.append({
      type: "side_usage",
      model: { provider: "mock", model: "test" },
      usage: { ...emptyUsage(), cost: 2 },
    })
    const lines = readFileSync(store.file, "utf8").trimEnd().split("\n")
    const row = JSON.parse(lines[1]!)
    if (field === "missing usage") delete row.usage
    else row.usage.input = null
    lines[1] = JSON.stringify(row)
    writeFileSync(store.file, `${lines.join("\n")}\n`)
    const reopened = SessionStore.open(store.file)
    expect(() => conversationUsage(reopened)).toThrow("Invalid accounting")
  })
}

test("late token pricing replaces the unknown contribution and survives serialization/restart", () => {
  const directory = home()
  const store = SessionStore.create({ cwd: directory, dir: directory })
  const record = consultationUsageRecorder((usage) => {
    store.append({
      type: "side_usage",
      model: { provider: "mock", model: "test" },
      usage: reportedUsage(usage),
    })
  })
  const unknown = { ...emptyUsage(), input: 10 }
  delete unknown.cost
  record.observe?.(unknown)
  const before = conversationUsage(store)
  expect(before.total.complete).toBe(false)
  record({ ...unknown, cost: 2 })
  const after = conversationUsage(store)
  expect(after.revision).toBeGreaterThan(before.revision)
  expect(after.total.complete).toBe(true)
  expect(after.total.usage.input).toBe(10)
  expect(after.total.knownCostUsd).toBe(2)
  expect(JSON.parse(JSON.stringify(after))).toEqual(conversationUsage(SessionStore.open(store.file)))
})

test("confirmed pricing replaces an earlier estimate rather than making pricingUnknown permanent", () => {
  const directory = home()
  const store = SessionStore.create({ cwd: directory, dir: directory })
  const record = consultationUsageRecorder((usage) => {
    store.append({
      type: "side_usage",
      model: { provider: "mock", model: "test" },
      usage: reportedUsage(usage),
    })
  })
  record.observe?.({ ...emptyUsage(), input: 10, cost: 2, pricingUnknown: true })
  expect(conversationUsage(store).total.complete).toBe(false)
  record({ ...emptyUsage(), input: 10, cost: 1 })
  const snapshot = conversationUsage(SessionStore.open(store.file))
  expect(snapshot.total.complete).toBe(true)
  expect(snapshot.total.usage.pricingUnknown).toBeUndefined()
  expect(snapshot.total.knownCostUsd).toBe(1)
})

for (const operation of ["send", "complete"] as const) {
  test(`a process crash during owned ${operation} retains unknown coverage, not complete zero`, async () => {
    const directory = home()
    const script = `
      import { createAi, createMockDialect } from ${JSON.stringify(new URL("../../ai/src/index.ts", import.meta.url).href)};
      import { Agent } from ${JSON.stringify(new URL("../src/agent.ts", import.meta.url).href)};
      import { OwnedConversationManager } from ${JSON.stringify(new URL("../src/owned-conversations.ts", import.meta.url).href)};
      import { AgentTree } from ${JSON.stringify(new URL("../src/subagents.ts", import.meta.url).href)};
      import { ToolRegistry } from ${JSON.stringify(new URL("../src/tool-registry.ts", import.meta.url).href)};
      const home = ${JSON.stringify(directory)};
      const mock = createMockDialect([() => { console.log("provider accepted"); process.exit(0) }]);
      const ai = createAi({ dialects: [mock], providers: [{id:"mock", dialect:"mock", baseUrl:"https://provider.invalid"}], retry:{retries:0} });
      const tree = new AgentTree({ai,sections:()=>[]});
      const tools = new ToolRegistry();
      const main = new Agent({ai,model:ai.model("mock/test"),cwd:home,tree,tools,sections:[]});
      const manager = new OwnedConversationManager({ai,tree,tools,home,agent:()=>main});
      const owned = await manager.forOwner("project").openOrCreate({key:"crash",name:"Crash",cwd:home,systemPrompt:"",callableTools:[]},{askUser:async()=>undefined});
      await owned.${operation}(${operation === "send" ? '"work"' : "{messages:[]}"});
      throw new Error("mock must terminate during the request");
    `
    const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(stdout).toContain("provider accepted")
    const ai = createAi({ dialects: [], providers: [] })
    const manager = new OwnedConversationManager({
      ai,
      tree: new AgentTree({ ai, sections: () => [] }),
      tools: new ToolRegistry(),
      home: directory,
      agent: () => {
        throw new Error("inert read must not obtain an agent")
      },
    })
    try {
      const snapshot = await manager.forOwner("project").read({ key: "crash" })
      expect(snapshot?.usage.total.knownCostUsd).toBe(0)
      expect(snapshot?.usage.total.complete).toBe(false)
      const file = path.join(ownedDirectory(directory, "project"), `${ownedId("project", "crash")}.jsonl`)
      expect(readFileSync(file, "utf8")).toContain("amira.accounting-requests")
    } finally {
      await manager.drain()
    }
  }, 30_000)
}
