import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { updateSettingsFile, validateSettings } from "../src/config/index.ts"
import * as jsonEdit from "../src/config/json-edit.ts"

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-choice-write-"))
  file = path.join(dir, "settings.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const save = (model = "mock/second", thinking = "high") =>
  updateSettingsFile(file, (current) => ({ ...current, model, thinking }), { preserveFormatting: true })

test.each([
  "{}",
  "{\n}\n",
  '{ "shell" : "auto" }',
  '{\r\n\t"shell": "auto"\r\n}\r\n',
  '{"custom":{"model":"inner","array":[1,{"thinking":"inner"}]},"shell":"auto"}',
  '{"custom\\"key" : "a\\"b", "model":"mock/first"}',
])("adds choices to valid JSON without losing existing text: %s", (original) => {
  writeFileSync(file, original)
  expect(save()).toBe(true)
  const next = readFileSync(file, "utf8")
  expect(JSON.parse(next)).toEqual({ ...JSON.parse(original), model: "mock/second", thinking: "high" })
  const existing = original.match(/"shell"\s*:\s*"auto"/)?.[0]
  if (existing && original.trim().includes("\n")) expect(next).toContain(existing)
  expect(save()).toBe(false)
  expect(readFileSync(file, "utf8")).toBe(next)
  expect(readdirSync(dir)).toEqual(["settings.json"])
})

test.each(["{}", "{\n}\n", "\uFEFF{\r\n}\r\n", '{ "shell" : "auto" }\r\n'])(
  "inserting into empty or single-line objects uses normal multiline JSON: %s",
  (original) => {
    writeFileSync(file, original)
    save()
    const newline = original.includes("\r\n") ? "\r\n" : "\n"
    const expected = {
      ...JSON.parse(original.replace(/^\uFEFF/, "")),
      model: "mock/second",
      thinking: "high",
    }
    expect(readFileSync(file, "utf8")).toBe(
      `${original.startsWith("\uFEFF") ? "\uFEFF" : ""}${JSON.stringify(expected, null, 2).replaceAll("\n", newline)}${newline}`,
    )
  },
)

test.each(["{invalid", '{"model":"wrong"}', '\uFEFF{"model":"wrong"}'])(
  "a faulty editor cannot write invalid or incorrect settings: %s",
  (edited) => {
    const editor = spyOn(jsonEdit, "editJsonValues").mockReturnValue(edited)
    try {
      for (const remove of [false, true]) {
        writeFileSync(file, '{ "shell": "auto" }')
        const expected = { ...(remove ? {} : { shell: "auto" }), model: "mock/second", thinking: "high" }
        updateSettingsFile(file, () => expected, { preserveFormatting: true })
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(expected)
        expect(readdirSync(dir)).toEqual(["settings.json"])
      }
      expect(editor).toHaveBeenCalledTimes(2)
    } finally {
      editor.mockRestore()
    }
  },
)

test("structural validation accepts reordered keys and strips a BOM for parsing", () => {
  const edited = '\uFEFF{ "thinking": "high", "model": "mock/second", "shell": "auto" }'
  const editor = spyOn(jsonEdit, "editJsonValues").mockReturnValue(edited)
  try {
    writeFileSync(file, '{"shell":"auto"}')
    save()
    expect(readFileSync(file, "utf8")).toBe(edited)
  } finally {
    editor.mockRestore()
  }
})

test("replacements keep unrelated values and layout byte-for-byte", () => {
  const original =
    '{\n    "model"  : "mock/first",\n    "custom": [ { "thinking": "low" } ],\n    "thinking" : "low"\n}\n'
  writeFileSync(file, original)
  save()
  expect(readFileSync(file, "utf8")).toBe(
    original.replace('"mock/first"', '"mock/second"').replace('"thinking" : "low"', '"thinking" : "high"'),
  )
})

test("creates a missing settings directory atomically", () => {
  file = path.join(dir, "nested", "settings.json")
  save()
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ model: "mock/second", thinking: "high" })
  expect(existsSync(`${file}.lock`)).toBe(false)
  expect(readdirSync(path.dirname(file))).toEqual(["settings.json"])
})

test.each(['{"shell":', "/* comment */ {}", "null", "[]"])(
  "never overwrites invalid object %s",
  (invalid) => {
    writeFileSync(file, invalid)
    expect(() => save()).toThrow()
    expect(readFileSync(file, "utf8")).toBe(invalid)
    expect(readdirSync(dir)).toEqual(["settings.json"])
  },
)

test("default is accepted only for top-level thinking, not a provider model effort", () => {
  expect(validateSettings({ thinking: "default" }, file).settings.thinking).toBe("default")
  expect(() =>
    validateSettings({ providers: { mock: { models: [{ id: "m", thinking: "default" }] } } }, file),
  ).toThrow()
})
