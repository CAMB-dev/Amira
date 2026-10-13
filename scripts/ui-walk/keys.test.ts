import { expect, test } from "bun:test"
import { encodeKey, encodeKeys } from "./keys.ts"

test("encodes literal UTF-8 text and bracketed paste without interpreting keys", () => {
  expect(encodeKeys(["text:/model", "enter"])).toBe("/model\r")
  expect(encodeKey('text:"你好\\nworld"')).toBe("你好\nworld")
  expect(encodeKey("paste:a\nb")).toBe("\x1b[200~a\nb\x1b[201~")
  expect(encodeKey("text:ctrl+o")).toBe("ctrl+o")
})

test("encodes named keys, chords, application cursor mode and function keys", () => {
  expect(encodeKeys(["enter", "esc", "ctrl+o", "alt+v", "tab", "backspace"])).toBe("\r\x1b\x0f\x1bv\t\x7f")
  expect(encodeKey("up")).toBe("\x1b[A")
  expect(encodeKey("up", true)).toBe("\x1bOA")
  expect(encodeKey("ctrl+shift+left")).toBe("\x1b[1;6D")
  expect(encodeKey("shift+tab")).toBe("\x1b[Z")
  expect(encodeKey("alt+delete")).toBe("\x1b[3;3~")
  expect(encodeKey("f1")).toBe("\x1bOP")
  expect(encodeKey("f12")).toBe("\x1b[24~")
  expect(encodeKey("ctrl+space")).toBe("\x00")
})

test("rejects misspelled keys and unsupported modifiers", () => {
  for (const key of ["enterr", "meta+v", "ctrl+ctrl+o", "shift+enter", "ctrl+7"]) {
    expect(() => encodeKey(key)).toThrow()
  }
})
