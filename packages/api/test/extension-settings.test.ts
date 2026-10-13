import { expect, test } from "bun:test"
import {
  type ExtensionSettingsField,
  extensionSettingsDefaults,
  validateExtensionSetting,
} from "../src/index.ts"

const number: ExtensionSettingsField = {
  key: "size",
  type: "number",
  label: "Size",
  default: 0.3,
  min: 0.1,
  max: 1.1,
  step: 0.2,
}
const text: ExtensionSettingsField = {
  key: "name",
  type: "text",
  label: "Name",
  default: "abc",
  pattern: "[a-z]+",
  maxLength: 4,
}
const choice: ExtensionSettingsField = {
  key: "mode",
  type: "choice",
  label: "Mode",
  default: "plain",
  options: ["plain", { value: "bold", label: "Bold" }],
}
const toggle: ExtensionSettingsField = { key: "enabled", type: "toggle", label: "Enabled", default: true }
const colour: ExtensionSettingsField = { key: "ink", type: "colour", label: "Ink", default: "#AABBCC" }

test("declared defaults are immutable and contain only declared keys", () => {
  const defaults = extensionSettingsDefaults([number, text, choice, toggle, colour])
  expect(defaults).toEqual({ size: 0.3, name: "abc", mode: "plain", enabled: true, ink: "#AABBCC" })
  expect(Object.isFrozen(defaults)).toBe(true)
})

test.each([0.1, 0.3, 0.5, 1.1])("numeric steps handle floating point: %s", (value) => {
  expect(validateExtensionSetting(number, value)).toBeUndefined()
})

test.each([undefined, "0.3", NaN, Infinity, -Infinity, 0, 1.3, 0.2])("invalid number: %s", (value) => {
  expect(validateExtensionSetting(number, value)).toBeString()
})

test("number step is relative to min or zero, with bounds independently enforced", () => {
  expect(validateExtensionSetting({ ...number, min: undefined, step: 0.2 }, 0.4)).toBeUndefined()
  expect(validateExtensionSetting({ ...number, step: undefined }, 0.4)).toBeUndefined()
  expect(validateExtensionSetting({ ...number, step: undefined }, 2)).toContain("at most")
})

test("text validation matches the whole value and enforces its length", () => {
  expect(validateExtensionSetting(text, "abcd")).toBeUndefined()
  expect(validateExtensionSetting(text, "abcde")).toContain("at most")
  expect(validateExtensionSetting(text, "123")).toContain("pattern")
  expect(validateExtensionSetting(text, "abc\n")).toContain("pattern")
  expect(validateExtensionSetting(text, 123)).toContain("string")
  expect(validateExtensionSetting({ ...text, pattern: undefined }, "")).toBeUndefined()
})

test("text maxLength counts Unicode code points without splitting emoji", () => {
  const field: ExtensionSettingsField = {
    key: "name",
    type: "text",
    label: "Name",
    default: "abc",
    maxLength: 4,
  }
  expect(validateExtensionSetting(field, "abc🚀")).toBeUndefined()
  expect(validateExtensionSetting(field, "abcd🚀")).toContain("at most")
  expect(validateExtensionSetting({ ...field, maxLength: 1 }, "🚀")).toBeUndefined()
  expect(validateExtensionSetting({ ...field, maxLength: 1 }, "e\u0301")).toContain("at most")
})

test.each(["abc\ud83d", "\ude80", "\ud83dabc", "\ude80\ud83d"])(
  "text validation rejects unpaired surrogates: %j",
  (value) => {
    expect(
      validateExtensionSetting({ key: "name", type: "text", label: "Name", default: "" }, value),
    ).toContain("Unicode")
  },
)

test("choices accept values rather than labels, and toggles require booleans", () => {
  expect(validateExtensionSetting(choice, "plain")).toBeUndefined()
  expect(validateExtensionSetting(choice, "bold")).toBeUndefined()
  expect(validateExtensionSetting(choice, "Bold")).toBeString()
  expect(validateExtensionSetting(choice, 0)).toBeString()
  expect(validateExtensionSetting(toggle, false)).toBeUndefined()
  expect(validateExtensionSetting(toggle, "false")).toBeString()
})

test.each(["#abcdef", "#AABBCC", "#aBcDeF", "#000000"])("valid colour: %s", (value) => {
  expect(validateExtensionSetting(colour, value)).toBeUndefined()
})

test.each([
  "red",
  "rgb(1,2,3)",
  "#ab",
  "#abc",
  "#ABC",
  "#abcd",
  "#abcdef00",
  "#ggg",
  "#fff\n",
  "#ffffff\n",
  123,
])("invalid colour: %s", (value) => {
  expect(validateExtensionSetting(colour, value)).toBeString()
})
