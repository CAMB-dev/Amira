import { expect, test } from "bun:test"
import type { UiContext, ViewDefinition } from "@amira/api"
import { CURSOR_MARKER, defaultTheme, Editor } from "@amira/tui-kit"
import { InputBox } from "../src/input-box.ts"
import { closeImageApp, setup, waitFor } from "./app-harness.ts"

test("composer focus uses accent beside a view, muted when inactive, and restores the usual border", () => {
  const editor = new Editor()
  const box = new InputBox(editor)
  const ctx = { theme: defaultTheme, color: true, rows: 24 }
  const edge = `╭${"─".repeat(58)}╮`
  box.accentFocus = true
  expect(box.render(60, ctx)[0]).toBe(defaultTheme.accent(edge))
  expect(box.render(60, ctx).join("\n")).toContain(CURSOR_MARKER)
  editor.focused = false
  expect(box.render(60, ctx)[0]).toBe(defaultTheme.muted(edge))
  expect(box.render(60, ctx).join("\n")).not.toContain(CURSOR_MARKER)
  editor.focused = true
  box.accentFocus = false
  expect(box.render(60, ctx)[0]).toBe(defaultTheme.borderFocused(edge))
})

for (const mode of ["inline", "fullscreen"] as const) {
  for (const declarative of [false, true]) {
    test(`${mode}: ${declarative ? "widget" : "line"} view and composer focus round-trip`, async () => {
      let focused = true
      let actions = 0
      let selected: string | undefined
      const definition: ViewDefinition = {
        kind: "focus-test",
        title: () => "Focus test",
        follow: false,
        keys: [{ key: "m", label: "message", run: () => actions++ }],
        onEvent: (event) => {
          if (event.type === "key" && event.key === "m") actions++
        },
        ...(declarative
          ? {
              ui: (_data: unknown, ctx: UiContext) => {
                focused = ctx.focused !== false
                selected = ctx.state.selected.tasks
                return {
                  type: "column" as const,
                  children: [
                    {
                      size: 1,
                      node: { type: "bar" as const, left: [{ kind: "text" as const, text: "Focus test" }] },
                    },
                    {
                      node: {
                        type: "tree" as const,
                        id: "tasks",
                        items: ["One", "Two"].map((text) => ({
                          key: text,
                          row: [{ kind: "text" as const, text }],
                        })),
                      },
                    },
                  ],
                }
              },
            }
          : {
              render: (_data: unknown, opts: { focused?: boolean }) => {
                focused = opts.focused !== false
                return [{ kind: "text" as const, text: "Selected row" }]
              },
            }),
      }
      const s = await setup([], {
        settings: { mode },
        extensions: [
          (api) => {
            api.registerView(definition)
            api.registerCommand({
              name: "focus-test",
              description: "Open a test view",
              run: (_args, ctx) => void ctx.openView?.({ kind: "focus-test" }),
            })
          },
        ],
      })
      const hint = (text: string) => waitFor(() => s.live().includes(text), text)
      try {
        s.terminal.send("/focus-test\r")
        await hint("tab → input")
        expect(focused).toBe(true)
        s.terminal.send("m")
        await waitFor(() => actions === 1, "view shortcut")
        if (declarative) {
          s.terminal.send("\x1b[B")
          await waitFor(() => selected === "Two", "selection moved")
        }
        s.terminal.send("\t")
        await hint("tab → view")
        expect(focused).toBe(false)
        s.terminal.send("\t")
        await hint("tab → input")
        expect(focused).toBe(true)
        if (declarative) expect(selected).toBe("Two")

        // i is a focus shortcut, not text. Empty-input Esc returns, without closing the view.
        s.terminal.send("i")
        await hint("esc → view")
        expect(s.live()).toContain("Message Amira")
        s.terminal.send("\x1b[27u")
        await hint("tab → input")
        expect(s.live()).toContain("Focus test")

        // Slash both focuses and starts a command; Tab wins even over a completion popup.
        s.terminal.send("/")
        await waitFor(() => s.live().includes("│ › /"), "slash in composer")
        s.terminal.send("\t")
        await hint("tab → input")
        s.terminal.send("\t\x15")
        await hint("esc → view")
        s.terminal.send("\t")
        await hint("tab → input")

        // Unhandled printable keys go through the real editor. Esc keeps the draft intact.
        s.terminal.send("z")
        await waitFor(() => s.live().includes("│ › z"), "printable in composer")
        expect(focused).toBe(false)
        expect(s.screen.lines.at(-1)).not.toContain("esc → view")
        s.terminal.send("\x1b[27u")
        await s.idle()
        expect(s.live()).toContain("│ › z")
        expect(focused).toBe(false)
        s.terminal.send("\t")
        await hint("tab → input")
        s.terminal.send("\t")
        await hint("tab → view")
        expect(s.live()).toContain("│ › z")
        s.terminal.send("\x15\t")
        await hint("tab → input")

        // Pointer coordinates hit the input below the view, rather than its selected row.
        const inputRow = s.screen.lines.findIndex((line) => line.includes("Message Amira"))
        expect(inputRow).toBeGreaterThan(0)
        s.terminal.send(`\x1b[<0;5;${inputRow + 1}M\x1b[<0;5;${inputRow + 1}m`)
        await hint("tab → view")
        expect(focused).toBe(false)
        s.terminal.send("\x1b[27u")
        await hint("tab → input")
        s.terminal.send("\x1b[27u")
        await waitFor(() => !s.live().includes("Focus test"), "Esc closes view")
      } finally {
        s.terminal.send("\x03")
        await closeImageApp(s)
      }
    })
  }

  test(`${mode}: hidden dialogs do not receive visible composer input`, async () => {
    let ask!: () => void
    let answered = false
    const s = await setup([], {
      settings: { mode },
      extensions: [
        (api) => {
          ask = () => {
            void api.ui.confirm("Hidden confirmation", "Proceed?").then(() => {
              answered = true
            })
          }
          api.registerView({ kind: "hidden-dialog", title: () => "Hidden dialog view", render: () => [] })
          api.registerCommand({
            name: "hidden-dialog",
            description: "Open",
            run: (_args, ctx) => void ctx.openView?.({ kind: "hidden-dialog" }),
          })
        },
      ],
    })
    try {
      s.terminal.send("/hidden-dialog\r")
      await waitFor(() => s.live().includes("tab → input"), "view opened")
      ask()
      await waitFor(() => s.host.ui.pending.length === 1, "confirmation waiting behind view")
      s.terminal.send("\tn")
      await waitFor(() => s.live().includes("│ › n"), "visible composer receives n")
      expect(answered).toBe(false)
      expect(s.host.ui.pending).toHaveLength(1)
      s.terminal.send("\x15\t\x03")
      await waitFor(
        () => s.live().includes("Hidden confirmation"),
        "pending confirmation visible after close",
      )
      s.terminal.send("\x1b[27u")
      await waitFor(() => answered, "visible confirmation cancelled")
    } finally {
      s.terminal.send("\x03")
      await closeImageApp(s)
    }
  })

  test(`${mode}: a dock losing its selectable content restores composer focus`, async () => {
    let context!: UiContext
    let refresh!: () => void
    const items = [{ key: "one", row: [{ kind: "text" as const, text: "Selectable row" }] }]
    const s = await setup([], {
      settings: { mode },
      extensions: [
        (api) => {
          refresh = () => api.requestRender()
          api.registerView({
            kind: "changing-dock",
            title: () => "Changing dock",
            ui: (_data, ctx) => {
              context = ctx
              return { type: "tree", id: "tasks", items }
            },
          })
          api.registerCommand({
            name: "changing-dock",
            description: "Open",
            run: (_args, ctx) => void ctx.openView?.({ kind: "changing-dock", placement: "dock" }),
          })
        },
      ],
    })
    try {
      s.terminal.send("/changing-dock\r")
      await waitFor(() => s.live().includes("Selectable row"), "dock opened")
      s.terminal.send("\t")
      await waitFor(() => context.focused === true, "dock focused")
      items.length = 0
      refresh()
      await waitFor(() => context.focused === false, "composer focus restored")
      s.terminal.send("z")
      await waitFor(() => s.live().includes("│ › z"), "caret and editor active")
      s.terminal.send("\x1b[27u")
      await waitFor(() => !s.live().includes("Esc close dock"), "empty dock closes")
      expect(s.live()).toContain("│ › z")
    } finally {
      s.terminal.send("\x03")
      await closeImageApp(s)
    }
  })

  test(`${mode}: view-local editors and prompts retain printable keys across host focus changes`, async () => {
    let context!: UiContext
    let answer: Promise<string | undefined> | undefined
    const s = await setup([], {
      settings: { mode },
      extensions: [
        (api) => {
          api.registerView({
            kind: "local-input",
            title: () => "Local input",
            needsTab: true,
            keys: [{ key: "p", label: "prompt" }],
            ui: (_data, ctx) => {
              context = ctx
              return {
                type: "column",
                children: [
                  {
                    node: {
                      type: "tree",
                      id: "tasks",
                      items: [{ key: "one", row: [{ kind: "text", text: "One" }] }],
                    },
                  },
                  { size: 1, node: { type: "input", id: "local", activate: "/" } },
                ],
              }
            },
            onEvent: (event, _data, view) => {
              if (event.type === "key" && event.key === "p") answer = view.prompt("View prompt")
            },
          })
          api.registerCommand({
            name: "local-input",
            description: "Open",
            run: (_args, ctx) => void ctx.openView?.({ kind: "local-input", state: { focused: "local" } }),
          })
        },
      ],
    })
    try {
      s.terminal.send("/local-input\r")
      await waitFor(() => !!context, "local editor")
      s.terminal.send("/iq")
      await waitFor(() => context.state.inputValues.local === "/iq", "view editor owns printable keys")
      expect(context.focused).toBe(true)
      s.terminal.send("\x1b[9;5u")
      await waitFor(() => context.focused === false, "composer focus")
      s.terminal.send("\x1b[9;5u\x1b[27up")
      await waitFor(() => !!answer, "view prompt opened")
      s.terminal.send("/i")
      s.terminal.send("\x1b[9;5u")
      await waitFor(() => context.focused === false, "prompt inactive")
      s.terminal.send("\x1b[9;5u\r")
      expect(await answer).toBe("/i")
    } finally {
      s.terminal.send("\x03")
      await closeImageApp(s)
    }
  })

  for (const selectable of [false, true]) {
    test(`${mode}: dock ${selectable ? "selection takes focus" : "without selection leaves Tab alone"}`, async () => {
      let context!: UiContext
      const s = await setup([], {
        rows: 24,
        settings: { mode, margin: 3, marginRows: 1 },
        extensions: [
          (api) => {
            api.registerView({
              kind: "dock-focus",
              title: () => "Dock focus",
              ui: (_data, ctx) => {
                context = ctx
                return selectable
                  ? {
                      type: "tree",
                      id: "tasks",
                      items: ["One", "Two"].map((text) => ({ key: text, row: [{ kind: "text", text }] })),
                    }
                  : { type: "text", lines: [{ kind: "text", text: "Read-only dock" }] }
              },
            })
            api.registerCommand({
              name: "dock-focus",
              description: "Open",
              run: (_args, ctx) => void ctx.openView?.({ kind: "dock-focus", placement: "dock" }),
            })
          },
        ],
      })
      try {
        s.terminal.send("/dock-focus\r")
        await waitFor(() => !!context, "dock rendered")
        expect(context.focused).toBe(false)
        s.terminal.send("draft\t")
        if (selectable) {
          await waitFor(() => context.focused === true, "dock focused")
          expect(s.live()).toContain("tab → input")
          s.terminal.send("\x1b[B")
          await waitFor(() => context.state.selected.tasks === "Two", "dock selection")
          expect(s.live()).toContain("draft")
          s.terminal.send("\t")
          await waitFor(() => context.focused === false, "composer focused")
          expect(s.live()).toContain("tab → view")
          s.terminal.send("\t")
          await waitFor(() => context.focused === true, "dock refocused")
          const inputRow = s.screen.lines.findIndex((line) => line.includes("draft"))
          s.terminal.send(`\x1b[<0;8;${inputRow + 1}M`)
          await waitFor(() => context.focused === false, "dock input click")
          expect(context.state.selected.tasks).toBe("Two")
        } else {
          await s.idle()
          expect(context.focused).toBe(false)
          expect(s.live()).not.toContain("tab → view")
        }
        s.terminal.send("z")
        await waitFor(() => s.live().includes("draftz"), "dock composer draft retained")
        s.terminal.send("\x1b[27u")
        await waitFor(
          () => !s.live().includes(selectable ? "Two" : "Read-only dock"),
          "dock closed from input",
        )
        expect(s.live()).toContain("draftz")
      } finally {
        s.terminal.send("\x03")
        await closeImageApp(s)
      }
    })
  }

  test(`${mode}: views explicitly needing Tab keep it and Shift+Tab; Ctrl+Tab switches host focus`, async () => {
    let switches = 0
    const s = await setup([], {
      settings: { mode },
      extensions: [
        (api) => {
          api.registerView({
            kind: "tab-test",
            title: () => "Tab test",
            needsTab: true,
            keys: [
              { key: "tab", label: "next", run: () => switches++ },
              { key: "shift-tab", label: "previous", run: () => switches-- },
            ],
            render: () => [{ kind: "text", text: "Body" }],
          })
          api.registerCommand({
            name: "tab-test",
            description: "Open",
            run: (_args, ctx) => void ctx.openView?.({ kind: "tab-test" }),
          })
        },
      ],
    })
    try {
      s.terminal.send("/tab-test\r")
      await waitFor(() => s.live().includes("f6 → input"), "fallback hint")
      s.terminal.send("\t")
      await waitFor(() => switches === 1, "view Tab")
      s.terminal.send("\x1b[Z")
      await waitFor(() => switches === 0, "view Shift+Tab")
      s.terminal.send("\x1b[9;5u")
      await waitFor(() => s.live().includes("f6 → view"), "focus input")
      s.terminal.send("\x1b[9;5u")
      await waitFor(() => s.live().includes("f6 → input"), "focus view")
    } finally {
      s.terminal.send("\x03")
      await closeImageApp(s)
    }
  })
}
