import { expect, test } from "bun:test"
import { stripAnsi, visibleWidth } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { Dialog } from "../src/dialog.ts"
import { contentGeometry, insetLines, marginView } from "../src/margins.ts"
import { cellsOf } from "../src/text-selection.ts"
import { marginFrame, zeroMargins } from "./margins-fixture.ts"

for (const columns of [100, 70]) {
  test(`default geometry at ${columns}x30 reserves three cells and one fullscreen row per edge`, () => {
    expect(contentGeometry(columns, 30, {}, true)).toEqual({
      left: 3,
      width: columns - 6,
      rows: 1,
      height: 28,
    })
    expect(contentGeometry(columns, 30, {}, false)).toEqual({
      left: 3,
      width: columns - 6,
      rows: 0,
      height: 30,
    })
    expect(contentGeometry(columns, 30, zeroMargins, true)).toEqual({
      left: 0,
      width: columns,
      rows: 0,
      height: 30,
    })
  })

  for (const fullscreen of [true, false]) {
    test(`${fullscreen ? "fullscreen" : "inline"} real ${columns}x30 live and committed frames stay inside the margin`, () => {
      const frame = marginFrame(fullscreen, columns, 30, {})
      for (const state of [frame.live, frame.committed]) {
        for (const row of [...state.scrollback, ...state.grid]) {
          if (row) expect(row.slice(0, 3)).toBe("   ")
          expect(visibleWidth(row.trimEnd())).toBeLessThanOrEqual(columns - 3)
        }
      }
      if (fullscreen) {
        expect(frame.live.grid[0]!.trim()).toBe("")
        expect(frame.live.grid.at(-1)!.trim()).toBe("")
      }
      const output = [...frame.live.scrollback, ...frame.live.grid].join("\n")
      for (const text of [
        "Fix add",
        "Check the operator.",
        "const add",
        "Edited",
        "Ran bun test",
        "Check the changes",
      ])
        expect(output).toContain(text)
      expect(output).toContain(`     ╭─ ts${"─".repeat(columns - 14)}╮`)
      expect(frame.committed.ansi).toContain("48;2;71;20;26m")
      expect(frame.committed.ansi).toContain("48;2;15;58;18m")
    })
  }

  test(`fullscreen ANSI user, code and diff surfaces at ${columns} columns do not paint margin cells`, () => {
    const { live } = marginFrame(true, columns, 30, {})
    // CUP starts every real fullscreen row; line breaks delimit the exit printout.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal cursor addressing
    const rows = live.ansi.split(/\x1b\[\d+;\d+H|\r?\n/)
    let painted = 0
    for (const row of rows) {
      let background = false
      for (const cell of cellsOf(row)) {
        if (cell.escape) {
          if (cell.text.startsWith("\x1b[48;")) background = true
          if (cell.text === "\x1b[49m" || cell.text === "\x1b[0m") background = false
        } else if (background && cell.width > 0) {
          painted++
          expect(cell.col).toBeGreaterThanOrEqual(3)
          expect(cell.col + cell.width).toBeLessThanOrEqual(columns - 3)
        }
      }
    }
    expect(painted).toBeGreaterThan(columns)
  })
}

test("narrow margins shrink just enough to preserve sixty content columns", () => {
  for (const [columns, left, width] of [
    [50, 0, 50],
    [60, 0, 60],
    [61, 0, 61],
    [62, 1, 60],
    [63, 1, 61],
    [64, 2, 60],
    [65, 2, 61],
    [66, 3, 60],
  ]) {
    expect(contentGeometry(columns!, 30, {}, true)).toMatchObject({ left, width })
  }
  expect(contentGeometry(70, 30, { margin: 12, marginRows: 2 }, true)).toEqual({
    left: 5,
    width: 60,
    rows: 2,
    height: 26,
  })
})

for (const fullscreen of [true, false]) {
  test(`${fullscreen ? "fullscreen" : "inline"} real narrow and short frames keep input and committed text within content bounds`, () => {
    for (const columns of [40, 50, 62, 64]) {
      for (const rows of [12, 23]) {
        const geometry = contentGeometry(columns, rows, {}, fullscreen)
        const frame = marginFrame(fullscreen, columns, rows, {})
        expect(frame.live.grid.join("\n")).toContain("Check the changes")
        for (const state of [frame.live, frame.committed]) {
          for (const row of [...state.scrollback, ...state.grid]) {
            if (row) expect(row.slice(0, geometry.left)).toBe(" ".repeat(geometry.left))
            expect(visibleWidth(row.trimEnd())).toBeLessThanOrEqual(columns - geometry.left)
          }
        }
      }
    }
  })
}

test("narrow terminals keep at least one content cell; short fullscreen and inline have no row margins", () => {
  for (const columns of [1, 2, 5, 10, 20, 40, 50, 64]) {
    for (const rows of [1, 5, 12, 23]) {
      for (const fullscreen of [true, false]) {
        const geometry = contentGeometry(columns, rows, {}, fullscreen)
        expect(geometry.left).toBeGreaterThanOrEqual(0)
        expect(geometry.left).toBeLessThanOrEqual(3)
        expect(geometry.width).toBeGreaterThanOrEqual(1)
        expect(geometry.width + geometry.left * 2).toBe(columns)
        expect(geometry.rows).toBe(0)
        expect(geometry.height).toBe(rows)
      }
    }
  }
})

test("insetting preserves ANSI byte-for-byte and zero margins preserve both component and line behavior", () => {
  const lines = ["\x1b[48;2;32;32;32m band \x1b[49m", "", "code"]
  expect(insetLines(lines, 3)).toEqual([`   ${lines[0]}`, "", "   code"])
  expect(insetLines(lines, 0)).toEqual(lines)
  const component = { render: () => lines }
  expect(marginView(component, zeroMargins, true).render(70, { ...plain, rows: 30 })).toEqual(lines)
})

for (const fullscreen of [true, false]) {
  test(`${fullscreen ? "fullscreen" : "inline"} real dialog overlay uses the reduced viewport`, () => {
    const dialog = new Dialog(
      { kind: "select", requestId: "margin-dialog", title: "Choose model", options: ["mock/m1", "mock/m2"] },
      () => {},
    )
    const frame = marginFrame(
      fullscreen,
      70,
      30,
      {},
      {
        overlay: dialog,
        afterRender: (view) => {
          view.openOverlay()
          view.renderOverlay()
        },
      },
    )
    expect(frame.live.grid.join("\n")).toContain("Choose model")
    for (const row of frame.live.grid) {
      expect(row.slice(0, 3)).toBe("   ")
      expect(row.slice(-3)).toBe("   ")
    }
    expect(frame.live.grid[0]!.trim()).toBe("")
    expect(frame.live.grid.at(-1)!.trim()).toBe("")
  })
}

test("fullscreen translates mouse columns and copies code without adding margin spaces", () => {
  let copied: string | undefined
  marginFrame(
    true,
    100,
    30,
    {},
    {
      afterRender: (view, screen, terminal) => {
        const y = screen.lines.findIndex((line) => line.includes("const add"))
        expect(y).toBeGreaterThanOrEqual(0)
        const x = screen.lines[y]!.indexOf("const")
        for (const [action, column] of [
          ["press", x],
          ["drag", x + 4],
          ["release", x + 4],
        ] as const)
          view.handleInput({
            type: "mouse",
            action,
            button: "left",
            x: column,
            y,
            shift: false,
            alt: false,
            ctrl: false,
          })
        const clipboard = screen.oscs.filter((osc) => osc.startsWith("52;c;")).at(-1)
        copied = clipboard && Buffer.from(clipboard.slice(5), "base64").toString()
        expect(stripAnsi(terminal.output)).toContain("const add")
      },
    },
  )
  expect(copied).toBe("const")
})

test("a margin-wrapped component gets reduced columns and row context, not merely prefixed output", () => {
  const calls: { width: number; rows: number }[] = []
  const component = {
    render: (width: number, ctx: typeof plain) => {
      calls.push({ width, rows: ctx.rows })
      return ["x".repeat(width)]
    },
  }
  const lines = marginView(component, {}, true).render(70, { ...plain, rows: 30 })
  expect(calls).toEqual([{ width: 64, rows: 28 }])
  expect(lines[0]).toBe("")
  expect(lines[1]).toBe(`   ${"x".repeat(64)}`)
  expect(lines.at(-1)).toBe("")
})
