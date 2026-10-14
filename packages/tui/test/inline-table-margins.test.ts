import { expect, test } from "bun:test"
import { FakeTerminal, Spinner } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { createInlineView } from "../src/inline-view.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { ReplyRenderers } from "../src/markdown-nodes.ts"

function setup() {
  const terminal = new FakeTerminal(120, 36)
  const screen = new VirtualScreen(120, 36)
  const write = terminal.write.bind(terminal)
  terminal.write = (data) => {
    write(data)
    screen.write(data)
  }
  const view = createInlineView({
    terminal,
    theme: plain.theme,
    capabilities: { win32InputMode: false, kittyKeyboard: true, synchronizedOutput: false, shiftEnter: true },
    // VirtualScreen does not reflow native history; the production streaming/commit path is unchanged.
    settings: { margin: 3, marginRows: 0, reflow: "off" },
    presenters: undefined,
    hyperlinks: false,
    renders: new ReplyRenderers(undefined),
    keys: new Keybindings(defaultKeys({ vscode: false })),
    spinner: new Spinner(),
    sessionId: () => "s",
    detail: () => "summary",
    bottom: () => ["input"],
    overlay: { render: () => [] },
    editorEmpty: () => true,
    showNote: () => {},
  })
  const resize = (cols: number, rows: number) => {
    screen.resize(cols, rows)
    terminal.setSize(cols, rows)
    view.render()
  }
  const row = (label: string) => {
    const matches = screen.text.split("\n").filter((row) => row.includes(label))
    expect(matches).toHaveLength(1)
    return matches[0]!
  }
  view.start()
  return { screen, view, resize, row }
}

const table = "| Check | State |\n| --- | --- |\n| Width | ok |\n| Height | ok |\n"

for (const [first, next, inset] of [
  [40, 80, 0],
  [80, 40, 3],
] as const) {
  test(`inline: a committed table keeps its outer inset across ${first}→${next} resize`, () => {
    const { screen, view, resize, row } = setup()
    try {
      resize(first, 7)
      view.replyDelta(table)
      view.render()
      const header = row("Check")
      expect(header.indexOf("Check")).toBe(inset + 2)
      // Native narrowing may clip the old timestamp, but must not redraw the committed table grid.
      const committedGrid = () =>
        screen.text
          .split("\n")
          .filter((line) => /Check|Width|Height|─/.test(line))
          .map((line) => line.slice(0, 40).trimEnd())
      const committed = committedGrid()
      resize(next, 24)
      expect(committedGrid()).toEqual(committed)
      expect(screen.lines.findLast((line) => line.includes("input"))!.indexOf("input")).toBe(
        next === 80 ? 3 : 0,
      )
      view.replyDelta("| Network | ok |")
      view.render()
      expect(row("Network").indexOf("Network")).toBe(header.indexOf("Check"))
      view.replyDelta("\n| Final | ok |")
      view.render()
      for (const label of ["Width", "Height", "Network", "Final"]) {
        expect(row(label).indexOf(label)).toBe(header.indexOf("Check"))
        expect(row(label).indexOf("│")).toBe(header.indexOf("│"))
      }
      expect(view.replyEnd([])).toBe(true)
      view.render()
      expect(row("Final").indexOf("Final")).toBe(header.indexOf("Check"))
      expect(row("Check").slice(0, 40).trimEnd()).toBe(header.slice(0, 40).trimEnd())
      // A new reply/table uses today's geometry, not the preceding table's frozen inset.
      view.replyDelta("| New | State |\n| --- | --- |\n| Done | ok |\n")
      view.replyEnd([])
      view.render()
      expect(row("New").indexOf("New")).toBe((next === 80 ? 3 : 0) + 2)
    } finally {
      view.stop()
    }
  })
}

for (const [first, next, inset] of [
  [40, 80, 0],
  [80, 40, 3],
] as const) {
  for (const complete of [true, false]) {
    test(`inline: a ${complete ? "complete" : "partial"} early header retains its inset across ${first}→${next}`, () => {
      const { screen, view, resize, row } = setup()
      try {
        resize(first, 7)
        view.replyDelta(`| ${"A".repeat(300)} | State |${complete ? "\n" : ""}`)
        view.render()
        const header = screen.text.split("\n").find((line) => line.includes("|"))!
        expect(header.indexOf("|")).toBe(inset + 2)
        expect(screen.text.match(/A/g)).toHaveLength(300)
        resize(next, 24)
        view.replyDelta(
          `${complete ? "" : "\n"}| --- | --- |\n| Network | ok |\n| ${"N".repeat(120)} | ok |\n`,
        )
        view.render()
        expect(row("Network").indexOf("|")).toBe(header.indexOf("|"))
        expect(row("---").indexOf("|")).toBe(header.indexOf("|"))
        expect(screen.text.match(/N/g)).toHaveLength(121)
        view.replyEnd([])
        view.render()
        expect(row("Network").indexOf("|")).toBe(header.indexOf("|"))
        expect(screen.text.match(/N/g)).toHaveLength(121)
        view.replyDelta("| Fresh | State |\n| --- | --- |\n| Done | ok |\n")
        view.replyEnd([])
        view.render()
        expect(row("Fresh").indexOf("Fresh")).toBe((next === 80 ? 3 : 0) + 2)
      } finally {
        view.stop()
      }
    })
  }
}

