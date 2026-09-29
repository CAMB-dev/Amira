import { expect, test } from "bun:test"
import type { AskQuestion } from "@amira/api"
import { CURSOR_MARKER, defaultTheme, key, stripAnsi, textKey } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { Dialog, type DialogAnswer, type DialogRequest, dialogEchoLines } from "../src/dialog.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"

function open(request: DialogRequest, keys?: Keybindings) {
  const answers: DialogAnswer[] = []
  const dialog = new Dialog(request, (a) => answers.push(a), keys)
  const type = (text: string) => {
    for (const ch of text) dialog.handleInput(textKey(ch))
  }
  const press = (...names: string[]) => {
    for (const n of names) dialog.handleInput(key(n as never))
  }
  /** The rows without the bar, as they read. */
  const rows = (width = 60) =>
    dialog.render(width, plain).map((l) => l.replace(/^┃ ?/, "").replace(CURSOR_MARKER, ""))
  return { dialog, answers, type, press, rows }
}

const select = (options: string[]) => open({ kind: "select", requestId: "r1", title: "Model", options })

function review(lines: number, options = ["merge", "keep worktree", "discard"]) {
  const diff = Array.from({ length: lines }, (_, i) => `+line ${i + 1}`).join("\n")
  return open({ kind: "diff-review", requestId: "r2", title: "Merge the worktree?", diff, options })
}

const approval = () =>
  open({
    kind: "confirm",
    requestId: "a1",
    title: "Allow bash?",
    message: 'policy\n{"command":"rm -rf build/ && bun run build"}',
    always: true,
    other: true,
    source: "approval",
  })

const QUESTIONS: AskQuestion[] = [
  {
    question: "Which approach do you prefer?",
    header: "Approach",
    options: [
      { label: "Rewrite (Recommended)", description: "Start over" },
      { label: "Patch", description: "Fix it in place" },
    ],
  },
  {
    question: "What else should I do?",
    header: "Extras",
    options: [{ label: "Tests" }, { label: "Docs" }, { label: "Changelog" }],
    multiSelect: true,
  },
]

const ask = (questions = QUESTIONS) =>
  open({ kind: "ask", requestId: "q1", title: `${questions.length} questions`, questions })

test("every dialog is a block with a bar down its left, the question, the options and the keys", () => {
  expect(approval().dialog.render(60, plain)).toEqual([
    "┃ ? Allow bash? (approval)",
    "┃   policy",
    '┃   {"command":"rm -rf build/ && bun run build"}',
    "┃",
    "┃ ❯ Yes",
    "┃   Yes, and don't ask again this session",
    "┃   No",
    "┃   Other…",
    "┃",
    "┃ ↑↓ move · y/n · Enter choose · Esc cancel",
  ])
  expect(ask().dialog.render(60, plain)).toEqual([
    "┃ 1/2 · Approach",
    "┃ ? Which approach do you prefer?",
    "┃",
    "┃ ❯ 1 Rewrite (Recommended)  Start over",
    "┃   2 Patch                  Fix it in place",
    "┃   3 Other…",
    "┃",
    "┃ ←→ question · ↑↓ move · Enter choose · Esc cancel",
  ])
  expect(open({ kind: "input", requestId: "i", title: "Name", placeholder: "your name" }).rows()).toEqual([
    "? Name",
    "❯ your name",
    "",
    "Enter submit · Esc cancel",
  ])
})

test("a confirm is a list: Enter chooses, y and n answer at once, digits do nothing", () => {
  const yes = approval()
  yes.type("1")
  expect(yes.answers).toEqual([])
  yes.type("y")
  expect(yes.answers).toEqual([true])
  const no = approval()
  no.type("n")
  expect(no.answers).toEqual([false])
  const always = approval()
  always.press("down", "enter")
  expect(always.answers).toEqual(["always"])
  // A confirm without the extras offers yes and no only.
  const plainConfirm = open({ kind: "confirm", requestId: "c", title: "Go?" })
  expect(plainConfirm.rows()).toEqual([
    "? Go?",
    "",
    "❯ Yes",
    "  No",
    "",
    "↑↓ move · y/n · Enter choose · Esc cancel",
  ])
  plainConfirm.press("up", "enter")
  expect(plainConfirm.answers).toEqual([false])
})

