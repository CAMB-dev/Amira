import { expect, test } from "bun:test"
import { repairJsonObject } from "../src/json-repair.ts"
import { INVALID_ARGS_KEY, parseToolArgs } from "../src/tool-args.ts"

const repaired: [string, string, Record<string, unknown>][] = [
  ["trailing commas", '{"a": [1, 2,], "b": {"c": 1,},}', { a: [1, 2], b: { c: 1 } }],
  ["single quotes", "{'path': 'it\\'s \"here\"'}", { path: 'it\'s "here"' }],
  ["missing closing braces", '{"a": {"b": [1, 2', { a: { b: [1, 2] } }],
  ["unquoted keys", '{path: "a.txt", max_lines: 3, $x: true}', { path: "a.txt", max_lines: 3, $x: true }],
  ["a json code fence", '```json\n{"path": "a.txt"}\n```', { path: "a.txt" }],
  ["an unclosed code fence", '```\n{"path": "a.txt"}', { path: "a.txt" }],
  ["text around the object", 'Here you go: {"path": "a.txt"} hope that helps', { path: "a.txt" }],
  ["raw newlines and tabs in strings", '{"content": "line 1\nline\t2"}', { content: "line 1\nline\t2" }],
  ["python literals", "{'force': True, 'limit': None, 'ok': False}", { force: true, limit: null, ok: false }],
  ["escapes kept", '{"a": "x\\ny\\u0041",}', { a: "x\nyA" }],
  ["keys named like literals", "{true: 1, null: 2}", { true: 1, null: 2 }],
  ["a dangling comma at the end", '{"a": 1,', { a: 1 }],
]

for (const [name, raw, expected] of repaired) {
  test(`repairs ${name}`, () => {
    expect(parseToolArgs(raw)).toEqual(expected)
  })
}

const hopeless: [string, string][] = [
  ["a string cut off midway", '{"content": "half a fi'],
  ["a key without a value", '{"a": 1, "b":'],
  ["bare words that are not keys", "{path: some file}"],
  ["mismatched brackets", '{"a": [1, 2}'],
  ["no object at all", "just text"],
  ["an array", "[1, 2]"],
  ["NaN", '{"a": NaN}'],
]

for (const [name, raw] of hopeless) {
  test(`gives up on ${name}`, () => {
    expect(parseToolArgs(raw)).toEqual({ [INVALID_ARGS_KEY]: raw })
  })
}

test("valid JSON is parsed as is, and empty arguments are an empty object", () => {
  expect(parseToolArgs('{"a": "it\'s, }"}')).toEqual({ a: "it's, }" })
  expect(parseToolArgs("  ")).toEqual({})
})

test("arguments encoded twice are decoded", () => {
  expect(parseToolArgs(JSON.stringify(JSON.stringify({ path: "a" })))).toEqual({ path: "a" })
})

test("commas and brackets inside strings are left alone", () => {
  expect(repairJsonObject("{'a': 'x, }', b: '[,]',}")).toEqual({ a: "x, }", b: "[,]" })
})
