import { expect, test } from "bun:test"
import { key, textKey } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { Dialog, type DialogAnswer, type DialogRequest } from "../src/dialog.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"

function open(request: DialogRequest, keys?: Keybindings) {
  const answers: DialogAnswer[] = []
  const dialog = new Dialog(request, (a) => answers.push(a), keys)
  const type = (text: string) => {
    for (const ch of text) dialog.handleInput(textKey(ch))
  }
  return { dialog, answers, type }
}

const select = (options: string[]) => open({ kind: "select", requestId: "r1", title: "Model", options })

function review(lines: number, options = ["merge", "keep worktree", "discard"]) {
  const diff = Array.from({ length: lines }, (_, i) => `+line ${i + 1}`).join("\n")
  return open({ kind: "diff-review", requestId: "r2", title: "Merge the worktree?", diff, options })
}

test("a digit chooses an option of a short list; it shows before the option", () => {
  const { dialog, answers, type } = select(["red", "green", "blue"])
  const lines = dialog.render(40, plain)
  expect(lines).toContain("› 1 red")
  expect(lines).toContain("  2 green")
  type("2")
  expect(answers).toEqual(["green"])
})

test("in a long list digits filter, so ids with digits can be found", () => {
  const models = Array.from({ length: 12 }, (_, i) => `openai/gpt-${i}`).concat("openai/gpt-4o")
  const { dialog, answers, type } = select(models)
  expect(dialog.render(60, plain).some((l) => /^. \d /.test(l))).toBe(false)
  type("4o")
  expect(answers).toEqual([])
  expect(dialog.render(60, plain)).toContain("› openai/gpt-4o")
  dialog.handleInput(key("enter"))
  expect(answers).toEqual(["openai/gpt-4o"])
})

test("only a select says it filters", () => {
  expect(select(["a", "b"]).dialog.render(80, plain).at(-1)).toBe(
    "↑↓ move · type to filter · Enter choose · Esc cancel",
  )
  const { dialog, answers, type } = review(3)
  expect(dialog.render(80, plain).at(-1)).toBe("↑↓ move · Enter choose · Esc cancel")
  // Letters do nothing in a review.
  type("m")
  expect(answers).toEqual([])
})

test("a diff review fits the rows it has: title, options and keys stay, the diff is cut in the middle", () => {
  const { dialog } = review(54)
  dialog.maxRows = 12
  const lines = dialog.render(60, plain)
  expect(lines.length).toBe(12)
  expect(lines[0]).toBe("? Merge the worktree?")
  expect(lines.slice(-4)).toEqual([
    "› 1 merge",
    "  2 keep worktree",
    "  3 discard",
    "↑↓ move · Enter choose · Esc cancel",
  ])
  // 7 rows for the diff: 3 from the start, a marker, 3 from the end.
  expect(lines.slice(1, 8)).toEqual([
    "+ line 1",
    "+ line 2",
    "+ line 3",
    "… 48 more lines …",
    "+ line 52",
    "+ line 53",
    "+ line 54",
  ])
})

test("a short diff is shown whole, and a tall terminal shows more of a long one", () => {
  const short = review(5).dialog
  short.maxRows = 24
  expect(short.render(60, plain)).toContain("+ line 5")
  expect(short.render(60, plain).some((l) => l.includes("more lines"))).toBe(false)
  const long = review(54).dialog
  long.maxRows = 40
  expect(long.render(60, plain).length).toBe(40)
})

test("with barely any room the options scroll and the title still shows", () => {
  const { dialog } = review(20, ["a", "b", "c", "d", "e"])
  dialog.maxRows = 5
  const lines = dialog.render(60, plain)
  expect(lines[0]).toBe("? Merge the worktree?")
  expect(lines.at(-1)).toBe("↑↓ move · Enter choose · Esc cancel")
  expect(lines.length).toBeLessThanOrEqual(5)
  expect(lines).toContain("› 1 a")
})

test("a long select is cut to the rows it has", () => {
  const { dialog } = select(Array.from({ length: 30 }, (_, i) => `option ${i}`))
  dialog.maxRows = 6
  const lines = dialog.render(60, plain)
  expect(lines[0]).toBe("? Model")
  expect(lines.length).toBe(6)
  expect(lines.at(-2)).toBe("  1/30")
})

test("dialog keys come from the keybindings", () => {
  const keys = new Keybindings({ ...defaultKeys({ vscode: false }), "dialog.yes": ["j"], "dialog.no": ["x"] })
  const { dialog, answers } = open({ kind: "confirm", requestId: "r3", title: "Go?" }, keys)
  expect(dialog.render(40, plain).at(-1)).toBe("j yes · x no · Esc cancel")
  dialog.handleInput(textKey("y"))
  expect(answers).toEqual([])
  dialog.handleInput(textKey("j"))
  expect(answers).toEqual([true])
  // Ctrl+C cancels too.
  const other = open({ kind: "confirm", requestId: "r4", title: "Go?" })
  other.dialog.handleInput(key("c", { ctrl: true }))
  expect(other.answers).toEqual([undefined])
})

test("an unbound action has no footer item", () => {
  const keys = new Keybindings({
    ...defaultKeys({ vscode: false }),
    "dialog.yes": [],
    "dialog.no": [],
    "dialog.cancel": [],
    "dialog.up": [],
  })
  const confirm = open({ kind: "confirm", requestId: "r5", title: "Go?" }, keys)
  expect(confirm.dialog.render(40, plain).at(-1)).toBe("Enter yes")
  const list = open({ kind: "select", requestId: "r6", title: "Pick", options: ["a"] }, keys)
  expect(list.dialog.render(60, plain).at(-1)).toBe("↓ move · type to filter · Enter choose")
  const input = open({ kind: "input", requestId: "r7", title: "Name" }, keys)
  expect(input.dialog.render(40, plain).at(-1)).toBe("Enter submit")
})
