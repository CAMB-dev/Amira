import { expect, test } from "bun:test"

test("the public console-code-page exports stay stable", async () => {
  expect(Object.keys(await import("@amira/tui-kit/console-code-page")).sort()).toEqual([
    "consoleCodePage",
    "createConsoleCodePage",
  ])
})

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
