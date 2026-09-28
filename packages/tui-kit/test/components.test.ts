import { beforeAll, expect, test } from "bun:test"
import { Spinner } from "../src/components/spinner.ts"
import { Stack } from "../src/components/stack.ts"
import { Text } from "../src/components/text.ts"
import { red, setColorEnabled } from "../src/style.ts"

beforeAll(() => setColorEnabled(true))

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
  setColorEnabled(false)
  const s = new Spinner({ label: "Thinking", frames: ["a", "b"] })
  expect(s.render(20)).toEqual(["a Thinking"])
  s.tick()
  expect(s.render(5)).toEqual(["b Thi"])
  setColorEnabled(true)
})

test("Stack concatenates children in order", () => {
  const a = new Text("a")
  const b = new Text("b")
  const stack = new Stack([a])
  stack.add(b)
  stack.add(new Text("0"), 0)
  expect(stack.render(10)).toEqual(["0", "a", "b"])
  stack.remove(a)
  expect(stack.render(10)).toEqual(["0", "b"])
})
