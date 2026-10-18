import { expect, test } from "bun:test"
import { safeJson } from "../src/json-output.ts"

test("neutral JSON output preserves ASCII escaping, BigInts and shared values", () => {
  const shared = { text: "你好 héllo 😀", count: 42n }
  const encoded = safeJson({ first: shared, second: shared })
  expect([...encoded].every((character) => character.charCodeAt(0) <= 0x7f)).toBe(true)
  expect(JSON.parse(encoded)).toEqual({
    first: { text: shared.text, count: "42" },
    second: { text: shared.text, count: "42" },
  })
})

test("neutral JSON output retains legacy cycle and serialization failure markers", () => {
  const circular: { self?: unknown } = {}
  circular.self = circular
  expect(safeJson(circular)).toBe('{"self":"[circular]"}')
  expect(safeJson(undefined)).toBe("null")
  expect(
    JSON.parse(
      safeJson({
        toJSON() {
          throw new Error("cannot serialize 你好")
        },
      }),
    ),
  ).toEqual({ unserializable: true, error: "cannot serialize 你好" })
})