test("Other opens a text field in its row; Esc closes the field, then cancels the dialog", () => {
  const d = approval()
  d.press("up", "enter")
  expect(d.rows().slice(5, 9)).toEqual([
    "  Yes, and don't ask again this session",
    "  No",
    "❯ Type your answer",
    "",
  ])
  expect(d.rows().at(-1)).toBe("Enter submit · Esc back")
  // y, n and digits are text in the field, and Enter on nothing typed does nothing.
  d.press("enter")
  d.type("no, use trash")
  expect(d.answers).toEqual([])
  expect(d.rows()[7]).toBe("❯ no, use trash")
  d.press("escape")
  expect(d.answers).toEqual([])
  // Closed, the text stays with the choice, and choosing it again edits it.
  expect(d.rows()[7]).toBe('❯ Other… "no, use trash"')
  d.press("enter")
  d.type("!")
  d.press("enter")
  expect(d.answers).toEqual([{ other: "no, use trash!" }])
  const cancel = approval()
  cancel.press("up", "enter", "escape", "escape")
  expect(cancel.answers).toEqual([undefined])
  // Ctrl+C in the field bails out of the whole dialog at once.
  const bail = approval()
  bail.press("up", "enter")
  bail.dialog.handleInput(key("c", { ctrl: true }))
  expect(bail.answers).toEqual([undefined])
})

test("a confirm's always choice says how far it reaches when the asker says so", () => {
  const r: DialogRequest = {
    kind: "confirm",
    requestId: "c",
    title: "Allow bash?",
    always: "for bash (policy)",
  }
  const { rows, press, answers } = open(r)
  expect(rows()[3]).toBe("  Yes, and don't ask again for bash (policy)")
  press("down", "enter")
  expect(answers).toEqual(["always"])
  expect(dialogEchoLines(r, "always", plain.theme)).toEqual([
    "┃ ? Allow bash? ❯ Yes, and don't ask again for bash (policy)",
  ])
})

test("a digit chooses an option of a short list; it shows before the option", () => {
  const { answers, type, rows } = select(["red", "green", "blue"])
  expect(rows(40)).toContain("❯ 1 red")
  expect(rows(40)).toContain("  2 green")
  type("2")
  expect(answers).toEqual(["green"])
})

test("in a long list digits filter, so ids with digits can be found", () => {
  const models = Array.from({ length: 12 }, (_, i) => `openai/gpt-${i}`).concat("openai/gpt-4o")
  const { dialog, answers, type, rows } = select(models)
  expect(rows().some((l) => /^. \d /.test(l))).toBe(false)
  type("4o")
  expect(answers).toEqual([])
  expect(rows()).toContain("❯ openai/gpt-4o")
  dialog.handleInput(key("enter"))
  expect(answers).toEqual(["openai/gpt-4o"])
})

test("only a select says it filters", () => {
  expect(select(["a", "b"]).rows(80).at(-1)).toBe("↑↓ move · type to filter · Enter choose · Esc cancel")
  const { answers, type, rows } = review(3)
  expect(rows(80).at(-1)).toBe("↑↓ move · Enter choose · Esc cancel")
  // Letters do nothing in a review.
  type("m")
  expect(answers).toEqual([])
})

