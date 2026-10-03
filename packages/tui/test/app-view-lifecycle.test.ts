import { expect, test } from "bun:test"
import type { CommandContext, UiContext, UiControl, ViewDefinition } from "@amira/api"
import { setup, waitFor } from "./app-harness.ts"

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: openView seeds initial state before onOpen and preserves same-kind state`, async () => {
    let open!: NonNullable<CommandContext["openView"]>
    let control!: UiControl
    let context!: UiContext
    let initialInput: string | undefined
    const calls: string[] = []
    const definition: ViewDefinition<{ label: string }> = {
      kind: "lifecycle",
      title: () => "Fallback",
      onOpen: (data, view) => {
        calls.push(`open ${data.label}`)
        control = view
        view.setState({ selected: { tree: "b" } })
      },
      onClose: (data) => calls.push(`close ${data.label}`),
      ui: (data, ctx) => {
        if (!context) initialInput = ctx.state.inputValues.input
        context = ctx
        return {
          type: "column",
          children: [
            { size: 1, node: { type: "text", lines: [{ kind: "text", text: data.label }] } },
            {
              node: {
                type: "tree",
                id: "tree",
                items: [
                  { key: "a", row: [{ kind: "text", text: "A" }] },
                  { key: "b", row: [{ kind: "text", text: "B" }] },
                ],
              },
            },
            { size: 1, node: { type: "input", id: "input" } },
          ],
        }
      },
    }
    const s = await setup([], {
      settings: { mode },
      extensions: [
        (api) => {
          api.registerView(definition)
          api.registerCommand({
            name: "lifecycle",
            description: "Lifecycle proof",
            run: (_args, ctx) => {
              open = ctx.openView!
              open({
                kind: "lifecycle",
                data: { label: "First open" },
                state: { inputValues: { input: "seeded" }, focused: "input" },
              })
            },
          })
        },
      ],
    })
    try {
      s.terminal.send("/lifecycle\r")
      await waitFor(() => s.live().includes("seeded"), "initial state rendered")
      expect(initialInput).toBe("seeded")
      expect(context.state.selected.tree).toBe("b")
      expect(context.state.focused).toBe("input")
      const root = context.state
      expect(calls).toEqual(["open First open"])
      s.terminal.send("!")
      await waitFor(() => context.state.inputValues.input === "seeded!", "input edit")
      open({ kind: "lifecycle", data: { label: "Same kind" } })
      await waitFor(() => s.live().includes("Same kind"), "same-kind replacement")
      expect(context.state).toBe(root)
      expect(context.state.inputValues.input).toBe("seeded!")
      expect(calls).toEqual(["open First open"])
      open({
        kind: "lifecycle",
        data: { label: "Reseeded" },
        state: { inputValues: { input: "fresh" }, selected: { tree: "a" } },
      })
      await waitFor(() => s.live().includes("fresh"), "replacement initial state")
      expect(context.state).not.toBe(root)
      expect(context.state.selected.tree).toBe("a")
      expect(calls).toEqual(["open First open"])
      control.pushPage({ title: "Detail" })
      await waitFor(() => s.live().includes("Esc back"), "pushed page")
      s.terminal.send("\x1b[27u")
      await waitFor(() => s.live().includes("Esc close"), "root restored")
      expect(calls).toEqual(["open First open"])
      s.terminal.send("\x03")
      await waitFor(() => calls.length === 2, "close hook")
      expect(calls).toEqual(["open First open", "close Reseeded"])
      control.close()
      expect(calls).toHaveLength(2)
    } finally {
      s.terminal.send("\x03\x03")
      await s.exited
    }
  })

  test(`${mode}: onOpen populates an empty tree before ui reconciles its initial selection`, async () => {
    let context!: UiContext
    const calls: string[] = []
    const definition: ViewDefinition<{ rows: string[] }> = {
      kind: "populated",
      title: () => "Populated tree",
      onOpen: (data) => {
        calls.push("open")
        data.rows.push("a", "b")
      },
      ui: (data, ctx) => {
        calls.push("ui")
        context = ctx
        return {
          type: "tree",
          id: "tree",
          items: data.rows.map((key) => ({ key, row: [{ kind: "text", text: `Row ${key}` }] })),
        }
      },
    }
    const s = await setup([], {
      settings: { mode },
      extensions: [
        (api) => {
          api.registerView(definition)
          api.registerCommand({
            name: "populate",
            description: "Lifecycle proof",
            run: (_args, ctx) => {
              ctx.openView?.({
                kind: "populated",
                data: { rows: [] },
                state: { selected: { tree: "b" } },
              })
            },
          })
        },
      ],
    })
    try {
      s.terminal.send("/populate\r")
      await waitFor(() => s.live().includes("Row b"), "populated rows rendered")
      expect(context.state.selected.tree).toBe("b")
      expect(calls[0]).toBe("open")
      expect(calls.filter((call) => call === "open")).toHaveLength(1)
    } finally {
      s.terminal.send("\x03\x03\x03")
      await s.exited
    }
  })

  test(`${mode}: reentrant same-kind replacement cannot render before onOpen`, async () => {
    let open!: NonNullable<CommandContext["openView"]>
    let context!: UiContext
    const data = { rows: [] as string[] }
    const calls: string[] = []
    const s = await setup([], {
      settings: { mode },
      extensions: [
        (api) => {
          api.registerView({
            kind: "first",
            title: () => "First view",
            render: () => [],
            onClose: () => {
              open({ kind: "replacement", data })
            },
          })
          api.registerView({
            kind: "replacement",
            title: () => "Replacement",
            onOpen: (_data, control) => {
              calls.push("open")
              open({ kind: "replacement", data })
              control.requestRender()
              data.rows.push("a", "b")
            },
            ui: (_data, ctx) => {
              calls.push("ui")
              context = ctx
              return {
                type: "tree",
                id: "tree",
                items: data.rows.map((key) => ({ key, row: [{ kind: "text", text: `Row ${key}` }] })),
              }
            },
          })
          api.registerCommand({
            name: "replace",
            description: "Replacement proof",
            run: (_args, ctx) => {
              open = ctx.openView!
              open({ kind: "first" })
            },
          })
        },
      ],
    })
    try {
      s.terminal.send("/replace\r")
      await waitFor(() => s.live().includes("First view"), "first view")
      open({ kind: "replacement", data, state: { selected: { tree: "b" } } })
      await waitFor(() => s.live().includes("Row b"), "populated replacement")
      expect(calls[0]).toBe("open")
      expect(context.state.selected.tree).toBe("b")
    } finally {
      s.terminal.send("\x03\x03\x03")
      await s.exited
    }
  })

  test(`${mode}: shutdown rejects reopening a view from onClose`, async () => {
    let command!: CommandContext
    let replacement!: UiControl
    let accepted: boolean | undefined
    const calls: string[] = []
    const s = await setup([], {
      settings: { mode },
      extensions: [
        (api) => {
          api.registerView({
            kind: "first",
            title: () => "First view",
            render: () => [],
            onOpen: () => {
              calls.push("open first")
            },
            onClose: () => {
              calls.push("close first")
              accepted = command.openView!({ kind: "replacement" })
            },
          })
          api.registerView({
            kind: "replacement",
            title: () => "Replacement",
            render: () => [],
            onOpen: (_data, control) => {
              calls.push("open replacement")
              replacement = control
            },
            onClose: () => {
              calls.push("close replacement")
            },
          })
          api.registerCommand({
            name: "shutdown",
            description: "Shutdown proof",
            run: (_args, ctx) => {
              command = ctx
              ctx.openView!({ kind: "first" })
            },
          })
        },
      ],
    })
    try {
      s.terminal.send("/shutdown\r")
      await waitFor(() => s.live().includes("First view"), "first view")
      command.quit()
      await s.exited
      expect(accepted).toBe(false)
      expect(calls).toEqual(["open first", "close first"])
    } finally {
      replacement?.close()
      command?.quit()
      await s.exited
    }
  })

  for (const action of ["close", "replace"] as const) {
    test(`${mode}: onClose can open another view during ${action} without losing its lifecycle`, async () => {
      let open!: NonNullable<CommandContext["openView"]>
      let control!: UiControl
      const calls: string[] = []
      const s = await setup([], {
        settings: { mode },
        extensions: [
          (api) => {
            for (const kind of ["first", "nested", "replacement"]) {
              api.registerView({
                kind,
                title: () => `${kind} view`,
                render: () => [],
                onOpen: (_data, view) => {
                  calls.push(`open ${kind}`)
                  if (kind === "first") control = view
                },
                onClose: () => {
                  calls.push(`close ${kind}`)
                  if (kind === "first") open({ kind: "nested", data: {} })
                },
              })
            }
            api.registerCommand({
              name: "reentrant",
              description: "Lifecycle proof",
              run: (_args, ctx) => {
                open = ctx.openView!
                open({ kind: "first", data: {} })
              },
            })
          },
        ],
      })
      try {
        s.terminal.send("/reentrant\r")
        await waitFor(() => s.live().includes("first view"), "first view mounted")
        if (action === "close") control.close()
        else open({ kind: "replacement", data: {} })
        expect(calls).toEqual(["open first", "close first", "open nested"])
        await waitFor(() => s.live().includes("nested view"), "nested view stays open")
        control.close()
        expect(calls).toEqual(["open first", "close first", "open nested"])
        s.terminal.send("\x1b[27u")
        await waitFor(() => s.live().includes("Message Amira"), "nested view closed")
        expect(calls).toEqual(["open first", "close first", "open nested", "close nested"])
        expect(s.screen.inAltScreen).toBe(mode === "fullscreen")
      } finally {
        s.terminal.send("\x03\x03\x03")
        await s.exited
      }
    })
  }

  test(`${mode}: onOpen can close the mounted overlay immediately, including on replacement`, async () => {
    const calls: string[] = []
    let open!: NonNullable<CommandContext["openView"]>
    const s = await setup([], {
      settings: { mode },
      extensions: [
        (api) => {
          api.registerView({
            kind: "stays",
            title: () => "Stays open",
            render: () => [],
            onOpen: () => calls.push("open stays"),
            onClose: () => calls.push("close stays"),
          })
          api.registerView({
            kind: "immediate",
            title: () => "Closes immediately",
            ui: () => {
              calls.push("ui immediate")
              return { type: "text", lines: [] }
            },
            onOpen: (_data, view) => {
              calls.push("open immediate")
              view.setState({ focused: "missing" })
              view.close()
              view.close()
            },
            onClose: () => calls.push("close immediate"),
          })
          api.registerCommand({
            name: "immediate",
            description: "Lifecycle proof",
            run: (_args, ctx) => {
              open = ctx.openView!
              open({ kind: "immediate", data: {} })
            },
          })
        },
      ],
    })
    try {
      s.terminal.send("/immediate\r")
      await waitFor(() => calls.length >= 2, "immediate close")
      expect(calls).toEqual(["open immediate", "close immediate"])
      await waitFor(() => s.live().includes("Message Amira"), "conversation restored")
      open({ kind: "stays", data: {} })
      await waitFor(() => s.live().includes("Stays open"), "replacement source")
      open({ kind: "immediate", data: {} })
      await waitFor(() => s.live().includes("Message Amira"), "replacement closes")
      expect(calls).toEqual([
        "open immediate",
        "close immediate",
        "open stays",
        "close stays",
        "open immediate",
        "close immediate",
      ])
      expect(s.screen.inAltScreen).toBe(mode === "fullscreen")
    } finally {
      s.terminal.send("\x03\x03")
      await s.exited
    }
  })
}

test("legacy subagent requests retain initial widget state when normalized", async () => {
  let data: unknown
  let context!: UiContext
  const s = await setup([], {
    extensions: [
      (api) => {
        api.registerView({
          kind: "subagent",
          title: () => "Legacy request",
          ui: (next, ctx) => {
            data = next
            context = ctx
            return { type: "input", id: "message" }
          },
        })
        api.registerCommand({
          name: "legacy",
          description: "Legacy request proof",
          run: (_args, ctx) => {
            ctx.openView?.({
              kind: "subagent",
              sessionId: "child-1",
              state: { inputValues: { message: "initial message" } },
            })
          },
        })
      },
    ],
  })
  try {
    s.terminal.send("/legacy\r")
    await waitFor(() => s.live().includes("initial message"), "legacy initial state")
    expect(data).toEqual({ sessionId: "child-1" })
    expect(context.state.inputValues.message).toBe("initial message")
  } finally {
    s.terminal.send("\x1b[27u")
    await waitFor(() => !s.screen.inAltScreen, "legacy overlay closed")
    s.terminal.send("\x03")
    await s.exited
  }
})
