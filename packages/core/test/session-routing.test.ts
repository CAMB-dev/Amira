import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { registerSessionScope, sessionScopeContains } from "../src/session-routing.ts"
import { AgentTree } from "../src/subagents.ts"

test("native routing follows parent identity, not whichever main root currently uses the tree", () => {
  const ai = createAi({ dialects: [createMockDialect()], providers: [] })
  const tree = new AgentTree({ ai, sections: () => [] })
  const live = new Map([
    ["private-child", { parentSessionId: "old-main" }],
    ["grandchild", { parentSessionId: "private-child" }],
  ])
  const spawned = new Map([["finished-child", { info: { parentSessionId: "old-main" } }]])
  const disposing = new Map([["draining-child", { parent: "old-main" }]])
  registerSessionScope(tree, live, spawned, disposing)
  for (const id of ["private-child", "grandchild", "finished-child", "draining-child"]) {
    expect(sessionScopeContains(tree, id, "old-main")).toBe(true)
    expect(sessionScopeContains(tree, id, "new-main")).toBe(false)
  }
  expect(sessionScopeContains(tree, "unrelated", "old-main")).toBe(false)
  live.delete("private-child")
  expect(sessionScopeContains(tree, "grandchild", "old-main")).toBe(false)
})

test("native routing fails closed for unrelated scopes and malformed parent cycles", () => {
  const ai = createAi({ dialects: [createMockDialect()], providers: [] })
  const tree = new AgentTree({ ai, sections: () => [] })
  const sibling = new AgentTree({ ai, shared: tree, sections: () => [] })
  registerSessionScope(
    tree,
    new Map([
      ["a", { parentSessionId: "b" }],
      ["b", { parentSessionId: "a" }],
    ]),
    new Map(),
    new Map(),
  )
  expect(sessionScopeContains(tree, "a", "main")).toBe(false)
  expect(sessionScopeContains(sibling, "a", "main")).toBe(false)
})
