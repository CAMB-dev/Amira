import { expect, spyOn, test } from "bun:test"
import { key, type MouseInput, stripAnsi, textKey, visibleWidth } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { CommandPopup } from "../src/command-popup.ts"
import { Dialog, type DialogAnswer, type DialogRequest } from "../src/dialog.ts"
import type { FileSource } from "../src/file-index.ts"
import { FilePicker } from "../src/file-picker.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"

function mouse(
  action: MouseInput["action"],
  x: number,
  y: number,
  button: MouseInput["button"] = "left",
): MouseInput {
  return { type: "mouse", action, button, x, y, shift: false, alt: false, ctrl: false }
}

function click<T>(handle: (e: MouseInput) => T, x: number, y: number): T {
  handle(mouse("press", x, y))
  return handle(mouse("release", x, y))
}

function open(request: DialogRequest, keys?: Keybindings) {
  const answers: DialogAnswer[] = []
  const previews: string[] = []
  const dialog = new Dialog(request, (answer) => answers.push(answer), keys, {
    changed: (option) => previews.push(option),
  })
  const render = (width = 60) => dialog.render(width, plain).map(stripAnsi)
  const handle = (e: MouseInput) => dialog.handleInput(e)
  return { dialog, answers, previews, render, handle }
}

const select = (options = ["first", "second", "third"]) =>
  open({ kind: "select", requestId: "mouse", title: "Choose", options })

function row(rows: string[], text: string): number {
  const y = rows.findLastIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  return y
}

test("a choose/model/task row selects and previews on click, then confirms on double click", () => {
  const { dialog, answers, previews, render, handle } = select()
  const y = row(render(), "second")
  handle(mouse("press", 4, y))
  expect(answers).toEqual([])
  // Rendering between the press and release must not lose the press.
  render()
  expect(handle(mouse("release", 4, y))).toBe(true)
  expect(previews).toEqual(["second"])
  expect(render()[y]).toContain("›")
  expect(answers).toEqual([])
  click(handle, 4, y)
  expect(answers).toEqual(["second"])
  expect(dialog.handleInput(key("enter"))).toBe(false)
})

test("confirm and diff-review buttons activate on a single completed left click", () => {
  for (const request of [
    { kind: "confirm", requestId: "confirm", title: "Allow?", always: true },
    { kind: "diff-review", requestId: "diff", title: "Apply?", diff: "", options: ["Yes", "No"] },
  ] satisfies DialogRequest[]) {
    const { answers, render, handle } = open(request)
    const rows = render()
    const yes = rows.findIndex((line) => line.includes("Yes"))
    expect(yes).toBeGreaterThanOrEqual(0)
    handle(mouse("release", 4, yes))
    click((e) => handle({ ...e, button: "right" }), 4, yes)
    expect(answers).toEqual([])
    click(handle, 4, yes)
    expect(answers).toEqual([request.kind === "confirm" ? true : "Yes"])
  }
})

test("press and release on different options, borders, or outside do not answer", () => {
  const { answers, render, handle } = open({ kind: "confirm", requestId: "confirm", title: "Allow?" })
  const rows = render()
  const yes = row(rows, "Yes")
  const no = row(rows, "No")
  handle(mouse("press", 4, yes))
  handle(mouse("release", 4, no))
  handle(mouse("press", 4, yes))
  handle(mouse("release", -1, yes))
  for (const [x, y] of [
    [0, yes],
    [59, no],
    [4, 0],
    [4, rows.length - 1],
    [4, rows.length - 2],
  ]) {
    click(handle, x!, y!)
  }
  expect(answers).toEqual([])
  click(handle, 4, no)
  expect(answers).toEqual([false])
})

