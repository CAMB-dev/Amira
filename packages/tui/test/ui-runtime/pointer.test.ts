import { expect, test } from "bun:test"
import type { ExtensionAPI, UiState, ViewDefinition } from "@amira/api"
import { key, type MouseInput, modes } from "@amira/tui-kit"
import { overlayKeys } from "../../src/app/startup.ts"
import { setup, testCommands, waitFor } from "../app-harness.ts"

const wheel: MouseInput = {
  type: "mouse",
  action: "wheel",
  button: "down",
  x: 60,
  y: 4,
  ctrl: false,
  alt: false,
  shift: false,
}

test("legacy overlays still receive three wheel arrows; declarative routing retains pointer identity", () => {
  expect(overlayKeys(wheel)).toEqual([key("down"), key("down"), key("down")])
  expect(overlayKeys(wheel, true)[0]).toBe(wheel)
  expect(overlayKeys({ ...wheel, action: "press" })).toEqual([])
})

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: SGR wheel scrolls the widget under the pointer, preserves focus, and restores mouse ownership`, async () => {
    let state!: UiState
    let api!: ExtensionAPI
    const data = { label: "Pointer proof" }
    const definition: ViewDefinition<typeof data> = {
      kind: "pointer-proof",
      title: () => "Pointer fallback",
      ui(d, ctx) {
        state = ctx.state
        return {
          type: "column",
          children: [
            { size: 1, node: { type: "bar", left: [{ kind: "text", text: d.label }] } },
            {
              node: {
                type: "row",
                divider: true,
                children: [
                  {
                    node: {
                      type: "tree",
                      id: "tree",
                      items: Array.from({ length: 40 }, (_, i) => ({
                        key: String(i),
                        row: [{ kind: "text", text: `Tree ${i}` }],
                      })),
                    },
                  },
                  {
                    node: {
                      type: "text",
                      id: "log",
                      lines: Array.from({ length: 40 }, (_, i) => ({ kind: "text", text: `Log ${i}` })),
                    },
                  },
                ],
              },
            },
          ],
        }
      },
    }
    const s = await setup([], {
      cols: 80,
      rows: 24,
      settings: { mode },
      commands: testCommands([]),
      extensions: [
        (a) => {
          api = a
          a.registerView(definition)
          a.registerCommand({
            name: "pointer",
            description: "Pointer proof",
            run: (_args, ctx) => {
              ctx.openView?.({ kind: definition.kind, data })
            },
          })
        },
      ],
    })
    try {
      s.terminal.send("/pointer\r")
      await waitFor(() => s.screen.text.includes("Pointer proof"), "declarative overlay")
      expect(s.terminal.output).toContain(modes.mouse.on)
      s.terminal.send("\x1b[<65;61;5M")
      await waitFor(() => state.scroll.log?.top === 3, "wheel routed to log")
      expect(state.focused).toBe("tree")
      expect(state.selected.tree).toBe("0")
      s.terminal.send("\x1b[<65;5;5M")
      await waitFor(() => state.scroll.tree?.top === 3, "wheel scrolls tree without selecting")
      expect(state.selected.tree).toBe("0")
      data.label = "Updated via requestRender"
      api.requestRender()
      await waitFor(() => s.screen.text.includes(data.label), "extension redraw")
      s.terminal.clearWrites()
      s.terminal.send("q")
      await waitFor(() => !s.screen.text.includes("Updated via requestRender"), "view closed")
      if (mode === "inline") expect(s.terminal.output).toContain(modes.mouse.off)
      else expect(s.terminal.output).not.toContain(modes.mouse.off)
    } finally {
      s.terminal.send("\x1b[27u")
      s.terminal.send("\x03\x03")
      await s.exited
    }
  })
}
