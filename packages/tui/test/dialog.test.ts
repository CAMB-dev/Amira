import { expect, test } from "bun:test"
import type { AskQuestion } from "@amira/api"
import { CURSOR_MARKER, defaultTheme, key, stripAnsi, textKey, visibleWidth } from "@amira/tui-kit"
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

test("local select header handles appearance keys without selecting or filtering", () => {
  const answers: DialogAnswer[] = []
  const previews: string[] = []
  let appearance = "auto"
  const dialog = new Dialog(
    { kind: "select", requestId: "theme", title: "Theme", options: ["amira", "amber"] },
    (answer) => answers.push(answer),
    undefined,
    {
      changed: (name) => previews.push(name),
      header: () => `Appearance: [${appearance}]`,
      handleInput: (event) => {
        if (event.type !== "key" || !["tab", "left", "right"].includes(event.name)) return false
        appearance = "light"
        return true
      },
    },
  )
  expect(stripAnsi(dialog.render(60, plain).join("\n"))).toContain("Appearance: [auto]")
  for (const name of ["tab", "left", "right"] as const) expect(dialog.handleInput(key(name))).toBe(true)
  expect(stripAnsi(dialog.render(60, plain).join("\n"))).toContain("Appearance: [light]")
  expect(previews).toEqual([])
  expect(answers).toEqual([])
  dialog.handleInput(key("down"))
  expect(previews).toEqual(["amber"])
  dialog.maxRows = 3
  const rows = dialog.render(20, plain)
  expect(rows).toHaveLength(3)
  expect(rows.every((row) => visibleWidth(row) <= 20)).toBe(true)
  dialog.handleInput(key("escape"))
  expect(answers).toEqual([undefined])
})

test("local picker footer keeps appearance discoverable when its header is trimmed", () => {
  const dialog = new Dialog(
    { kind: "select", requestId: "theme", title: "Theme", options: ["amira", "amber"] },
    () => {},
    undefined,
    { header: () => "Appearance: [auto] / dark / light", footer: [{ text: "Tab appearance", priority: 6 }] },
  )
  for (const maxRows of [1, 2, 3]) {
    dialog.maxRows = maxRows
    for (const width of [20, 60]) {
      const rows = dialog.render(width, plain).map(stripAnsi)
      expect(rows).toHaveLength(maxRows)
      expect(rows.join("\n")).not.toContain("Appearance:")
      expect(rows.at(-1)).toContain("Tab appearance")
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true)
    }
  }
})

test("select highlights its initial option, and Enter keeps it", () => {
  const d = open({
    kind: "select",
    requestId: "effort",
    title: "Thinking effort",
    options: ["low", "high (current)", "default (not sent)"],
    initial: "high (current)",
  })
  expect(d.rows()).toContain("❯ 2 high (current)")
  d.press("enter")
  expect(d.answers).toEqual(["high (current)"])
})

test("select navigates and filters from an initial option; Escape cancels", () => {
  const request: DialogRequest = {
    kind: "select",
    requestId: "effort",
    title: "Thinking effort",
    options: ["low", "high", "default (not sent)"],
    initial: "high",
  }
  const moved = open(request)
  moved.press("down", "enter")
  expect(moved.answers).toEqual(["default (not sent)"])
  const filtered = open(request)
  filtered.type("low")
  filtered.press("enter")
  expect(filtered.answers).toEqual(["low"])
  const cancelled = open(request)
  cancelled.press("escape")
  expect(cancelled.answers).toEqual([undefined])
})

test("select scrolls its initial option into view and falls back for an unknown option", () => {
  const options = Array.from({ length: 20 }, (_, i) => `option ${i}`)
  const last = open({ kind: "select", requestId: "r", title: "Pick", options, initial: "option 19" })
  expect(last.rows().some((row) => row.includes("❯") && row.includes("option 19"))).toBe(true)
  last.press("enter")
  expect(last.answers).toEqual(["option 19"])
  const unknown = open({ kind: "select", requestId: "r", title: "Pick", options, initial: "missing" })
  unknown.press("enter")
  expect(unknown.answers).toEqual(["option 0"])
})

