import { expect, test } from "bun:test"
import type { FormValues, UiEvent } from "@amira/api"
import { modes } from "@amira/tui-kit"
import { closeImageApp, exchange, setup, testCommands, waitFor } from "./app-harness.ts"

type App = Awaited<ReturnType<typeof setup>>
const point = (s: App, text: string) => {
  const y = s.screen.lines.findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  return { x: s.screen.lines[y]!.indexOf(text), y }
}
const report = (s: App, x: number, y: number, end = "M", button = 0) =>
  s.terminal.send(`\x1b[<${button};${x + 1};${y + 1}${end}`)
const click = (s: App, text: string) => {
  const { x, y } = point(s, text)
  report(s, x, y)
  report(s, x, y, "m")
}

for (const margin of [0, 3]) {
  test(`SGR picker selects then double-click confirms with margin ${margin}; outside is inert`, async () => {
    const log: string[] = []
    const s = await setup([], {
      commands: testCommands(log),
      history: exchange("transcript-target"),
      cols: 90,
      rows: 32,
      settings: { margin, marginRows: 1 },
    })
    try {
      s.terminal.send("/model\r")
      await waitFor(() => s.live().includes("deepseek/deepseek-pro"), "model picker")
      const wheel = point(s, "deepseek/deepseek-flash")
      report(s, wheel.x, wheel.y, "M", 65)
      await waitFor(
        () => s.screen.lines.some((line) => line.includes("openai/gpt-5") && line.includes("›")),
        "wheel over picker",
      )
      click(s, "deepseek/deepseek-pro")
      await Bun.sleep(50)
      expect(log).toEqual([])
      expect(s.screen.lines.find((line) => line.includes("deepseek/deepseek-pro"))).toContain("›")
      const before = s.terminal.output.length
      click(s, "transcript-target")
      await Bun.sleep(50)
      expect(s.terminal.output.slice(before)).not.toContain("\x1b]52;")
      expect(log).toEqual([])
      click(s, "deepseek/deepseek-pro")
      click(s, "deepseek/deepseek-pro")
      await waitFor(() => log.length === 1, "mouse picker confirmation")
      expect(log).toEqual(["model deepseek/deepseek-pro"])
    } finally {
      s.terminal.send("\x1b[27u")
      await closeImageApp(s)
    }
  })
}

test("SGR completion popup selects and double-click runs rather than selecting the transcript", async () => {
  const s = await setup([], {
    commands: testCommands([]),
    cols: 90,
    rows: 32,
    settings: { margin: 3, marginRows: 1 },
  })
  try {
    s.terminal.send("/")
    await waitFor(() => s.live().includes("Show the status"), "completion popup")
    click(s, "Show the status")
    await Bun.sleep(40)
    expect(s.live()).not.toContain("STATUS OK")
    const target = point(s, "Show the status")
    report(s, target.x, target.y)
    report(s, 1, 1, "m")
    report(s, 1, 1)
    report(s, target.x, target.y, "m")
    await Bun.sleep(30)
    expect(s.live()).not.toContain("STATUS OK")
    click(s, "Show the status")
    click(s, "Show the status")
    await waitFor(() => s.live().includes("STATUS OK"), "completion confirmed")
  } finally {
    await closeImageApp(s)
  }
})

test("SGR input dialog places its caret and submits using its visible footer", async () => {
  let answer: string | undefined
  const s = await setup([], {
    cols: 90,
    rows: 32,
    settings: { margin: 3, marginRows: 1 },
    commands: [
      {
        name: "mouse-input",
        description: "Input",
        async run(_args, ctx) {
          answer = await ctx.ui.input("Mouse input", { initial: "a界b" })
        },
      },
    ],
  })
  try {
    s.terminal.send("/mouse-input\r")
    await waitFor(() => s.live().includes("a界b"), "input dialog")
    click(s, "a界b")
    s.terminal.send("!")
    await waitFor(() => s.live().includes("!a界b"), "clicked input caret")
    click(s, "submit")
    await waitFor(() => answer !== undefined, "input submitted by click")
    expect(answer).toBe("!a界b")
  } finally {
    s.terminal.send("\x1b[27u")
    await closeImageApp(s)
  }
})

