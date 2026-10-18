import { expect, test } from "bun:test"
import type {
  AccountedUsage,
  ConversationUsageSnapshot,
  OwnedConversation,
  OwnedConversationRef,
  OwnedConversationSnapshot,
  OwnedConversations,
} from "../src/index.ts"

test("owned accounting, inert reads and bound completion are public contracts", async () => {
  const own: AccountedUsage = {
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, pricingUnknown: true },
    knownCostUsd: 0.25,
    complete: false,
  }
  const usage: ConversationUsageSnapshot = {
    sessionId: "owned",
    revision: 3,
    own,
    total: own,
    descendants: [],
  }
  const snapshot: OwnedConversationSnapshot = {
    id: "owned",
    key: "project/design",
    name: "Design",
    cwd: "/workspace",
    archived: false,
    history: [],
    usage,
  }
  const byId: OwnedConversationRef = { id: snapshot.id }
  const byKey: OwnedConversationRef = { key: snapshot.key }
  const read: OwnedConversations["read"] = async () => snapshot
  const current: OwnedConversation["usage"] = () => usage
  const complete: OwnedConversation["complete"] = async (request) => ({
    text: request.label ?? "",
    message: { role: "assistant", model: { provider: "mock", model: "test" }, content: [] },
  })
  expect(await read(byId)).toEqual(await read(byKey))
  expect(current()).toBe(usage)
  expect((await complete({ messages: [], label: "spec" })).text).toBe("spec")
  expect(JSON.parse(JSON.stringify(snapshot))).toMatchInlineSnapshot(`
    {
      "archived": false,
      "cwd": "/workspace",
      "history": [],
      "id": "owned",
      "key": "project/design",
      "name": "Design",
      "usage": {
        "descendants": [],
        "own": {
          "complete": false,
          "knownCostUsd": 0.25,
          "usage": {
            "cacheRead": 0,
            "cacheWrite": 0,
            "input": 10,
            "output": 2,
            "pricingUnknown": true,
          },
        },
        "revision": 3,
        "sessionId": "owned",
        "total": {
          "complete": false,
          "knownCostUsd": 0.25,
          "usage": {
            "cacheRead": 0,
            "cacheWrite": 0,
            "input": 10,
            "output": 2,
            "pricingUnknown": true,
          },
        },
      },
    }
  `)
})
