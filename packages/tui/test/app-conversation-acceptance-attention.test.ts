import { expect, test } from "bun:test"
import type { UiTreeItem } from "@amira/api"
import { closeImageApp, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

const F6 = "\x1b[17~"

for (const mode of ["inline", "fullscreen"] as const) {
  for (const mainWorking of [false, true]) {
    for (const key of ["\x1b", "\x03"]) {
      test(`${mode}: owned approval cancellation targets owned only, main working=${mainWorking}, key=${JSON.stringify(key)}`, async () => {
        const s = await focusFixture(mode, [
          ...(mainWorking ? [{ text: "Slow main", delayMs: 500 }] : []),
          { text: "Slow owned", delayMs: 500 },
        ])
        let mainAborts = 0
        const abort = s.agent.abort.bind(s.agent)
        s.agent.abort = () => {
          mainAborts++
          abort()
        }
        try {
          if (mainWorking) {
            s.terminal.send("Working main\r")
            await waitFor(() => s.agent.status !== "idle", "main working")
          }
          s.terminal.send("/design\r")
          await waitFor(() => s.live().includes("Design · fixture"), "owned focus")
          s.terminal.send("Working owned\r")
          await waitFor(() => s.owned.status !== "idle", "owned working")
          const answer = s.host.ui.ask(
            { kind: "confirm", title: "Owned approval" },
            {
              source: "approval",
              sessionId: s.conversation.id,
            },
          )
          await s.shows("Owned approval")
          s.terminal.send(key)
          expect(await answer).toBeUndefined()
          await s.bus.flush()
          await Bun.sleep(20)
          expect(mainAborts).toBe(0)
          expect(s.stops()).toBe(1)
          expect(s.agent.status === "idle").toBe(!mainWorking)
          await waitFor(() => s.owned.status === "idle", "owned stopped")
        } finally {
          abort()
          s.owned.abort()
          s.host.ui.cancelAll()
          s.context()?.unfocusConversation?.()
          await s.conversation.release()
          await closeImageApp(s)
        }
      })
    }
  }

  for (const overlay of ["form", "keys", "view"] as const) {
    test(`${mode}: main attention stays visible over owned ${overlay} and survives resize`, async () => {
      let viewFocused = true
      const s = await focusFixture(mode, [], "/work/design", {
        extensions: [
          (api) =>
            void api.registerView({
              kind: "attention-pointer",
              title: () => "Owned pointer view",
              ui: (_data, ctx) => {
                viewFocused = ctx.focused !== false
                return {
                  type: "column",
                  children: [
                    { size: 1, node: { type: "bar", left: [{ kind: "text", text: "Owned pointer view" }] } },
                    {
                      node: {
                        type: "tree",
                        id: "tasks",
                        items: ["One", "Two"].map<UiTreeItem>((key) => ({
                          key,
                          row: [{ kind: "text", text: `Pointer ${key}` }],
                        })),
                      },
                    },
                  ],
                }
              },
            }),
        ],
      })
      try {
        s.terminal.send("/design\r")
        await waitFor(() => s.live().includes("Design · fixture"), "focus")
        if (overlay === "form") {
          void s.host.ui.api("test-owned").form(
            {
              title: "Owned attention form",
              fields: [{ type: "text", id: "name", label: "Name" }],
            },
            { sessionId: s.conversation.id },
          )
          await s.shows("Owned attention form")
          s.terminal.send("Form draft")
          await s.shows("Form draft")
          expect(s.screen.lines[s.screen.y]).toContain("Form draft")
        } else if (overlay === "keys") {
          s.terminal.send("?")
          await s.shows("Keys")
        } else {
          expect((await s.viewContext()).openView?.({ kind: "attention-pointer" })).toBe(true)
          await s.shows("Owned pointer view")
        }
        const answer = s.host.ui.ask(
          { kind: "confirm", title: "Main needs approval" },
          { source: "approval" },
        )
        await s.bus.flush()
        await waitFor(() => s.live().includes("1 pending"), "overlay attention")
        expect(s.live()).toContain("1 pending")
        expect(s.live()).toContain("f6 to answer")
        expect(s.live()).not.toContain("Main needs approval")
        for (const [cols, rows] of [
          [120, 36],
          [60, 24],
        ]) {
          // Old text can survive resize; wait for the new frame's caret and hit map.
          const writes = s.terminal.writes.length
          s.screen.resize(cols!, rows!)
          s.terminal.setSize(cols!, rows!)
          await waitFor(
            () =>
              s.terminal.writes.length > writes &&
              s.live().includes("1 pending") &&
              s.live().includes("f6 to answer") &&
              (overlay !== "form" || s.screen.lines[s.screen.y]?.includes("Form draft") === true),
            "resized attention overlay and form caret",
          )
          expect(s.live()).toContain("1 pending")
          expect(s.live()).toContain("f6 to answer")
          if (overlay === "form") expect(s.screen.lines[s.screen.y]).toContain("Form draft")
          if (overlay === "view") {
            const row = s.screen.lines.findIndex((line) => line.includes("│ › "))
            expect(row).toBeGreaterThanOrEqual(0)
            s.terminal.send(`\x1b[<0;5;${row + 1}M\x1b[<0;5;${row + 1}m`)
            await waitFor(() => !viewFocused, "pointer hits visible composer")
            s.terminal.send("Pointer draft")
            await waitFor(
              () => s.screen.lines[s.screen.y]?.includes("Pointer draft") === true,
              "caret stays in composer",
            )
            s.terminal.send(`\x1b[<0;5;${rows}M\x1b[<0;5;${rows}m`)
            await Bun.sleep(20)
            expect(viewFocused).toBe(false)
            expect(s.screen.lines[s.screen.y]).toContain("Pointer draft")
            expect(s.live()).toContain("1 pending")
            s.terminal.send("\x1b[<0;5;2M\x1b[<0;5;2m")
            await waitFor(() => viewFocused, "body pointer restores view focus")
          }
        }
        s.terminal.send(F6)
        await s.shows("Main needs approval")
        s.terminal.send("\x1b")
        expect(await answer).toBeUndefined()
      } finally {
        s.host.ui.cancelAll()
        s.context()?.unfocusConversation?.()
        await s.conversation.release()
        await closeImageApp(s)
      }
    })
  }
}
