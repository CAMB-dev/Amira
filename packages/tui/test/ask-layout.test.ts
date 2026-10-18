import { afterEach, expect, test } from "bun:test"
import type { AskQuestion } from "@amira/api"
import { EventBus, UiRequests } from "@amira/core"
import { key, type MouseInput, stripAnsi, textKey, visibleWidth } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { Dialog, type DialogAnswer } from "../src/dialog.ts"
import { setGlyphs } from "../src/glyphs.ts"

const questions: AskQuestion[] = [
  {
    question: "How much detail should the summary include?",
    header: "Summary",
    options: [
      { label: "Detailed report", description: "Include the full explanation and the checks." },
      {
        label: "Short summary (Recommended)",
        description: "Show the outcome and the most important change.",
      },
      { label: "Diff only (Recommended)" },
    ],
  },
  {
    question: "Which results should be included?",
    header: "Checks",
    multiSelect: true,
    options: [
      { label: "Tests (Recommended)", description: "Include the test output." },
      { label: "Type check", description: "Include the type-check result." },
      { label: "Lint (Recommended)", description: "Include the lint result." },
    ],
  },
]

function open(pages = questions) {
  const answers: DialogAnswer[] = []
  const previews: string[] = []
  const dialog = new Dialog(
    { kind: "ask", requestId: "ask", title: "Questions", questions: pages },
    (answer) => answers.push(answer),
    undefined,
    { changed: (option) => previews.push(option) },
  )
  const render = (width = 80) => dialog.render(width, plain).map(stripAnsi)
  return { dialog, answers, previews, render }
}

afterEach(() => setGlyphs())

test("the first recommended single choice starts focused, but only Enter answers", () => {
  const { dialog, answers, previews, render } = open([questions[0]!])
  expect(render().find((row) => row.includes("›"))).toContain("2  Short summary (Recommended)")
  render()
  expect(answers).toEqual([])
  expect(previews).toEqual([])
  dialog.handleInput(key("enter"))
  expect(answers).toEqual([[{ selected: ["Short summary (Recommended)"] }]])
})

test("frontend defaults reach the answer transport only after all questions are submitted", async () => {
  const bus = new EventBus()
  const ui = new UiRequests(bus)
  let dialog: Dialog | undefined
  let resolved = false
  bus.subscribe((event) => {
    if (event.type === "ui.request" && event.data.kind === "ask") {
      expect(event.data.questions).toEqual(questions)
      dialog = new Dialog(event.data, (answer) => {
        expect(ui.respond(event.data.requestId, answer)).toBeUndefined()
      })
    }
  })
  const answer = ui
    .api()
    .ask(questions)
    .then((value) => {
      resolved = true
      return value
    })
  await bus.flush()
  dialog!.render(80, plain)
  expect(resolved).toBe(false)
  expect(ui.pending).toHaveLength(1)
  dialog!.handleInput(key("enter"))
  await bus.flush()
  dialog!.render(80, plain)
  expect(resolved).toBe(false)
  expect(ui.pending).toHaveLength(1)
  dialog!.handleInput(key("enter"))
  expect(await answer).toEqual([
    { selected: ["Short summary (Recommended)"] },
    { selected: ["Tests (Recommended)", "Lint (Recommended)"] },
  ])
})

test("without a recommended suffix the first option stays focused", () => {
  const { dialog, answers } = open([
    { question: "Pick?", options: [{ label: "Not (Recommended) here" }, { label: "Second" }] },
  ])
  dialog.handleInput(key("enter"))
  expect(answers).toEqual([[{ selected: ["Not (Recommended) here"] }]])
})

test("all multi-select recommendations start checked, can be unchecked, and wait for submission", () => {
  const { dialog, answers, render } = open()
  dialog.handleInput(key("enter"))
  let rows = render()
  expect(rows.find((row) => row.includes("Tests (Recommended)"))).toContain("[x]")
  expect(rows.find((row) => row.includes("Type check"))).toContain("[ ]")
  expect(rows.find((row) => row.includes("Lint (Recommended)"))).toContain("[x]")
  expect(answers).toEqual([])
  dialog.handleInput(key("space"))
  rows = render()
  expect(rows.find((row) => row.includes("Tests (Recommended)"))).toContain("[ ]")
  dialog.handleInput(key("left"))
  dialog.handleInput(key("right"))
  expect(render().find((row) => row.includes("Tests (Recommended)"))).toContain("[ ]")
  expect(answers).toEqual([])
  dialog.handleInput(key("enter"))
  expect(answers).toEqual([
    [{ selected: ["Short summary (Recommended)"] }, { selected: ["Lint (Recommended)"] }],
  ])
})

for (const [width, height] of [
  [120, 36],
  [80, 24],
] as const) {
  test(`ask layout has padded borders, spacer rows and separate descriptions at ${width}x${height}`, () => {
    const { dialog, render } = open()
    dialog.maxRows = height - 6
    for (const page of [0, 1]) {
      const rows = render(width)
      expect(rows[0]).toStartWith(`╭─ ${questions[page]!.question} ─`)
      expect(rows[1]!.trim()).toBe(`│${" ".repeat(width - 2)}│`)
      expect(rows[2]).toContain(`${page + 1}/2 · ${questions[page]!.header}`)
      expect(rows[3]).toBe(rows[1]!)
      expect(rows.at(-3)).toBe(rows[1]!)
      for (const row of rows.slice(1, -1)) {
        expect(row).toStartWith("│ ")
        expect(row).toEndWith(" │")
      }
      expect(rows.every((row) => visibleWidth(row) === width)).toBe(true)
      for (const option of questions[page]!.options) {
        if (!option.description) continue
        const y = rows.findIndex((row) => row.includes(option.label))
        expect(rows[y]).not.toContain(option.description)
        expect(rows[y + 1]).toContain(option.description)
        expect(rows[y + 1]!.indexOf(option.description)).toBeGreaterThan(rows[y]!.indexOf(option.label))
      }
      const labels = questions[page]!.options.map((option) => rows.find((row) => row.includes(option.label))!)
      if (page === 1) expect(new Set(labels.map((row) => row.indexOf("["))).size).toBe(1)
      dialog.handleInput(key("enter"))
    }
  })
}