test("SGR full-screen form receives content-relative field and Save clicks", async () => {
  let saved: FormValues | undefined
  const s = await setup([], {
    cols: 90,
    rows: 32,
    settings: { margin: 3, marginRows: 1 },
    extensions: [
      (api) => {
        api.registerCommand({
          name: "mouse-form",
          description: "Open a form",
          async run(_args, ctx) {
            saved = await ctx.ui.form({
              title: "Mouse form",
              fields: [
                { id: "first", type: "text", label: "First", default: "one" },
                { id: "second", type: "text", label: "Second", default: "two" },
              ],
            })
          },
        })
      },
    ],
  })
  try {
    s.terminal.send("/mouse-form\r")
    await waitFor(() => s.live().includes("Mouse form"), "form")
    click(s, "Second")
    s.terminal.send("\x1b[F!")
    await waitFor(() => s.live().includes("two!"), "clicked field edited")
    click(s, "Save")
    await waitFor(() => saved !== undefined, "mouse form saved")
    expect(saved).toEqual({ first: "one", second: "two!" })
  } finally {
    s.terminal.send("\x1b[27u")
    await closeImageApp(s)
  }
})

test("a dialog arriving during a transcript drag cancels tracking without copying", async () => {
  let open = async (): Promise<boolean | undefined> => undefined
  const s = await setup([], {
    history: exchange("drag-before-modal"),
    extensions: [
      (api) => {
        open = () => api.ui.confirm("Modal during drag")
      },
    ],
  })
  try {
    const target = point(s, "drag-before-modal")
    const before = s.terminal.output.length
    report(s, target.x, target.y)
    report(s, target.x + 4, target.y, "M", 32)
    expect(s.terminal.output.slice(before)).toContain(modes.mouseDrag.on)
    const answer = open()
    await waitFor(() => s.live().includes("Modal during drag"), "dialog takes drag ownership")
    expect(s.terminal.output.slice(before)).toContain(modes.mouseDrag.off)
    report(s, target.x + 4, target.y, "m")
    await Bun.sleep(30)
    expect(s.terminal.output.slice(before)).not.toContain("\x1b]52;")
    s.terminal.send("\x1b[27u")
    await answer
  } finally {
    s.terminal.send("\x1b[27u")
    await closeImageApp(s)
  }
})

test("SGR dock translation and visible dialog ownership prevent background activation", async () => {
  const events: UiEvent[] = []
  let confirm: boolean | undefined
  const s = await setup([], {
    cols: 90,
    rows: 32,
    settings: { margin: 3, marginRows: 1 },
    extensions: [
      (api) => {
        api.registerView({
          kind: "mouse-dock",
          title: () => "Mouse dock",
          ui: () => ({
            type: "tree",
            id: "tree",
            items: [
              { key: "one", row: [{ kind: "text", text: "Dock first" }] },
              { key: "two", row: [{ kind: "text", text: "Dock second" }] },
            ],
          }),
          onEvent: (event) => {
            events.push(event)
          },
        })
        api.registerCommand({
          name: "mouse-dock",
          description: "Open dock",
          run: (_args, ctx) => {
            ctx.openView?.({ kind: "mouse-dock", placement: "dock", maxHeight: 8 })
          },
        })
        api.registerCommand({
          name: "mouse-confirm",
          description: "Ask",
          async run(_args, ctx) {
            confirm = await ctx.ui.confirm("Mouse ownership")
          },
        })
      },
    ],
  })
  try {
    s.terminal.send("/mouse-dock\r")
    await waitFor(() => s.live().includes("Dock second"), "mouse dock")
    click(s, "Dock second")
    await waitFor(() => events.some((e) => e.type === "select" && e.key === "two"), "dock selection")
    s.terminal.send("\t/mouse-confirm\r")
    await waitFor(() => s.live().includes("Mouse ownership"), "dialog over dock")
    const count = events.length
    click(s, "Dock first")
    await Bun.sleep(40)
    expect(events).toHaveLength(count)
    expect(confirm).toBeUndefined()
    s.terminal.send("\x1b[27u")
    await waitFor(() => !s.live().includes("Mouse ownership"), "dialog cancelled with keyboard")
    s.terminal.send("\x1b[27u\x1b[27u")
    await waitFor(() => !s.live().includes("Dock second"), "dock closed")
    for (const button of [1, 2]) {
      report(s, 5, 2, "M", button)
      await waitFor(() => s.live().includes("Clicks go to Amira here"), "unchanged paste hint")
    }
  } finally {
    s.terminal.send("\x1b[27u")
    await closeImageApp(s)
  }
})