test("section headings are not choices, and wrapped descriptions select their option", () => {
  const { answers, previews, render, handle } = open({
    kind: "select",
    requestId: "sections",
    title: "Agents",
    options: ["alpha", "beta"],
    sections: [
      { at: 0, title: "Running" },
      { at: 1, title: "Completed" },
    ],
    descriptions: ["a long description that wraps onto several lines", "short"],
  })
  const rows = render(24)
  click(handle, 4, row(rows, "Completed"))
  expect(previews).toEqual([])
  click(handle, 4, row(rows, "short"))
  expect(previews).toEqual(["beta"])
  expect(answers).toEqual([])
  click(handle, 4, row(render(24), "short"))
  expect(answers).toEqual(["beta"])
})

test("scrolled and filtered choose lists map displayed rows to their original values", () => {
  const options = Array.from({ length: 20 }, (_, i) => `agent-${String(i).padStart(2, "0")}`)
  const { dialog, answers, render, handle } = select(options)
  dialog.maxRows = 7
  for (let i = 0; i < 15; i++) dialog.handleInput(key("down"))
  const y = row(render(), "agent-15")
  click(handle, 4, y)
  click(handle, 4, y)
  expect(answers).toEqual(["agent-15"])

  const filtered = select(options)
  for (const ch of "19") filtered.dialog.handleInput(textKey(ch))
  const at = row(filtered.render(), "agent-19")
  click(filtered.handle, 4, at)
  click(filtered.handle, 4, at)
  expect(filtered.answers).toEqual(["agent-19"])
})

test("tiny fallback renders cannot leave old invisible choices clickable", () => {
  const { dialog, answers, render, handle } = select()
  const y = row(render(), "second")
  handle(mouse("press", 4, y))
  dialog.maxRows = 1
  expect(render()).toHaveLength(1)
  handle(mouse("release", 4, y))
  click(handle, 4, 0)
  click(handle, 4, 0)
  expect(answers).toEqual([])

  dialog.maxRows = 3
  const compact = render()
  const at = row(compact, "first")
  click(handle, 4, at)
  click(handle, 4, at)
  expect(answers).toEqual(["first"])
})

test("filter changes invalidate in-progress clicks and double clicks expire", () => {
  const now = spyOn(Date, "now").mockReturnValue(1000)
  try {
    const { dialog, answers, render, handle } = select()
    const y = row(render(), "first")
    handle(mouse("press", 4, y))
    dialog.handleInput(textKey("third"))
    const at = row(render(), "third")
    handle(mouse("release", 4, at))
    expect(answers).toEqual([])
    click(handle, 4, at)
    now.mockReturnValue(1401)
    click(handle, 4, at)
    expect(answers).toEqual([])
    now.mockReturnValue(1500)
    click(handle, 4, at)
    expect(answers).toEqual(["third"])
  } finally {
    now.mockRestore()
  }
})

test("live task labels still answer with the original option", () => {
  const request = {
    kind: "select",
    requestId: "tasks",
    title: "Tasks",
    options: ["task-a", "task-b"],
  } as const
  const { dialog, answers, render, handle } = open({ ...request, options: [...request.options] })
  const y = row(render(), "task-b")
  click(handle, 4, y)
  expect(
    dialog.update({ ...request, options: [...request.options], optionLabels: ["Alpha", "Beta done"] }),
  ).toBe(true)
  const next = row(render(), "Beta done")
  click(handle, 4, next)
  expect(answers).toEqual(["task-b"])
})

test("multi-select clicks toggle a checkbox, and double click submits rather than toggling back", () => {
  const { answers, render, handle } = open({
    kind: "ask",
    requestId: "ask",
    title: "Questions",
    questions: [{ question: "Pick", options: [{ label: "alpha" }, { label: "beta" }], multiSelect: true }],
  })
  const y = row(render(), "beta")
  click(handle, 4, y)
  expect(answers).toEqual([])
  expect(render()[y]).toContain("[x]")
  click(handle, 4, y)
  expect(answers).toEqual([[{ selected: ["beta"] }]])
})

