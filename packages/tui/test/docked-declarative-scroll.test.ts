// D deliberate oracle: the focus/list cursor is ›; authored widget nesting stays unchanged.
import { expect, test } from "bun:test"
import type { UiNode } from "@amira/api"
import { key, monoTheme, stripAnsi } from "@amira/tui-kit"
import { ExtensionViewer } from "../src/extension-view.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { setup, waitFor } from "./app-harness.ts"

for (const mode of ["fullscreen"] as const) {
  for (const rebound of [false, true]) {
    for (const shape of ["anonymous", "tabs-first", "identified"] as const) {
      test(`${mode}: ${shape} declarative dock scrolls and follows with ${rebound ? "rebound" : "default"} keys`, async () => {
        const data = {
          rows: Array.from({ length: 40 }, (_, i) => ({ kind: "text" as const, text: `DOCKROW-${i}` })),
        }
        const keys = new Keybindings({
          ...defaultKeys({ vscode: false }),
          ...(rebound
            ? {
                "scroll.page-up": ["ctrl+alt+p"],
                "scroll.page-down": ["ctrl+alt+n"],
                "scroll.bottom": ["ctrl+alt+b"],
              }
            : {}),
        })
        const up = rebound ? "\x1b[112;7u" : "\x1b[5~"
        const down = rebound ? "\x1b[110;7u" : "\x1b[6~"
        const end = rebound ? "\x1b[98;7u" : "\x1b[F"
        let events = 0
        const s = await setup([], {
          rows: 40,
          cols: 80,
          settings: { mode, margin: 3, marginRows: 1 },
          keybindings: keys,
          extensions: [
            (api) => {
              api.registerView({
                kind: "dock-scroll",
                title: () => "Declarative dock",
                ui: () => {
                  const body: UiNode = {
                    type: "text",
                    ...(shape === "identified" ? { id: "output" } : {}),
                    lines: data.rows,
                    follow: true,
                  }
                  return shape === "tabs-first"
                    ? { type: "tabs", id: "tabs", tabs: [{ key: "answer", label: "Answer", body }] }
                    : body
                },
                onEvent: () => events++,
              })
              api.registerCommand({
                name: "dock-scroll",
                description: "open dock",
                echo: false,
                run: (_args, ctx) => {
                  ctx.openView?.({ kind: "dock-scroll", placement: "dock", maxHeight: 10 })
                },
              })
            },
          ],
        })
        const output = () => s.screen.lines.filter((line) => line.includes("DOCKROW-")).join("\n")
        const send = async (input: string) => {
          s.terminal.send(input)
          await Bun.sleep(60)
        }
        const wheel = async () => {
          const row = s.screen.lines.findIndex((line) => line.includes("DOCKROW-"))
          expect(row).toBeGreaterThanOrEqual(0)
          await send(`\x1b[<64;6;${row + 1}M`)
        }
        try {
          s.terminal.send("/dock-scroll\r")
          await waitFor(() => s.live().includes("DOCKROW-39"), "declarative initial follow")
          await send("draft\x1b[D")
          const initial = output()
          await send(up)
          const afterUp = output()
          await send(down)
          const afterDown = output()
          await wheel()
          const afterWheel = output()
          await send(down)
          const downAfterWheel = output()
          await wheel()
          const beforeEnd = output()
          data.rows.push({ kind: "text", text: "DOCKROW-40" })
          await send("x")
          const paused = output()
          await send(end)
          const afterEnd = output()
          data.rows.push({ kind: "text", text: "DOCKROW-41" })
          await send("!")
          expect({
            pageUpChanges: afterUp !== initial,
            pageDownReturnsToEnd: afterDown.includes("DOCKROW-39"),
            wheelChanges: afterWheel !== afterDown,
            pageDownAfterWheelChanges: downAfterWheel !== afterWheel,
            pausedOutputStaysPut: paused === beforeEnd,
            endReturnsToEnd: afterEnd.includes("DOCKROW-40"),
            followsNewOutput: output().includes("DOCKROW-41"),
          }).toEqual({
            pageUpChanges: true,
            pageDownReturnsToEnd: true,
            wheelChanges: true,
            pageDownAfterWheelChanges: true,
            pausedOutputStaysPut: true,
            endReturnsToEnd: true,
            followsNewOutput: true,
          })
          expect(s.live()).toContain("drafx!t")
          expect(events).toBe(0)
        } finally {
          s.terminal.send("\x03\x03\x03")
          await s.exited
          await s.agent.dispose()
        }
      })
    }
  }
}

const frame = { theme: monoTheme, color: false, rows: 10 }
const lines = (prefix: string, count = 40) =>
  Array.from({ length: count }, (_, i) => ({ kind: "text" as const, text: `${prefix}-${i}` }))

for (const follow of [false, true]) {
  test(`anonymous dock honors initial follow=${follow} and End follows short content as it grows`, () => {
    const rows = lines("INITIAL")
    const viewer = new ExtensionViewer(
      {
        kind: "initial",
        title: () => "Initial",
        ui: () => ({ type: "text", lines: rows, follow }),
      },
      {},
      { placement: "dock" },
    )
    try {
      const first = viewer.render(80, frame).join("\n")
      expect(first).toContain(follow ? "INITIAL-39" : "INITIAL-0")
      expect(first).not.toContain(follow ? "INITIAL-0" : "INITIAL-39")
      rows.splice(1)
      viewer.render(80, frame)
      expect(viewer.handleDockInput(key("end"))).toBe(true)
      rows.push(...lines("GROWN"))
      expect(viewer.render(80, frame).join("\n")).toContain("GROWN-39")
    } finally {
      viewer.dispose()
    }
  })
}

test("dock fallback skips a short anonymous heading without moving widget focus", () => {
  const viewer = new ExtensionViewer(
    {
      kind: "header",
      title: () => "Header",
      ui: () => ({
        type: "column",
        children: [
          { size: 1, node: { type: "text", lines: [{ kind: "text", text: "Heading" }] } },
          {
            node: {
              type: "tabs",
              id: "tabs",
              tabs: [{ key: "answer", label: "Answer", body: { type: "text", lines: lines("BODY") } }],
            },
          },
        ],
      }),
    },
    {},
    { placement: "dock" },
  )
  try {
    expect(viewer.render(80, frame).join("\n")).toContain("BODY-0")
    expect(viewer.handleDockInput(key("pagedown"))).toBe(true)
    const scrolled = viewer.render(80, frame).map(stripAnsi).join("\n")
    expect(scrolled).toContain("Heading")
    expect(scrolled).toContain("BODY-7")
    expect(scrolled).not.toContain("BODY-0")
    expect(scrolled).toContain("› [Answer]")
  } finally {
    viewer.dispose()
  }
})

test("focused identified text keeps scrolling local instead of using the first anonymous region", () => {
  const viewer = new ExtensionViewer(
    {
      kind: "panes",
      title: () => "Panes",
      ui: () => ({
        type: "row",
        children: [
          { node: { type: "text", lines: lines("LEFT") } },
          { node: { type: "text", id: "right", lines: lines("RIGHT") } },
        ],
      }),
    },
    {},
    { placement: "dock", state: { focused: "right" } },
  )
  try {
    viewer.render(80, frame)
    expect(viewer.handleDockInput(key("pagedown"))).toBe(true)
    const scrolled = viewer.render(80, frame).map(stripAnsi).join("\n")
    expect(scrolled).toContain("LEFT-0")
    expect(scrolled).toContain("RIGHT-9")
    expect(scrolled).not.toContain("LEFT-9")
    expect(scrolled).not.toContain("RIGHT-0")
  } finally {
    viewer.dispose()
  }
})
