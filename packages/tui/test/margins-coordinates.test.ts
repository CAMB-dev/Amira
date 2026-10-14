import { expect, test } from "bun:test"
import { emptyUsage, type UiState } from "@amira/api"
import { type MouseInput, visibleWidth } from "@amira/tui-kit"
import { agentsCommand } from "../../../extensions/agent/src/index.ts"
import { subagentView } from "../../../extensions/agent/src/subagent-view.ts"
import { plain } from "../../tui-kit/test/context.ts"
import { contentGeometry, contentMouse, marginView } from "../src/margins.ts"
import { setup, waitFor } from "./app-harness.ts"
import { marginFrame } from "./margins-fixture.ts"

const press: MouseInput = {
  type: "mouse",
  action: "press",
  button: "left",
  x: 3,
  y: 1,
  ctrl: false,
  alt: false,
  shift: false,
}

test("configured margins follow the prototype formula at every narrow-width boundary", () => {
  for (const configured of [0, 1, 3, 12]) {
    for (let columns = 1; columns <= 100; columns++) {
      const expected =
        columns - 2 * configured >= 60 ? configured : Math.max(0, Math.floor((columns - 60) / 2))
      const geometry = contentGeometry(columns, 30, { margin: configured, marginRows: 2 }, true)
      expect(geometry.left).toBe(expected)
      expect(geometry.width).toBe(columns - 2 * expected)
      expect(geometry.rows).toBe(2)
      expect(geometry.height).toBe(26)
    }
  }
  expect(contentGeometry(100, 23, { marginRows: 2 }, true).rows).toBe(0)
  expect(contentGeometry(100, 24, { marginRows: 2 }, true).rows).toBe(2)
})

test("overlay pointer coordinates subtract both edges; margin presses cannot activate widgets", () => {
  const geometry = contentGeometry(100, 30, {}, true)
  expect(contentMouse(press, geometry)).toMatchObject({ x: 0, y: 0 })
  for (const position of [{ x: 2 }, { x: 97 }, { y: 0 }, { y: 29 }])
    expect(contentMouse({ ...press, ...position }, geometry)).toBeUndefined()
  // Releases outside still reach a widget so it can finish an active drag.
  expect(contentMouse({ ...press, action: "release", x: 0 }, geometry)).toMatchObject({ x: -3, y: 0 })
})

test("outer frame clipping keeps an over-wide extension surface out of the right margin", () => {
  const component = { render: () => [`\x1b[48;2;32;32;32m${"x".repeat(100)}\x1b[49m`] }
  const lines = marginView(component, {}, true).render(70, {
    ...plain,
    color: true,
    rows: 30,
  })
  expect(visibleWidth(lines[1]!)).toBe(67)
  expect(lines[1]).toStartWith("   \x1b[48;")
  expect(lines[1]).toEndWith("\x1b[0m")
})

test("clicking a sticky band inside the margin reveals its real user message", () => {
  marginFrame(
    true,
    70,
    30,
    {},
    {
      afterRender(view, screen) {
        // Grow this turn until its real user band is above the viewport.
        view.replyDelta(Array.from({ length: 40 }, (_, i) => `Reply row ${i}`).join("\n\n"))
        view.replyEnd([])
        view.render()
        const stickyY = screen.lines.findIndex((line) => line.includes("Fix add"))
        expect(stickyY).toBe(4)
        expect(screen.lines[stickyY]!.indexOf("›")).toBe(3)
        expect(screen.text).not.toContain("∴ Thought")
        view.handleInput({ ...press, x: 1, y: stickyY })
        view.render()
        expect(screen.lines.findIndex((line) => line.includes("Fix add"))).toBe(stickyY)
        view.handleInput({ ...press, x: 5, y: stickyY })
        view.render()
        expect(screen.lines.findIndex((line) => line.includes("Fix add"))).toBe(4)
        expect(screen.text).toContain("∴ Thought")
        expect(screen.lines.slice(5).join("\n")).toContain("Thought for")
        expect(screen.lines.at(-1)).toBe("")
      },
    },
  )
})

for (const mode of ["fullscreen", "inline"] as const) {
  test(`${mode}: app overlay wheel hit-testing uses content coordinates, not its margin`, async () => {
    let state: UiState | undefined
    const app = await setup([], {
      cols: 70,
      rows: 30,
      settings: { mode, margin: 3, marginRows: 1 },
      extensions: [
        (api) => {
          api.registerView({
            kind: "margin-pointer",
            title: () => "Margin pointer",
            ui: (_data, ctx) => {
              state = ctx.state
              return {
                type: "tree",
                id: "tree",
                items: Array.from({ length: 40 }, (_, i) => ({
                  key: String(i),
                  row: [{ kind: "text", text: `Pick ${i}` }],
                })),
              }
            },
          })
          api.registerCommand({
            name: "margin-pointer",
            description: "Open the pointer fixture",
            run: (_args, ctx) => void ctx.openView?.({ kind: "margin-pointer", data: {} }),
          })
        },
      ],
    })
    try {
      app.terminal.send("/margin-pointer\r")
      await waitFor(() => app.live().includes("Pick 2"), "pointer rows")
      const y = app.screen.lines.findIndex((line) => line.includes("Pick 2"))
      app.terminal.send(`\x1b[<65;2;${y + 1}M`)
      await Bun.sleep(20)
      expect(state?.scroll.tree?.top ?? 0).toBe(0)
      // Physical column 67 is inside the content column only after subtracting its margin.
      app.terminal.send(`\x1b[<65;67;${y + 1}M`)
      await waitFor(() => state?.scroll.tree?.top === 3, "content-relative wheel")
      expect(state?.selected.tree).toBe("0")
    } finally {
      app.terminal.send("\x1b[27u\x03\x03")
      await app.exited
    }
  })

  test(`${mode}: the actual /agents viewer shares the content column`, async () => {
    const app = await setup([], {
      cols: 70,
      rows: 30,
      settings: { mode, margin: 3, marginRows: 1 },
      control: {
        subagents: () => [
          {
            id: "child",
            parentSessionId: "main",
            depth: 1,
            role: "explorer",
            title: "Check files",
            task: "Check files",
            status: "done",
            usage: emptyUsage(),
          },
        ],
        subagentMessages: () => [{ role: "user", content: [{ type: "text", text: "Check files" }] }],
      },
      extensions: [
        (api) => {
          api.registerCommand(agentsCommand())
          api.registerView(subagentView(api))
        },
      ],
    })
    app.host.setSessionControl(app.commands!.control, () => app.agent)
    try {
      app.terminal.send("/agents view child\r")
      await waitFor(() => app.live().includes("Check files") && app.screen.inAltScreen, "agents viewer")
      expect(app.screen.lines[0]).toBe("")
      expect(app.screen.lines.at(-1)).toBe("")
      for (const row of app.screen.lines) {
        if (row) expect(row).toStartWith("   ")
        expect(visibleWidth(row)).toBeLessThanOrEqual(67)
      }
    } finally {
      app.terminal.send("\x1b[27u\x03\x03")
      await app.exited
    }
  })
}
