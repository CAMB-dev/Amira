import { expect, test } from "bun:test"
import { Spinner } from "../src/components/spinner.ts"
import { Stack } from "../src/components/stack.ts"
import { Text } from "../src/components/text.ts"
import { bold, defaultTheme, red } from "../src/style.ts"
import { plain } from "./context.ts"

test("Text wraps, styles and takes no rows when empty", () => {
  const t = new Text()
  expect(t.render(10)).toEqual([])
  t.setText("hello world")
  t.append(" again")
  expect(t.render(11)).toEqual(["hello world", "again"])
  const styled = new Text("ab cd", red)
  expect(styled.render(2)).toEqual(["\x1b[31mab\x1b[0m", "\x1b[31mcd\x1b[39m"])
})

test("Spinner advances frames and truncates to the width", () => {
  const s = new Spinner({ label: "Thinking", frames: ["a", "b"] })
  expect(s.render(20, plain)).toEqual(["a Thinking"])
  s.tick()
  expect(s.render(5, plain)).toEqual(["b Thi"])
})

test("Spinner takes its theme from the render context", () => {
  const s = new Spinner({ label: "x", frames: ["a"] })
  expect(
    s.render(20, { theme: { ...defaultTheme, shimmer: bold, muted: red }, color: true, rows: 24 }),
  ).toEqual(["\x1b[1ma\x1b[22m \x1b[31mx\x1b[39m"])
})

test("Stack concatenates children in order and passes the context down", () => {
  const a = new Text("a")
  const b = new Text("b")
  const stack = new Stack([a])
  stack.add(b)
  stack.add(new Text("0"), 0)
  expect(stack.render(10, plain)).toEqual(["0", "a", "b"])
  stack.remove(a)
  stack.add(new Spinner({ frames: ["s"] }))
  expect(stack.render(10, plain)).toEqual(["0", "b", "s"])
})