test("free-text choices open and their field caret can be placed with a click", () => {
  const { dialog, answers, render, handle } = open({
    kind: "confirm",
    requestId: "other",
    title: "Allow?",
    other: true,
  })
  const y = row(render(), "Other")
  click(handle, 4, y)
  dialog.handleInput(textKey("abcd"))
  const fieldRow = render()[y]!
  const x = fieldRow.indexOf("abcd") + 2
  click(handle, x, y)
  dialog.handleInput(textKey("X"))
  dialog.handleInput(key("enter"))
  expect(answers).toEqual([{ other: "abXcd" }])
})

test("secret dialog fields place the caret without exposing their text", () => {
  const { dialog, answers, render, handle } = open({
    kind: "input",
    requestId: "secret",
    title: "Key",
    secret: true,
  })
  dialog.handleInput(textKey("abcd"))
  const rows = render()
  const y = row(rows, "****")
  expect(rows.join("\n")).not.toContain("abcd")
  click(handle, rows[y]!.indexOf("****") + 1, y)
  dialog.handleInput(textKey("X"))
  dialog.handleInput(key("enter"))
  expect(answers).toEqual(["aXbcd"])
})

test("regular dialog inputs place the caret on clicked text", () => {
  const { dialog, answers, render, handle } = open({
    kind: "input",
    requestId: "input",
    title: "Text",
    initial: "abcd",
  })
  const rows = render()
  const y = row(rows, "abcd")
  click(handle, rows[y]!.indexOf("abcd") + 1, y)
  dialog.handleInput(textKey("X"))
  dialog.handleInput(key("enter"))
  expect(answers).toEqual(["aXbcd"])
})

test("dialog footer submit and cancel activate on completed clicks", () => {
  for (const action of ["submit", "cancel"]) {
    const { answers, render, handle } = open({
      kind: "input",
      requestId: "footer",
      title: "Text",
      initial: "answer",
    })
    const rows = render()
    const y = row(rows, action)
    click(handle, rows[y]!.indexOf(action), y)
    expect(answers).toEqual([action === "submit" ? "answer" : undefined])
  }
})

test("input cursor clicks respect graphemes, wide cells, wrapped and scrolled rows", () => {
  for (const scenario of [
    { initial: "Aé界👩‍💻Z", shown: "Aé界", offset: 3, expected: "AéX界👩‍💻Z" },
    { initial: "Aé界👩‍💻Z", shown: "Aé界", offset: 6, expected: "Aé界👩‍💻XZ" },
    { initial: "first\nsecond", shown: "second", offset: 2, expected: "first\nseXcond" },
    { initial: "abcdefghiJKLMN", shown: "JKLMN", offset: 1, expected: "abcdefghiJXKLMN", width: 12 },
    {
      initial: "first\nsecond\nthird\nfourth",
      shown: "third",
      offset: 1,
      expected: "first\nsecond\ntXhird\nfourth",
      maxRows: 6,
    },
    { initial: "first\nsecond", shown: "second", offset: 1, expected: "first\nsXecond", maxRows: 3 },
  ]) {
    const { dialog, answers, render, handle } = open({
      kind: "input",
      requestId: "cursor",
      title: "Text",
      initial: scenario.initial,
    })
    dialog.maxRows = scenario.maxRows ?? Infinity
    const rows = render(scenario.width)
    const y = row(rows, scenario.shown)
    const x = visibleWidth(rows[y]!.slice(0, rows[y]!.indexOf(scenario.shown))) + scenario.offset
    handle(mouse("press", x, y))
    render(scenario.width)
    handle(mouse("release", x, y))
    dialog.handleInput(textKey("X"))
    dialog.handleInput(key("enter"))
    expect(answers).toEqual([scenario.expected])
  }
})

test("footer clicks require the same visible button on press and release", () => {
  const { answers, render, handle } = open({
    kind: "input",
    requestId: "footer",
    title: "Text",
    initial: "answer",
  })
  const rows = render()
  const y = row(rows, "submit")
  const submit = rows[y]!.indexOf("submit")
  const cancel = rows[y]!.indexOf("cancel")
  handle(mouse("release", submit, y))
  handle(mouse("press", submit, y))
  handle(mouse("release", cancel, y))
  handle(mouse("press", submit, y))
  handle(mouse("release", 0, y))
  click((e) => handle({ ...e, button: "right" }), submit, y)
  click(handle, rows[y]!.indexOf("·"), y)
  expect(answers).toEqual([])
  handle(mouse("press", submit, y))
  render()
  handle(mouse("release", submit, y))
  expect(answers).toEqual(["answer"])
})

