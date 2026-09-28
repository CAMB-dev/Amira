import { expect, test } from "bun:test"
import { key, textKey } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { Dialog, type DialogAnswer } from "../src/dialog.ts"

function select(options: string[]) {
  const answers: DialogAnswer[] = []
  const dialog = new Dialog({ kind: "select", requestId: "r1", title: "Model", options }, (a) =>
    answers.push(a),
  )
  const type = (text: string) => {
    for (const ch of text) dialog.handleInput(textKey(ch))
  }
  return { dialog, answers, type }
}

test("a digit chooses an option of a short list", () => {
  const { dialog, answers, type } = select(["red", "green", "blue"])
  expect(dialog.render(40, plain)).toContain("  green 2")
  type("2")
  expect(answers).toEqual(["green"])
})

test("in a long list digits filter, so ids with digits can be found", () => {
  const models = Array.from({ length: 12 }, (_, i) => `openai/gpt-${i}`).concat("openai/gpt-4o")
  const { dialog, answers, type } = select(models)
  expect(dialog.render(60, plain).some((l) => / 1$/.test(l))).toBe(false)
  type("4o")
  expect(answers).toEqual([])
  expect(dialog.render(60, plain)).toContain("› openai/gpt-4o")
  dialog.handleInput(key("enter"))
  expect(answers).toEqual(["openai/gpt-4o"])
})