test("inline: an uncommitted header follows the margin until its delayed delimiter arrives", () => {
  const { view, resize, row } = setup()
  try {
    resize(40, 24)
    view.replyDelta("| Check | State |\n")
    view.render()
    expect(row("Check").indexOf("|")).toBe(2)
    expect(row("Check").indexOf("Check")).toBe(4)
    resize(80, 24)
    view.replyDelta("| --- | --- |\n| Network | ok |\n")
    view.replyEnd([])
    view.render()
    expect(row("Check").indexOf("Check")).toBe(5)
    expect(row("Network").indexOf("Network")).toBe(5)
  } finally {
    view.stop()
  }
})

test("inline: an unrecognized early header does not pin paragraphs or later tables", () => {
  const { view, resize, row } = setup()
  try {
    resize(40, 7)
    view.replyDelta(`| ${"A".repeat(300)} | State |\n`)
    view.render()
    resize(80, 24)
    view.replyDelta("Ordinary | prose\n\n| Fresh | State |\n| --- | --- |\n| Done | ok |\n")
    view.replyEnd([])
    view.render()
    expect(row("Ordinary").indexOf("Ordinary")).toBe(5)
    expect(row("Fresh").indexOf("Fresh")).toBe(5)
    expect(row("Done").indexOf("Done")).toBe(5)
  } finally {
    view.stop()
  }
})

test("inline: the next block in the same reply uses the current inset", () => {
  const { view, resize, row } = setup()
  try {
    resize(40, 7)
    view.replyDelta(table)
    view.render()
    resize(80, 24)
    view.replyDelta("| Network | ok |\n\nAfter\n\n| Fresh | State |\n| --- | --- |\n| Done | ok |")
    view.replyEnd([])
    view.render()
    expect(row("Network").indexOf("Network")).toBe(2)
    expect(row("After").indexOf("After")).toBe(5)
    expect(row("Fresh").indexOf("Fresh")).toBe(5)
    expect(row("Done").indexOf("Done")).toBe(5)
  } finally {
    view.stop()
  }
})

test("inline: a wholly live table still follows the responsive margin", () => {
  const { view, resize, row } = setup()
  try {
    resize(40, 24)
    view.replyDelta(table)
    view.render()
    expect(row("Check").indexOf("Check")).toBe(2)
    resize(80, 24)
    expect(row("Check").indexOf("Check")).toBe(5)
    expect(row("Width").indexOf("Width")).toBe(5)
    view.replyEnd([])
    view.render()
    expect(row("Check").indexOf("Check")).toBe(5)
  } finally {
    view.stop()
  }
})

test("inline: shrinking a frozen table wraps all live cell text without cropping", () => {
  const { screen, view, resize } = setup()
  try {
    resize(80, 7)
    view.replyDelta(`| ${"A".repeat(38)} |\n| --- |\n| first |\n| second |\n`)
    view.render()
    resize(40, 24)
    view.replyDelta(`| ${"z".repeat(35)}XYZ |`)
    view.render()
    expect(screen.text).toContain("XYZ")
    const live = screen.text.split("\n").filter((row) => row.includes("z") || row.includes("XYZ"))
    expect(live).toEqual([`     ${"z".repeat(35)}`, "     XYZ"])
    expect(live.join("").match(/z/g)).toHaveLength(35)
    view.replyDelta("\n")
    view.replyEnd([])
    view.render()
    const committed = screen.text.split("\n").filter((row) => row.includes("z") || row.includes("XYZ"))
    expect(committed).toEqual(live)
    expect(committed.join("").match(/z/g)).toHaveLength(35)
  } finally {
    view.stop()
  }
})

test("inline: shrinking a frozen raw table preserves every cell and its live wrap points", () => {
  const { screen, view, resize } = setup()
  try {
    resize(80, 7)
    const header = `| ${Array.from({ length: 12 }, (_, i) => `Header${i}`).join(" | ")} |\n`
    const delimiter = `| ${Array(12).fill("---").join(" | ")} |\n`
    view.replyDelta(header + delimiter)
    view.render()
    resize(40, 24)
    view.replyDelta(`| ${"z".repeat(150)}XYZ |`)
    view.render()
    expect(screen.text).toContain("XYZ")
    const live = screen.text.split("\n").filter((row) => row.includes("z") || row.includes("XYZ"))
    expect(live.join("").match(/z/g)).toHaveLength(150)
    for (const row of live) expect(row.startsWith("     ")).toBe(true)
    view.replyDelta("\n")
    view.replyEnd([])
    view.render()
    const committed = screen.text.split("\n").filter((row) => row.includes("z") || row.includes("XYZ"))
    expect(committed).toEqual(live)
    expect(committed.join("").match(/z/g)).toHaveLength(150)
  } finally {
    view.stop()
  }
})
