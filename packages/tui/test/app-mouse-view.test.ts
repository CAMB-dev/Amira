import { expect, test } from "bun:test"
import type { UiEvent } from "@amira/api"
import { closeImageApp, setup, waitFor } from "./app-harness.ts"

type App = Awaited<ReturnType<typeof setup>>
function click(s: App, text: string) {
  const y = s.screen.lines.findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = s.screen.lines[y]!.indexOf(text)
  s.terminal.send(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`)
}

test("a dock containing only an input retains mouse focus across fitting redraws", async () => {
  const events: UiEvent[] = []
  const s = await setup([], {
    cols: 90,
    rows: 32,
    settings: { margin: 3, marginRows: 1 },
    extensions: [
      (api) => {
        api.registerView({
          kind: "input-dock",
          title: () => "Input dock",
          ui: () => ({ type: "input", id: "draft", placeholder: "Click this input" }),
          onEvent: (event) => {
            events.push(event)
          },
        })
        api.registerCommand({
          name: "input-dock",
          description: "Open",
          run: (_args, ctx) => {
            ctx.openView?.({ kind: "input-dock", placement: "dock", maxHeight: 8 })
          },
        })
      },
    ],
  })
  try {
    s.terminal.send("/input-dock\r")
    await waitFor(() => s.live().includes("Click this input"), "input dock")
    const row = s.screen.lines.findIndex((line) => line.includes("Click this input"))
    const column = s.screen.lines[row]!.indexOf("Click this input")
    s.terminal.send(
      `\x1b[<0;${column + 1};${row + 1}M\x1b[<0;2;2m\x1b[<0;2;2M\x1b[<0;${column + 1};${row + 1}m`,
    )
    s.terminal.send("stray")
    await waitFor(() => s.live().includes("stray"), "unmatched dock release leaves composer focused")
    expect(events).toEqual([])
    // Ctrl+U belongs to the composer after the unmatched release.
    s.terminal.send("\x15")
    click(s, "Click this input")
    await Bun.sleep(50)
    s.terminal.send("typed\r")
    await waitFor(
      () => events.some((event) => event.type === "submit" && event.value === "typed"),
      "dock input retains focus",
    )
    s.terminal.send("\x1b[27u")
    await waitFor(() => !s.live().includes("Input dock"), "dock closed")
  } finally {
    await closeImageApp(s)
  }
})

test("fullscreen extension composer completion and confirmation accept SGR clicks", async () => {
  const answers: boolean[] = []
  let ran = 0
  const s = await setup([], {
    cols: 100,
    rows: 36,
    settings: { margin: 3, marginRows: 1 },
    extensions: [
      (api) => {
        api.registerView({
          kind: "pointer-view",
          title: () => "Pointer view",
          render: () => [{ kind: "text", text: "View body" }],
          keys: [
            {
              key: "x",
              label: "question",
              run: (_data, view) => {
                void view.confirm("Proceed?", { yes: "proceed", no: "stay" }).then((yes) => answers.push(yes))
              },
            },
          ],
        })
        api.registerCommand({
          name: "pointer-view",
          description: "Open pointer view",
          run: (_args, ctx) => {
            ctx.openView?.({ kind: "pointer-view" })
          },
        })
        api.registerCommand({
          name: "mouse-run",
          description: "Mouse action candidate",
          run: () => {
            ran++
          },
        })
      },
    ],
  })
  try {
    s.terminal.send("/pointer-view\r")
    await waitFor(() => s.live().includes("View body"), "extension view")
    s.terminal.send("x")
    await waitFor(() => s.live().includes("y proceed"), "view confirmation")
    click(s, "View body")
    await Bun.sleep(30)
    expect(answers).toEqual([])
    click(s, "y proceed")
    await waitFor(() => answers.length === 1, "click confirms")
    expect(answers).toEqual([true])
    s.terminal.send("\t/mouse-r")
    await waitFor(() => s.live().includes("Mouse action candidate"), "overlay completion")
    click(s, "Mouse action candidate")
    click(s, "Mouse action candidate")
    await waitFor(() => ran === 1, "overlay completion runs")
    s.terminal.send("\x1b[<2;5;5M")
    await waitFor(() => s.live().includes("Clicks go to Amira here:"), "paste hint over fullscreen view")
  } finally {
    s.terminal.send("\x1b[27u\x1b[27u")
    await closeImageApp(s)
  }
})