for (const width of [120, 60]) {
  test(`session picker searches content and CJK, shows snippets below rows and deletes the filtered selection at ${width} columns`, () => {
    const { dialog, type, rows, answers } = open({
      kind: "select",
      requestId: "sessions",
      title: "Resume which session?",
      options: ["s_a Old session", "s_b Database repair"],
      descriptions: ["first prompt", "unrelated prompt"],
      searchTexts: ["other text", "Assistant answer: 数据库连接 NEEDLE"],
      sections: [{ at: 0, choose: "resume", keys: [{ key: "d", label: "delete" }] }],
    })
    type("数据库")
    const rendered = rows(width)
    expect(rendered.join("\n")).toContain("s_b Database repair")
    expect(rendered.join("\n")).not.toContain("s_a")
    const row = rendered.findIndex((s) => s.includes("s_b"))
    expect(rendered[row + 1]).toContain("数据库连接")
    expect(rendered.every((s) => visibleWidth(s) <= width)).toBe(true)
    expect(rendered.join("\n")).toContain("Ctrl+d delete")
    dialog.handleInput(key("d", { ctrl: true }))
    expect(answers).toEqual([{ option: "s_b Database repair", key: "d" }])
  })
}

test("session search uses substrings rather than fuzzy matching and ordinary d remains filter text", () => {
  const { type, rows, answers, dialog } = open({
    kind: "select",
    requestId: "r",
    title: "Sessions",
    options: ["s_1 Database"],
    searchTexts: ["MixedCase content"],
    sections: [{ at: 0, keys: [{ key: "d", label: "delete" }] }],
  })
  type("d")
  expect(answers).toEqual([])
  type("b")
  expect(rows().join("\n")).toContain("no match")
  dialog.handleInput(key("backspace"))
  dialog.handleInput(key("backspace"))
  type("mixedcase")
  expect(rows().join("\n")).toContain("MixedCase content")
})

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
    "┃   Yes",
    "┃   Yes, and don't ask again this session",
    "┃   No",
    "┃   Other…",
    "┃",
    "┃ ↑↓ select · n no · Esc deny",
  ])
  expect(ask().dialog.render(60, plain)).toEqual([
    "┃ 1/2 · Approach",
    "┃ ? Which approach do you prefer?",
    "┃",
    "┃ ❯ 1 Rewrite (Recommended)  Start over",
    "┃   2 Patch                  Fix it in place",
    "┃   3 Other…",
    "┃",
    "┃ ←→ question · ↑↓ move · Enter next · Esc cancel",
  ])
  expect(open({ kind: "input", requestId: "i", title: "Name", placeholder: "your name" }).rows()).toEqual([
    "? Name",
    "❯ your name",
    "",
    "Enter submit · Esc cancel",
  ])
})

test("a confirm starts with nothing selected: Enter and y do nothing until a choice is picked", () => {
  const early = approval()
  // Keys typed into a message just as the approval shows up do not answer it.
  early.type("1y")
  early.press("enter")
  expect(early.answers).toEqual([])
  early.press("down")
  expect(early.rows()[4]).toBe("❯ Yes")
  expect(early.rows().at(-1)).toBe("↑↓ move · n no · Enter choose · Esc deny")
  early.press("enter")
  expect(early.answers).toEqual([true])
  const no = approval()
  no.type("n")
  expect(no.answers).toEqual([false])
  const always = approval()
  always.press("down", "down", "enter")
  expect(always.answers).toEqual(["always"])
  // A confirm without the extras offers yes and no only; ↑ first picks the last one.
  const plainConfirm = open({ kind: "confirm", requestId: "c", title: "Go?" })
  expect(plainConfirm.rows()).toEqual(["? Go?", "", "  Yes", "  No", "", "↑↓ select · n no · Esc cancel"])
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
  press("down", "down", "enter")
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
    "  Yes",
    "  Yes, and don't ask again this session",
    "  No",
    "  Other…",
    "↑↓ select · n no · Esc deny",
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
    "←→ question · Enter next",
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
  expect(rows(80).at(-1)).toBe("←→ question · ↑↓ move · Space toggle · Enter submit · Esc back")
  press("enter")
  expect(answers).toEqual([[{ selected: ["Patch"] }, { selected: ["Tests", "Changelog"] }]])
})