test("compact footers retain buttons, but dropped and truncated hints are not clickable", () => {
  for (const maxRows of [1, 2, 3, 4]) {
    const { dialog, answers, render, handle } = open({
      kind: "input",
      requestId: "compact",
      title: "Text",
      initial: "answer",
    })
    dialog.maxRows = maxRows
    const rows = render()
    const y = row(rows, "cancel")
    click(handle, rows[y]!.indexOf("cancel"), y)
    expect(answers).toEqual([undefined])
  }
  const { dialog, answers, render, handle } = open({
    kind: "input",
    requestId: "clipped",
    title: "Text",
    initial: "answer",
  })
  const rows = render()
  const y = row(rows, "cancel")
  handle(mouse("press", rows[y]!.indexOf("cancel"), y))
  dialog.maxRows = 1
  const narrow = render(18)
  expect(narrow.join()).not.toContain("cancel")
  handle(mouse("release", 16, 0))
  click(handle, 16, 0)
  for (const width of [1, 3, 4, 8]) {
    const clipped = render(width)
    expect(clipped.join()).not.toContain("submit")
    for (let x = 0; x < width; x++) click(handle, x, 0)
  }
  expect(answers).toEqual([])
  const restored = render()
  click(handle, restored[0]!.indexOf("submit"), 0)
  expect(answers).toEqual(["answer"])
})

test("footer buttons send the displayed rebound submit and cancel keys", () => {
  const keys = new Keybindings({
    ...defaultKeys({ vscode: false }),
    "dialog.choose": ["alt+s"],
    "dialog.cancel": ["ctrl+c", "escape"],
  })
  for (const action of ["submit", "cancel"]) {
    const { answers, render, handle } = open(
      {
        kind: "input",
        requestId: "rebound",
        title: "Text",
        initial: "answer",
      },
      keys,
    )
    const rows = render()
    const y = row(rows, action)
    expect(rows[y]).toContain(action === "submit" ? "alt+s" : "ctrl+c")
    click(handle, rows[y]!.indexOf(action), y)
    expect(answers).toEqual([action === "submit" ? "answer" : undefined])
  }
})

test("field footer back preserves Escape versus rebound cancel semantics", () => {
  for (const cancel of ["escape", "ctrl+c"]) {
    const keys = new Keybindings({ ...defaultKeys({ vscode: false }), "dialog.cancel": [cancel] })
    const { dialog, answers, render, handle } = open(
      {
        kind: "confirm",
        requestId: "field",
        title: "Allow?",
        other: true,
      },
      keys,
    )
    const rows = render()
    click(handle, 4, row(rows, "Other"))
    dialog.handleInput(textKey("draft"))
    const field = render()
    const y = row(field, "back")
    click(handle, field[y]!.indexOf("back"), y)
    expect(answers).toEqual(cancel === "escape" ? [] : [undefined])
    if (cancel === "escape") expect(render().join()).toContain('Other… "draft"')
  }
})

