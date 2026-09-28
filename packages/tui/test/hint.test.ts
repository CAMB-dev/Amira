import { expect, test } from "bun:test"
import { fitHint } from "../src/hint.ts"

const items = [
  { text: "Enter steer", priority: 5 },
  { text: "Ctrl+Q queue", priority: 3 },
  { text: "Shift+Enter newline", priority: 1 },
  { text: "Esc interrupt", priority: 6 },
  { text: "Ctrl+C interrupt", priority: 2 },
]

test("a hint that fits is left whole", () => {
  expect(fitHint(items, 200)).toBe(
    "Enter steer · Ctrl+Q queue · Shift+Enter newline · Esc interrupt · Ctrl+C interrupt",
  )
})

test("narrower, whole items go, lowest priority first, never cut mid-word", () => {
  expect(fitHint(items, 80)).toBe("Enter steer · Ctrl+Q queue · Esc interrupt · Ctrl+C interrupt")
  expect(fitHint(items, 60)).toBe("Enter steer · Ctrl+Q queue · Esc interrupt")
  expect(fitHint(items, 40)).toBe("Enter steer · Esc interrupt")
  expect(fitHint(items, 20)).toBe("Esc interrupt")
})

test("only a lone item too wide is cut; empty and missing items are skipped", () => {
  expect(fitHint(items, 8)).toBe("Esc int…")
  expect(fitHint([false, undefined, { text: "", priority: 9 }, { text: "a", priority: 1 }], 10)).toBe("a")
})

test("of equal priority the later item goes first", () => {
  const same = [
    { text: "aaaa", priority: 1 },
    { text: "bbbb", priority: 1 },
  ]
  expect(fitHint(same, 6)).toBe("aaaa")
})
