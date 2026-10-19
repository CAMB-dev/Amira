import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as bounded from "../src/frontend/bounded-history.ts"
import * as native from "../src/frontend/native-conversations.ts"
import * as roots from "../src/frontend/scope-root.ts"
import * as branch from "../src/session-branch-reader.ts"
import { SessionStore } from "../src/session-store.ts"

test("native host helpers have explicit exports without widening the extension API", () => {
  expect(Object.keys(bounded).sort()).toEqual(["copyHistory", "historyPageEnd", "readAgentHistory"])
  expect(Object.keys(native).sort()).toEqual([
    "nativeConversationActivity",
    "nativeConversationHistory",
    "registerNativeFrontend",
  ])
  expect(Object.keys(roots).sort()).toEqual(["agentScopeRoot", "registerAgentScopeRoot"])
  expect(Object.keys(branch).sort()).toEqual(["registerSessionBranchReader", "sessionBranchEntries"])
})

test("lazy branch access follows checkout without materializing an unrelated branch", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-branch-reader-"))
  const store = SessionStore.create({ cwd: dir, dir })
  try {
    const first = store.appendMessage({ role: "user", content: [{ type: "text", text: "first" }] })
    store.appendMessage({ role: "user", content: [{ type: "text", text: "second" }] })
    expect([...branch.sessionBranchEntries(store)].reverse()).toEqual(store.branch())
    store.append({ type: "checkout", target: first })
    const history = bounded.copyHistory(
      (function* () {
        for (const entry of branch.sessionBranchEntries(store))
          if (entry.type === "message") yield entry.message
      })(),
      true,
    )
    expect(history.messages).toEqual([{ role: "user", content: [{ type: "text", text: "first" }] }])
    expect(Object.isFrozen(history.messages)).toBe(true)
  } finally {
    store.release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("history budgets reject giant sparse content before a clone can allocate its length", () => {
  const content = new Array(1_000_000_000)
  expect(() => bounded.copyHistory([{ role: "user", content }])).toThrow("snapshot limit")
})
