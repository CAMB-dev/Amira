import { expect, test } from "bun:test"
import { extensionStatusMetadata, parseExtensionStatus } from "@amira/api/internal/extension-status"
import { extensionStatusBadge, extensionStatusNotice } from "../src/index.ts"

test("shared lifecycle copy handles optional explanations and replacements", () => {
  expect(extensionStatusNotice("foo", {})).toBeUndefined()
  expect(extensionStatusNotice("foo", { status: "experimental" })).toEqual({
    level: "note",
    message: "note: foo is experimental",
  })
  expect(extensionStatusNotice("foo", { status: "wip" })).toEqual({
    level: "warning",
    message: "warning: foo is work in progress",
  })
  expect(extensionStatusNotice("foo", { status: "deprecated" })).toEqual({
    level: "warning",
    message: "warning: foo is deprecated",
  })
  expect(
    extensionStatusNotice("foo", {
      status: "deprecated",
      replacedBy: "bar",
      statusMessage: "Use the maintained package",
    }),
  ).toEqual({
    level: "warning",
    message: "warning: foo is deprecated; use bar instead: Use the maintained package",
  })
  expect(extensionStatusNotice("foo", { status: "wip", replacedBy: "bar" })?.message).not.toContain("bar")
})

test("badges are ASCII in every terminal mode and absent without a status", () => {
  expect(extensionStatusBadge({})).toBe("")
  for (const status of ["experimental", "wip", "deprecated"] as const) {
    const badge = extensionStatusBadge({ status })
    expect(badge).toBe(`[${status}]`)
    expect(badge).toMatch(/^[\x20-\x7e]+$/)
  }
})

test("status notices stay on one line even with untrusted manifest text", () => {
  const notice = extensionStatusNotice("foo\nbar", {
    status: "deprecated",
    replacedBy: "bar\r\nbaz",
    statusMessage: "line one\nline two",
  })
  expect(notice?.message).toBe("warning: foo bar is deprecated; use bar baz instead: line one line two")
})

test("unknown status and non-string optional values do not fail parsing", () => {
  const warnings: string[] = []
  expect(parseExtensionStatus({ status: "future" }, (warning) => warnings.push(warning), "foo")).toEqual({})
  expect(warnings).toEqual(['foo: unknown extension status "future"; ignored'])
  expect(
    parseExtensionStatus({ status: "wip", statusMessage: 42, replacedBy: false }, () => {}, "foo"),
  ).toEqual({ status: "wip" })
  expect(extensionStatusMetadata({ replacedBy: "bar", statusMessage: "ignored" })).toEqual({})
})
