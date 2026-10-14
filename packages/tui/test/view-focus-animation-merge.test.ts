import { expect, test } from "bun:test"
import type { ViewDefinition } from "@amira/api"
import { closeImageApp, setup, waitFor } from "./app-harness.ts"

for (const mode of ["inline", "fullscreen"] as const) {
  for (const widgets of [false, true]) {
    test(`${mode}: ${widgets ? "widget" : "line"} fullscreen demand survives composer focus and then settles`, async () => {
      let focused = true
      let timed = true
      let draws = 0
      let requestRender = () => {}
      const definition: ViewDefinition = {
        kind: "merge-focus-clock",
        title: () => "Merge focus clock",
        keys: [{ key: "m", label: "action", run: () => {} }],
        ...(widgets
          ? {
              ui: (_data, ctx) => {
                focused = ctx.focused !== false
                draws++
                if (timed) ctx.requestRefresh?.(80)
                return {
                  type: "tree" as const,
                  id: "tasks",
                  items: [{ key: "body", row: [{ kind: "text" as const, text: "Visible clock body" }] }],
                }
              },
            }
          : {
              render: (_data, opts) => {
                focused = opts.focused !== false
                draws++
                if (timed) opts.requestRefresh?.(80)
                return [{ kind: "text" as const, text: "Visible clock body" }]
              },
            }),
      }
      const app = await setup([], {
        rows: 32,
        settings: { mode },
        extensions: [
          (api) => {
            requestRender = () => api.requestRender()
            api.registerView(definition)
            api.registerCommand({
              name: "merge-focus-clock",
              description: "Open merge regression fixture",
              run: (_args, ctx) => {
                ctx.openView?.({ kind: definition.kind })
              },
            })
          },
        ],
      })
      try {
        app.terminal.send("/merge-focus-clock\r")
        await waitFor(() => app.live().includes("Visible clock body"), "view body")
        expect(focused).toBe(true)
        const bodyRow = app.screen.lines.findIndex((row) => row.includes("Visible clock body"))
        const inputRow = app.screen.lines.findIndex((row) => row.includes("Message Amira"))
        expect(inputRow).toBeGreaterThan(bodyRow)
        app.terminal.send("\t")
        await waitFor(() => !focused, "composer focus")
        const active = draws
        await Bun.sleep(180)
        expect(draws).toBeGreaterThan(active)
        timed = false
        requestRender()
        await Bun.sleep(120)
        const settled = draws
        await Bun.sleep(180)
        expect(draws).toBe(settled)
        app.terminal.send("\x1b[17~")
        await waitFor(() => focused, "F6 returns view focus")
        await Bun.sleep(100)
        const refocused = draws
        await Bun.sleep(180)
        expect(draws).toBe(refocused)
      } finally {
        await closeImageApp(app)
      }
    })
  }

  test(`${mode}: a focused animated dock sleeps at final zero height and resumes without stealing input`, async () => {
    let focused = false
    let state: "working" | "done" = "working"
    let draws = 0
    let requestRender = () => {}
    const app = await setup([], {
      rows: 32,
      settings: { mode },
      extensions: [
        (api) => {
          requestRender = () => api.requestRender()
          api.registerView({
            kind: "merge-dock-clock",
            title: () => "Merge dock clock",
            ui: (_data, ctx) => {
              focused = ctx.focused !== false
              draws++
              return {
                type: "tree",
                id: "tasks",
                items: [
                  { key: "task", row: [...ctx.statusBadge!(state), { kind: "text", text: " Dock task" }] },
                ],
              }
            },
          })
          api.registerCommand({
            name: "merge-dock-clock",
            description: "Open merge dock regression fixture",
            run: (_args, ctx) => {
              ctx.openView?.({ kind: "merge-dock-clock", placement: "dock", maxHeight: 8 })
            },
          })
        },
      ],
    })
    try {
      app.terminal.send("/merge-dock-clock\r")
      await waitFor(() => app.live().includes("Dock task"), "dock visible")
      expect(focused).toBe(false)
      app.terminal.send("\t")
      await waitFor(() => focused, "dock focus")
      const active = draws
      await Bun.sleep(180)
      expect(draws).toBeGreaterThan(active)
      expect(focused).toBe(true)
      app.screen.resize(60, 5)
      app.terminal.setSize(60, 5)
      await Bun.sleep(120)
      const hidden = draws
      await Bun.sleep(180)
      expect(draws).toBe(hidden)
      app.terminal.send("draft")
      await waitFor(() => app.live().includes("draft"), "composer receives typing")
      app.screen.resize(60, 32)
      app.terminal.setSize(60, 32)
      await waitFor(() => app.live().includes("Dock task"), "dock restored")
      expect(focused).toBe(false)
      const restored = draws
      await Bun.sleep(180)
      expect(draws).toBeGreaterThan(restored)
      state = "done"
      requestRender()
      await Bun.sleep(120)
      const done = draws
      await Bun.sleep(180)
      expect(draws).toBe(done)
    } finally {
      await closeImageApp(app)
    }
  })
}