test("short terminals drop spacer rows before descriptions, then descriptions before options", () => {
  const { dialog, render } = open()
  dialog.maxRows = 10
  const noBlanks = render()
  expect(noBlanks).toHaveLength(10)
  expect(noBlanks.some((row) => /^│ +│$/.test(row))).toBe(false)
  expect(noBlanks.join("\n")).toContain(questions[0]!.options[0]!.description!)
  dialog.maxRows = 9
  const noDescriptions = render()
  expect(noDescriptions.some((row) => /^│ +│$/.test(row))).toBe(false)
  expect(noDescriptions.join("\n")).not.toContain(questions[0]!.options[0]!.description!)
  for (const option of questions[0]!.options) expect(noDescriptions.join("\n")).toContain(option.label)
  for (const height of [1, 2, 3, 4, 5, 6, 8]) {
    dialog.maxRows = height
    const rows = render(30)
    expect(rows.length).toBeLessThanOrEqual(height)
    expect(rows.every((row) => visibleWidth(row) <= 30)).toBe(true)
    expect(rows.join("\n")).toContain("enter")
  }
})

test("descriptions wrap within the padded inner width", () => {
  const { render } = open([questions[0]!])
  const rows = render(32)
  expect(rows.every((row) => visibleWidth(row) === 32)).toBe(true)
  expect(rows.join("\n")).toContain("Include the full")
  expect(rows.join("\n")).toContain("explanation and the")
  expect(rows.join("\n")).toContain("checks.")
})

test("ask uses ASCII borders, cursor, separator, and navigation glyphs in ASCII mode", () => {
  setGlyphs({
    boxTopLeft: "+",
    boxTopRight: "+",
    boxBottomLeft: "+",
    boxBottomRight: "+",
    rule: "-",
    pointer: ">",
    choice: ">",
    more: ".",
    separator: ".",
    arrowUp: "Up",
    arrowDown: "Down",
    arrowLeft: "Left",
    arrowRight: "Right",
  })
  const { dialog } = open()
  const rows = dialog.render(80, { ...plain, glyphs: { ...plain.glyphs!, codeSide: "|" } }).map(stripAnsi)
  expect(rows[0]).toStartWith("+- How much detail should the summary include? -")
  expect(rows.slice(1, -1).every((row) => row.startsWith("| ") && row.endsWith(" |"))).toBe(true)
  expect(rows.join("\n")).toContain("> 2  Short summary (Recommended)")
  expect(rows.join("\n")).not.toMatch(/[╭╮╰╯│─›·←→↑↓]/)
})

test("the Other field mouse caret accounts for padding and the compact fallback", () => {
  for (const maxRows of [24, 3]) {
    const { dialog, answers, render } = open([
      { question: "Pick?", options: [{ label: "First" }, { label: "Second" }] },
    ])
    dialog.maxRows = maxRows
    dialog.handleInput(key("up"))
    dialog.handleInput(key("enter"))
    for (const ch of "abcd") dialog.handleInput(textKey(ch))
    const rows = render()
    const y = rows.findIndex((row) => row.includes("abcd"))
    const x = rows[y]!.indexOf("abcd") + 2
    for (const action of ["press", "release"] as const) {
      dialog.handleInput({
        type: "mouse",
        action,
        button: "left",
        x,
        y,
        shift: false,
        alt: false,
        ctrl: false,
      })
    }
    dialog.handleInput(textKey("X"))
    dialog.handleInput(key("enter"))
    expect(answers).toEqual([[{ selected: [], other: "abXcd" }]])
  }
})

for (const multiSelect of [false, true]) {
  test(`option and wrapped description rows share mouse targets (multiSelect=${multiSelect})`, () => {
    for (const text of ["Second", "explanation", "checks."]) {
      const { dialog, answers, render } = open([
        {
          question: "Pick?",
          multiSelect,
          options: [
            { label: "First" },
            { label: "Second", description: "Include the full explanation and the checks." },
          ],
        },
      ])
      const rows = render(32)
      const y = rows.findIndex((row) => row.includes(text))
      expect(y).toBeGreaterThan(0)
      const mouse = (action: MouseInput["action"]): MouseInput => ({
        type: "mouse",
        action,
        button: "left",
        x: 10,
        y,
        shift: false,
        alt: false,
        ctrl: false,
      })
      dialog.handleInput(mouse("press"))
      render(32)
      dialog.handleInput(mouse("release"))
      expect(answers).toEqual([])
      expect(render(32).find((row) => row.includes("Second"))).toContain(multiSelect ? "[x]" : "›")
      dialog.handleInput(key("enter"))
      expect(answers).toEqual([[{ selected: ["Second"] }]])
    }
  })
}
