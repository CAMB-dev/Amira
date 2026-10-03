import { expect, test } from "bun:test"

test("the public math-source exports stay stable", async () => {
  expect(Object.keys(await import("@amira/tui-kit/math-source")).sort()).toEqual([
    "displayMathEnd",
    "displayMathSource",
    "displayMathStart",
    "inlineMathAt",
    "mathCodeLine",
    "mathSources",
  ])
})
