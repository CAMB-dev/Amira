import { expect, test } from "bun:test"
import { closeImageApp, userTexts, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

for (const mode of ["fullscreen"] as const) {
  for (const placement of ["fullscreen", "dock"] as const) {
    test(`${mode}: arbitrary delayed main ${placement} view cannot attach to owned input`, async () => {
      const gate = Promise.withResolvers<void>()
      let opened: boolean | undefined
      let done = false
      let actions = 0
      const s = await focusFixture(mode, [{ text: "Owned received" }], "/work/design", {
        extensions: [
          (api) => {
            api.registerView({
              kind: "late-main",
              title: () => "MAIN_DELAYED_VIEW",
              render: () => [{ kind: "text", text: "Main view body" }],
              keys: [
                {
                  key: "x",
                  label: "main action",
                  run: () => {
                    actions++
                  },
                },
              ],
            })
            api.registerCommand({
              name: "delayed",
              description: "Open after async work",
              run: async (_args, ctx) => {
                await gate.promise
                opened = ctx.openView?.({ kind: "late-main", placement })
                done = true
              },
            })
          },
        ],
      })
      try {
        s.terminal.send("/delayed\r/design\r")
        await waitFor(() => s.live().includes("main idle"), "owned focus while main command waits")
        s.terminal.send("OWNED_DRAFT")
        await waitFor(() => s.live().includes("│ › OWNED_DRAFT"), "owned draft")
        gate.resolve()
        await waitFor(() => done, "delayed open finished")
        expect(opened).toBe(false)
        expect(s.live()).not.toContain("MAIN_DELAYED_VIEW")
        s.terminal.send("x\r")
        await waitFor(() => userTexts(s.owned).length === 2, "owned input unclaimed by main view")
        expect(actions).toBe(0)
        expect(userTexts(s.owned)).toEqual(["Design history", "OWNED_DRAFTx"])
        expect(userTexts(s.agent)).toEqual(["Main history"])
      } finally {
        gate.resolve()
        s.context()?.unfocusConversation?.()
        await s.conversation.release()
        await closeImageApp(s)
      }
    })
  }
}