test("list footers choose, submit fields, and go back through questions like their keys", () => {
  const chosen = select()
  let rows = chosen.render()
  let y = row(rows, "choose")
  click(chosen.handle, rows[y]!.indexOf("choose"), y)
  expect(chosen.answers).toEqual(["first"])

  const field = open({ kind: "confirm", requestId: "field-submit", title: "Allow?", other: true })
  rows = field.render()
  click(field.handle, 4, row(rows, "Other"))
  field.dialog.handleInput(textKey("draft"))
  rows = field.render()
  y = row(rows, "submit")
  click(field.handle, rows[y]!.indexOf("submit"), y)
  expect(field.answers).toEqual([{ other: "draft" }])

  for (const cancel of ["escape", "ctrl+c"]) {
    const keys = new Keybindings({ ...defaultKeys({ vscode: false }), "dialog.cancel": [cancel] })
    const questions = open(
      {
        kind: "ask",
        requestId: "questions",
        title: "Questions",
        questions: [
          { question: "First question", options: [{ label: "alpha" }] },
          { question: "Second question", options: [{ label: "beta" }] },
        ],
      },
      keys,
    )
    rows = questions.render()
    y = row(rows, "next")
    click(questions.handle, rows[y]!.indexOf("next"), y)
    expect(questions.render().join()).toContain("Second question")
    rows = questions.render()
    y = row(rows, "back")
    click(questions.handle, rows[y]!.indexOf("back"), y)
    expect(questions.answers).toEqual(cancel === "escape" ? [] : [undefined])
    if (cancel === "escape") expect(questions.render().join()).toContain("First question")
  }
})

test("unbound dialog actions have no footer targets", () => {
  const keys = new Keybindings({
    ...defaultKeys({ vscode: false }),
    "dialog.choose": [],
    "dialog.cancel": [],
  })
  const { answers, render, handle } = open({ kind: "input", requestId: "unbound", title: "Text" }, keys)
  const rows = render()
  expect(rows.join()).not.toMatch(/submit|cancel/)
  for (let x = 0; x < 60; x++) click(handle, x, rows.length - 2)
  expect(answers).toEqual([])
})

function popup(count = 12) {
  const candidates = Array.from({ length: count }, (_, i) => ({ value: `command-${i}` }))
  const value = new CommandPopup({ complete: () => ({ candidates }), list: () => [] }, () => {})
  value.update("/")
  const handle = (e: MouseInput) => value.handleKey(e)
  return { value, handle }
}

test("slash completion clicks select visible candidates; double click runs the selection", () => {
  const { value, handle } = popup()
  for (let i = 0; i < 10; i++) value.handleKey(key("down"))
  const rows = value.render(50, plain, 4)
  const y = row(rows, "command-9")
  expect(handle(mouse("press", 3, y))).toEqual({ type: "handled" })
  value.render(50, plain, 4)
  expect(handle(mouse("release", 3, y))).toEqual({ type: "handled" })
  expect(click(handle, 3, y)).toEqual({ type: "run", line: "/command-9" })
})

test("completion counters and stale asynchronous candidates are not selectable", async () => {
  const { value, handle } = popup()
  const rows = value.render(50, plain, 4)
  const counter = rows.length - 1
  click(handle, 3, counter)
  click(handle, 3, counter)
  expect(value.handleKey(key("enter"))).toEqual({ type: "handled" })
  let resolve: ((value: { candidates: { value: string }[] }) => void) | undefined
  const stale = new CommandPopup(
    {
      complete: (text) =>
        text === "/"
          ? { candidates: [{ value: "old" }] }
          : new Promise((done) => {
              resolve = done
            }),
      list: () => [],
    },
    () => {},
  )
  stale.update("/")
  stale.render(50, plain)
  stale.handleKey(mouse("press", 3, 0))
  const pending = stale.update("/new")
  expect(stale.render(50, plain)).toEqual(["  /old"])
  expect(stale.handleKey(mouse("release", 3, 0))).toBeUndefined()
  resolve?.({ candidates: [{ value: "new" }] })
  await pending
  stale.render(50, plain)
  expect(stale.handleKey(mouse("release", 3, 0))).toEqual({ type: "handled" })
  expect(stale.handleKey(key("enter"))).toEqual({ type: "run", line: "/new" })
})

test("argument and skill completions confirm the clicked candidate", () => {
  for (const sigil of ["/", "$"] as const) {
    const value = new CommandPopup(
      {
        complete: () => ({
          ...(sigil === "/" ? { command: "model" } : {}),
          candidates: [{ value: "one" }, { value: "two" }],
        }),
        list: () => [],
      },
      () => {},
      undefined,
      sigil,
    )
    value.update(sigil === "/" ? "/model " : "$")
    value.render(50, plain)
    const handle = (e: MouseInput) => value.handleMouse(e)
    expect(click(handle, 3, 1)).toEqual({ type: "handled" })
    value.render(50, plain)
    expect(click(handle, 3, 1)).toEqual({ type: "run", line: sigil === "/" ? "/model two" : "$two" })
  }
})

