import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, emptyUsage } from "@amira/ai"
import { reportedUsage } from "../src/accounting-receipts.ts"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { accountingDescendants } from "../src/owned-conversations-descendants.ts"
import { conversationUsage } from "../src/owned-conversations-usage.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-accounting-descendants-"))
  dirs.push(dir)
  const root = SessionStore.create({ cwd: dir, dir, id: "root" })
  charge(root, 0.2)
  const child = addChild(root, "child", 2)
  return { root, child }
}

function charge(store: SessionStore, cost: number) {
  store.append({
    type: "side_usage",
    model: { provider: "mock", model: "m" },
    usage: reportedUsage({ ...emptyUsage(), input: 1, output: 1, cost }),
  })
}

function addChild(parent: SessionStore, id: string, cost: number, groupId?: string) {
  const child = SessionStore.create({
    cwd: parent.header.cwd,
    dir: path.join(path.dirname(parent.file), "subagents"),
    id,
    parent: parent.id,
  })
  charge(child, cost)
  parent.append({
    type: "subagent",
    childSessionId: child.id,
    role: "worker",
    ...(groupId ? { groupId } : {}),
  })
  return child
}

function replaceMarker(store: SessionStore, childSessionId: unknown) {
  rewrite(store, (entry) => {
    if (entry.type === "subagent") entry.childSessionId = childSessionId
  })
}

function rewrite(store: SessionStore, mutate: (entry: Record<string, unknown>) => void) {
  const lines = readFileSync(store.file, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => {
      const entry = JSON.parse(line)
      mutate(entry)
      return JSON.stringify(entry)
    })
  writeFileSync(store.file, `${lines.join("\n")}\n`)
}

function descendants(root: SessionStore) {
  const fresh = SessionStore.open(root.file)
  return accountingDescendants(fresh.id, fresh)
}

function expectUnknownReference(root: SessionStore) {
  const result = descendants(root)
  expect(
    result.requirements.some((requirement) => requirement.kind === "reference" && !requirement.verified),
  ).toBe(true)
  return result
}

test("fresh accounting retains the known root subtotal but cannot certify an empty descendant id", () => {
  const { root } = fixture()
  expect(conversationUsage(SessionStore.open(root.file)).total).toMatchObject({
    knownCostUsd: 2.2,
    complete: true,
  })
  replaceMarker(root, "")
  const snapshot = conversationUsage(SessionStore.open(root.file))
  expect(snapshot.own).toMatchObject({ knownCostUsd: 0.2, complete: false })
  expect(snapshot.total).toMatchObject({ knownCostUsd: 0.2, complete: false })
  expect(snapshot.descendants).toEqual([])
})

for (const id of [
  "",
  " ",
  "../child",
  "child/escape",
  ".",
  "..",
  "child\n",
  "child\r",
  "child\u0000",
  null,
  17,
  true,
  ["child"],
  {},
]) {
  test(`accounting helper rejects malformed persisted descendant id ${JSON.stringify(id)}`, () => {
    const { root } = fixture()
    replaceMarker(root, id)
    expect(expectUnknownReference(root).entries).toEqual([])
  })
}

test("a non-string marker cannot borrow a different child's transcript through string coercion", () => {
  const { root } = fixture()
  addChild(root, "17", 9)
  replaceMarker(root, 17)
  expect(expectUnknownReference(root).entries).toEqual([])
  const snapshot = conversationUsage(SessionStore.open(root.file))
  expect(snapshot.descendants).toEqual([])
  expect(snapshot.total).toMatchObject({ knownCostUsd: 0.2, complete: false })
})

for (const damage of ["missing", "unreadable"] as const) {
  test(`accounting helper leaves ${damage} child evidence unverified`, () => {
    const { root, child } = fixture()
    if (damage === "missing") rmSync(child.file)
    else writeFileSync(child.file, "not a session file\n")
    const result = expectUnknownReference(root)
    expect(result.entries.map((entry) => entry.info.id)).toEqual([child.id])
    expect(result.entries[0]?.session).toBeUndefined()
    expect(conversationUsage(SessionStore.open(root.file)).total).toMatchObject({
      knownCostUsd: 0.2,
      complete: false,
    })
  })
}

