import "./offline.ts"
import { expect, test } from "bun:test"
import { copyHistory, historyPageEnd } from "../../src/server/history-pages.ts"

test("history pages honor byte limits even below their message-count limit", () => {
  const message = { role: "user", content: [{ type: "text", text: "x".repeat(5 * 1024 * 1024) }] }
  const snapshot = copyHistory([message, message])
  expect(snapshot.messages).toHaveLength(2)
  expect(historyPageEnd(snapshot.sizes, 0, 100)).toBe(1)
  expect(historyPageEnd(snapshot.sizes, 1, 100)).toBe(2)
  expect(Object.isFrozen(snapshot.messages)).toBe(true)
  expect(() => copyHistory(Array(7).fill(message))).toThrow("snapshot limit")
  expect(() =>
    copyHistory([{ role: "user", content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }] }]),
  ).toThrow("page limit")
  expect(() => copyHistory(Array(10_001).fill(null))).toThrow("snapshot limit")
})

test("history budgeting rejects executable properties before cloning", () => {
  let reads = 0
  expect(() =>
    copyHistory([
      {
        get content() {
          reads++
          return []
        },
      },
    ]),
  ).toThrow("Invalid")
  expect(reads).toBe(0)
})