function files(entries = ["alpha.ts", "beta.ts", "some file.ts"], partial = false) {
  const source: FileSource = {
    listing: () => ({ entries, files: entries.length, done: true, partial }),
    subscribe: () => () => {},
  }
  const value = new FilePicker(source, () => {})
  value.update("look @")
  const handle = (e: MouseInput) => value.handleKey(e)
  return { value, handle }
}

test("file picker double click inserts the displayed quoted path and preserves directory continuation", () => {
  for (const chosen of ["some file.ts", "src/"]) {
    const { value, handle } = files(["alpha.ts", chosen])
    try {
      const rows = value.render(50, plain)
      const y = row(rows, chosen)
      expect(click(handle, 3, y)).toEqual({ type: "handled" })
      value.render(50, plain)
      expect(click(handle, 3, y)).toEqual({
        type: "insert",
        replace: 1,
        text: chosen.endsWith("/") ? "@src/" : '@"some file.ts" ',
      })
    } finally {
      value.dispose()
    }
  }
})

test("file picker scrolling excludes counters and partial-list status rows from hit targets", () => {
  const entries = Array.from({ length: 15 }, (_, i) => `file-${String(i).padStart(2, "0")}.ts`)
  const { value, handle } = files(entries, true)
  try {
    for (let i = 0; i < 12; i++) value.handleKey(key("down"))
    const rows = value.render(50, plain, 5)
    const counter = row(rows, "13/15")
    const status = row(rows, "searched the first")
    for (const y of [counter, status]) {
      expect(click(handle, 3, y)).toEqual({ type: "handled" })
      expect(click(handle, 3, y)).toEqual({ type: "handled" })
    }
    const y = row(rows, "file-12.ts")
    click(handle, 3, y)
    expect(click(handle, 3, y)).toEqual({ type: "insert", replace: 1, text: "@file-12.ts " })
  } finally {
    value.dispose()
  }
})

test("file query changes reset pending clicks, and hidden renders clear regions", () => {
  const { value, handle } = files()
  try {
    value.render(50, plain)
    handle(mouse("press", 3, 1))
    value.update("@some")
    value.render(50, plain)
    expect(handle(mouse("release", 3, 0))).toEqual({ type: "handled" })
    expect(click(handle, 3, 0)).toEqual({ type: "handled" })
    value.render(50, plain, 0)
    expect(handle(mouse("release", 3, 0))).toBeUndefined()
    value.render(50, plain)
    expect(click(handle, 3, 0)).toEqual({ type: "handled" })
  } finally {
    value.dispose()
  }
})

test("wheel reports scroll only the picker under the pointer and clamp rather than wrap", () => {
  const { handle, render, previews } = select()
  render()
  expect(handle(mouse("wheel", 4, 2, "down"))).toBe(true)
  expect(previews).toEqual(["third"])
  expect(handle(mouse("wheel", 4, 2, "down"))).toBe(true)
  expect(previews.at(-1)).toBe("third")
  expect(handle(mouse("wheel", 4, -1, "up"))).toBe(false)
  const command = popup()
  command.value.render(50, plain)
  expect(command.handle(mouse("wheel", 4, 0, "down"))).toEqual({ type: "handled" })
  expect(command.handle(mouse("wheel", 4, -1, "up"))).toBeUndefined()
  const file = files()
  try {
    file.value.render(50, plain)
    expect(file.handle(mouse("wheel", 4, 0, "down"))).toEqual({ type: "handled" })
    expect(file.handle(mouse("wheel", 4, -1, "up"))).toBeUndefined()
  } finally {
    file.value.dispose()
  }
})