test("a retained live child store cannot certify a missing persisted child file", () => {
  const { root, child } = fixture()
  const entry = descendants(root).entries[0]!
  const ai = createAi({
    dialects: [createMockDialect()],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  const children = spyOn(tree, "childrenOf").mockImplementation((id) => (id === root.id ? [child.id] : []))
  const known = spyOn(tree, "subagent").mockImplementation((id) =>
    id === child.id ? { info: entry.info, session: child } : undefined,
  )
  try {
    rmSync(child.file)
    const result = accountingDescendants(root.id, root, tree)
    expect(result.entries[0]?.session).toBe(child)
    expect(result.requirements.some((requirement) => !requirement.verified)).toBe(true)
    expect(conversationUsage(root, tree).total).toMatchObject({ knownCostUsd: 2.2, complete: false })
  } finally {
    children.mockRestore()
    known.mockRestore()
  }
})

test("malformed markers inside reachable persisted children also invalidate coverage", () => {
  const { root, child } = fixture()
  addChild(child, "leaf", 3)
  replaceMarker(child, "")
  expect(expectUnknownReference(root).entries.map((entry) => entry.info.id)).toEqual([child.id])
  const snapshot = conversationUsage(SessionStore.open(root.file))
  expect(snapshot.own.complete).toBe(true)
  expect(snapshot.total).toMatchObject({ knownCostUsd: 2.2, complete: false })
})

test("duplicate markers retain one charge but cannot certify the graph", () => {
  const { root, child } = fixture()
  root.append({ type: "subagent", childSessionId: child.id, role: "worker", groupId: "conflicting_group" })
  expect(expectUnknownReference(root).entries.map((entry) => entry.info.id)).toEqual([child.id])
  expect(conversationUsage(SessionStore.open(root.file)).total).toMatchObject({
    knownCostUsd: 2.2,
    complete: false,
  })
})

test("ancestor cycles cannot disappear behind traversal deduplication", () => {
  const { root, child } = fixture()
  child.append({ type: "subagent", childSessionId: root.id, role: "worker" })
  expect(expectUnknownReference(root).entries.map((entry) => entry.info.id)).toEqual([child.id])
  expect(conversationUsage(SessionStore.open(root.file)).total).toMatchObject({
    knownCostUsd: 2.2,
    complete: false,
  })
})

test("conflicting parents retain reachable paid work once and leave coverage unknown", () => {
  const { root, child } = fixture()
  const sibling = addChild(root, "sibling", 3)
  sibling.append({ type: "subagent", childSessionId: child.id, role: "worker" })
  expect(expectUnknownReference(root).entries.map((entry) => entry.info.id)).toEqual([child.id, sibling.id])
  expect(conversationUsage(SessionStore.open(root.file)).total).toMatchObject({
    knownCostUsd: 5.2,
    complete: false,
  })
})

for (const field of ["id", "parent"] as const) {
  test(`mismatched child header ${field} cannot authorize that child's transcript or descendants`, () => {
    const { root, child } = fixture()
    addChild(child, "leaf", 3)
    child.appendMessage({ role: "user", content: [{ type: "text", text: "UNAUTHORIZED TRANSCRIPT" }] })
    rewrite(child, (entry) => {
      if (entry.type === "session") entry[field] = "unrelated"
    })
    expect(expectUnknownReference(root).entries).toEqual([])
    const snapshot = conversationUsage(SessionStore.open(root.file))
    expect(snapshot.descendants).toEqual([])
    expect(snapshot.total).toMatchObject({ knownCostUsd: 0.2, complete: false })
    expect(JSON.stringify(snapshot)).not.toContain("UNAUTHORIZED TRANSCRIPT")
  })
}

test("nested children, sibling groups and abandoned branches retain each paid child once", () => {
  const { root, child } = fixture()
  const leaf = addChild(child, "leaf", 3, "nested_group")
  root.append({ type: "checkout", target: null })
  const sibling = addChild(root, "sibling", 4, "sibling_group")
  const result = descendants(root)
  expect(result.requirements.every((requirement) => requirement.verified)).toBe(true)
  expect(result.entries.map((entry) => [entry.info.id, entry.info.depth, entry.info.groupId])).toEqual([
    [child.id, 1, undefined],
    [leaf.id, 2, "nested_group"],
    [sibling.id, 1, "sibling_group"],
  ])
  const snapshot = conversationUsage(SessionStore.open(root.file))
  expect(snapshot.total).toMatchObject({ knownCostUsd: 9.2, complete: true })
  expect(snapshot.descendants).toHaveLength(3)
})

test("live tree and persisted marker references to the same grouped child are not duplicate evidence", async () => {
  const { root } = fixture()
  const mock = createMockDialect()
  mock.push({ text: "done", usage: { ...emptyUsage(), input: 1, output: 1, cost: 1 } })
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const tree = new AgentTree({ ai, sections: () => [] })
  const agent = new Agent({
    ai,
    tree,
    session: root,
    cwd: root.header.cwd,
    model: ai.model("mock/m"),
    tools: new ToolRegistry(),
    bus: new EventBus(),
  })
  try {
    const group = tree.createGroup(agent, { name: "group" })
    const liveChild = group.spawn({ prompt: "task" })
    await liveChild.result()
    const result = accountingDescendants(root.id, root, tree)
    expect(result.requirements.every((requirement) => requirement.verified)).toBe(true)
    expect(result.entries.filter((entry) => entry.info.id === liveChild.id)).toHaveLength(1)
    expect(result.entries.find((entry) => entry.info.id === liveChild.id)?.info.groupId).toBe(group.id)
    const snapshot = conversationUsage(agent)
    expect(snapshot.total).toMatchObject({ knownCostUsd: 3.2, complete: true })
    expect(conversationUsage(SessionStore.open(root.file))).toEqual(snapshot)
  } finally {
    await agent.dispose()
  }
})