test("Esc on a later question goes back to the one before, keeping the answers; on the first it cancels", () => {
  const { answers, type, press, rows } = ask()
  type("1")
  expect(rows()[0]).toBe("2/2 · Extras")
  press("escape")
  expect(answers).toEqual([])
  expect(rows()[0]).toBe("1/2 · Approach")
  expect(rows()).toContain("❯ 1 Rewrite (Recommended)  Start over")
  press("escape")
  expect(answers).toEqual([undefined])
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
  expect(rows(60).at(-1)).toBe("↑↓ select · j/x · Esc cancel")
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
  expect(confirm.rows(40).at(-1)).toBe("↓ select")
  confirm.press("down")
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

test("an input dialog short of rows keeps the caret: the title goes first, then the text scrolls", () => {
  const d = open({ kind: "input", requestId: "i2", title: "Commit message" })
  d.type("one two three four five six seven eight nine ten eleven twelve thirteen")
  d.dialog.maxRows = 3
  const lines = d.dialog.render(20, plain)
  expect(lines.length).toBeLessThanOrEqual(3)
  expect(lines.some((l) => l.includes(CURSOR_MARKER))).toBe(true)
  expect(stripAnsi(lines.at(-1)!)).toContain("Enter")
})

test("the position row of a scrolled list gives way before the title when rows are short", () => {
  const { dialog, rows } = select(Array.from({ length: 30 }, (_, i) => `option ${i}`))
  dialog.maxRows = 3
  const lines = rows()
  expect(lines.length).toBe(3)
  expect(lines[0]).toBe("? Model")
  expect(lines[1]).toBe("❯ option 0")
})

test("an input answered with nothing echoes as (empty), not as a bare question", () => {
  const r: DialogRequest = { kind: "input", requestId: "e", title: "Note" }
  expect(dialogEchoLines(r, "", plain.theme)).toEqual(["┃ ? Note ❯ (empty)"])
})

const sectioned = () =>
  open({
    kind: "select",
    requestId: "s1",
    title: "Sub-agents",
    options: ["1. Fix the parser · coder", "2. Scan the logs · explorer", "sa_1 · 3 files"],
    sections: [
      { at: 0, choose: "open", keys: [{ key: "p", label: "print" }] },
      { at: 2, title: "Kept worktrees", choose: "review" },
    ],
  })

test("a select's sections: a heading over their options, and their own Enter label and keys", () => {
  const { rows, press } = sectioned()
  expect(rows()).toEqual([
    "? Sub-agents",
    "",
    "❯ 1 Fix the parser · coder",
    "  2 Scan the logs · explorer",
    "  Kept worktrees",
    "  3 sa_1 · 3 files",
    "",
    "↑↓ move · Enter open · p print · Esc cancel",
  ])
  press("down", "down")
  expect(rows().at(-1)).toBe("↑↓ move · type to filter · Enter review · Esc cancel")
})

test("a section's key answers with the option it was pressed on; elsewhere it does nothing", () => {
  const a = sectioned()
  a.press("down")
  a.type("p")
  expect(a.answers).toEqual([{ option: "2. Scan the logs · explorer", key: "p" }])
  const b = sectioned()
  b.press("down", "down")
  b.type("p")
  // Not typed into the filter either.
  expect(b.answers).toEqual([])
  expect(b.rows().join("\n")).not.toContain("filter ❯")
  b.press("enter")
  expect(b.answers).toEqual(["sa_1 · 3 files"])
})

test("once a filter is typed, a section's key is part of it and leaves the hint", () => {
  const { rows, type, answers, press } = sectioned()
  type("ex")
  expect(rows().at(-1)).not.toContain("p print")
  type("p")
  expect(answers).toEqual([])
  expect(rows().join("\n")).toContain("filter ❯ exp")
  expect(rows().join("\n")).toContain("Scan the logs · explorer")
  press("enter")
  expect(answers).toEqual(["2. Scan the logs · explorer"])
})

test("a filtered sectioned list has no headings; the echo names the key's label", () => {
  const { rows, type } = sectioned()
  type("sa")
  expect(rows().join("\n")).not.toContain("Kept worktrees")
  const r = sectioned().dialog.request
  expect(dialogEchoLines(r, { option: "1. Fix the parser · coder", key: "p" }, plain.theme)).toEqual([
    "┃ ? Sub-agents ❯ 1. Fix the parser · coder · print",
  ])
})