test("a diff review fits the rows it has: title, options and keys stay, the diff is cut in the middle", () => {
  const { dialog, rows } = review(54)
  dialog.maxRows = 12
  const lines = rows()
  expect(lines.length).toBe(12)
  expect(lines[0]).toBe("? Merge the worktree?")
  expect(lines.slice(-4)).toEqual([
    "❯ 1 merge",
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
  // Every row still has the bar.
  expect(dialog.render(60, plain).every((l) => l.startsWith("┃"))).toBe(true)
})

test("a short diff is shown whole with room to breathe, and a tall terminal shows more of a long one", () => {
  const short = review(5)
  short.dialog.maxRows = 24
  const rows = short.rows()
  expect(rows[0]).toBe("? Merge the worktree?")
  expect(rows.some((l) => l.includes("+ line 5"))).toBe(true)
  expect(rows.some((l) => l.includes("more lines"))).toBe(false)
  expect(rows.slice(-6)).toEqual([
    "",
    "❯ 1 merge",
    "  2 keep worktree",
    "  3 discard",
    "",
    "↑↓ move · Enter choose · Esc cancel",
  ])
  const long = review(54).dialog
  long.maxRows = 40
  expect(long.render(60, plain).length).toBe(40)
})

test("with barely any room the options scroll and the title still shows", () => {
  const { dialog, rows } = review(20, ["a", "b", "c", "d", "e"])
  dialog.maxRows = 5
  const lines = rows()
  expect(lines[0]).toBe("? Merge the worktree?")
  expect(lines.at(-1)).toBe("↑↓ move · Enter choose · Esc cancel")
  expect(lines.length).toBeLessThanOrEqual(5)
  expect(lines).toContain("❯ 1 a")
})

test("a long select is cut to the rows it has", () => {
  const { dialog, rows } = select(Array.from({ length: 30 }, (_, i) => `option ${i}`))
  dialog.maxRows = 6
  const lines = rows()
  expect(lines[0]).toBe("? Model")
  expect(lines.length).toBe(6)
  expect(lines.at(-2)).toBe("  1/30")
})

test("a tight approval gives up its blank rows and message before its options", () => {
  const { dialog, rows } = approval()
  dialog.maxRows = 7
  expect(rows()).toEqual([
    "? Allow bash? (approval)",
    "  policy …",
    "❯ Yes",
    "  Yes, and don't ask again this session",
    "  No",
    "  Other…",
    "↑↓ move · y/n · Enter choose · Esc cancel",
  ])
})

test("narrow, descriptions go under their labels; CJK text wraps by its width", () => {
  expect(ask().rows(30)).toEqual([
    "1/2 · Approach",
    "? Which approach do you",
    "  prefer?",
    "",
    "❯ 1 Rewrite (Recommended)",
    "    Start over",
    "  2 Patch",
    "    Fix it in place",
    "  3 Other…",
    "",
    "Enter choose · Esc cancel",
  ])
  const cjk = ask([
    {
      question: "你想用哪种方法来实现这个功能？",
      options: [
        { label: "重写（推荐）", description: "从头开始写这个模块" },
        { label: "修补", description: "就地修复" },
      ],
    },
  ])
  const lines = cjk.dialog.render(30, plain)
  expect(lines.map((l) => l.replace(/^┃ ?/, ""))).toEqual([
    "? 你想用哪种方法来实现这个功",
    "  能？",
    "",
    "❯ 1 重写（推荐）",
    "    从头开始写这个模块",
    "  2 修补",
    "    就地修复",
    "  3 Other…",
    "",
    "Enter choose · Esc cancel",
  ])
  for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(30)
})

test("several questions are asked one after another and answered together", () => {
  const { answers, type, press, rows } = ask()
  type("2")
  expect(answers).toEqual([])
  expect(rows()[0]).toBe("2/2 · Extras")
  expect(rows()).toContain("❯ 1 [ ] Tests")
  // ← goes back to the answered question, with the cursor on its answer; → no further than
  // the first question not answered.
  press("left")
  expect(rows()[0]).toBe("1/2 · Approach")
  expect(rows()).toContain("❯ 2 Patch                  Fix it in place")
  press("right", "right")
  expect(rows()[0]).toBe("2/2 · Extras")
  // Space and digits check; Enter submits.
  press("space")
  type("3")
  expect(rows()).toContain("  1 [x] Tests")
  expect(rows()).toContain("❯ 3 [x] Changelog")
  expect(rows(80).at(-1)).toBe("←→ question · ↑↓ move · Space toggle · Enter submit · Esc cancel")
  press("enter")
  expect(answers).toEqual([[{ selected: ["Patch"] }, { selected: ["Tests", "Changelog"] }]])
})

test("in a multi-select, Other takes text next to the options checked", () => {
  const { answers, type, press, rows } = ask([QUESTIONS[1]!])
  type("1")
  press("up")
  expect(rows()).toContain("❯ 4 [ ] Other…")
  // Enter on an empty Other opens it rather than submitting.
  press("enter")
  type("release notes")
  press("enter")
  expect(rows()).toContain('❯ 4 [x] Other… "release notes"')
  expect(answers).toEqual([])
  press("enter")
  expect(answers).toEqual([[{ selected: ["Tests"], other: "release notes" }]])
})

test("the answer stays in the transcript as one line per question under the bar", () => {
  const theme = plain.theme
  const r: DialogRequest = { kind: "ask", requestId: "q", title: "2 questions", questions: QUESTIONS }
  expect(dialogEchoLines(r, [{ selected: ["Patch"] }, { selected: [], other: "none" }], theme)).toEqual([
    "┃ ? Which approach do you prefer? ❯ Patch",
    '┃ ? What else should I do? ❯ "none"',
  ])
  expect(dialogEchoLines(r, undefined, theme)).toEqual(["┃ ? 2 questions ❯ cancelled"])
  const confirm: DialogRequest = { kind: "confirm", requestId: "c", title: "Allow bash?", always: true }
  expect(dialogEchoLines(confirm, "always", theme)).toEqual([
    "┃ ? Allow bash? ❯ Yes, and don't ask again this session",
  ])
  const secret: DialogRequest = { kind: "input", requestId: "s", title: "Key", secret: true }
  expect(dialogEchoLines(secret, "sk-1", theme)).toEqual(["┃ ? Key ❯ (hidden)"])
})

test("colors: the bar and ❯ in the accent, an approval's bar in the warning color; without color the glyphs still tell", () => {
  const ctx = { ...plain, theme: defaultTheme, color: true }
  const accentBar = `\x1b[36m┃\x1b[39m`
  const lines = ask().dialog.render(60, ctx)
  expect(lines.every((l) => l.startsWith(accentBar))).toBe(true)
  expect(lines.some((l) => l.includes(`\x1b[36m❯\x1b[39m`))).toBe(true)
  const warn = approval().dialog.render(60, ctx)
  expect(warn.every((l) => l.startsWith(`\x1b[33m┃\x1b[39m`))).toBe(true)
  // Stripped of color, the selected row is the one with ❯.
  expect(lines.map(stripAnsi).filter((l) => l.includes("❯"))).toEqual([
    "┃ ❯ 1 Rewrite (Recommended)  Start over",
  ])
})

test("dialog keys come from the keybindings", () => {
  const keys = new Keybindings({ ...defaultKeys({ vscode: false }), "dialog.yes": ["j"], "dialog.no": ["x"] })
  const { dialog, answers, rows } = open({ kind: "confirm", requestId: "r3", title: "Go?" }, keys)
  expect(rows(60).at(-1)).toBe("↑↓ move · j/x · Enter choose · Esc cancel")
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
    "dialog.toggle": [],
  })
  const confirm = open({ kind: "confirm", requestId: "r5", title: "Go?" }, keys)
  expect(confirm.rows(40).at(-1)).toBe("↓ move · Enter choose")
  const list = open({ kind: "select", requestId: "r6", title: "Pick", options: ["a"] }, keys)
  expect(list.rows(60).at(-1)).toBe("↓ move · type to filter · Enter choose")
  const input = open({ kind: "input", requestId: "r7", title: "Name" }, keys)
  expect(input.rows(40).at(-1)).toBe("Enter submit")
  const multi = ask([QUESTIONS[1]!])
  expect(multi.rows(80).at(-1)).toBe("↑↓ move · Space toggle · Enter submit · Esc cancel")
  const unbound = open({ kind: "ask", requestId: "q", title: "q", questions: [QUESTIONS[1]!] }, keys)
  expect(unbound.rows(80).at(-1)).toBe("↓ move · Enter submit")
})
