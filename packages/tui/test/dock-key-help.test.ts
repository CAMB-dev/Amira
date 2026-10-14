import { expect, test } from "bun:test"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { setup, waitFor } from "./app-harness.ts"

for (const follow of [["ctrl+alt+b"], []]) {
  test(`dock footer uses ${follow.length ? "rebound" : "unbound"} follow keys without a literal End fallback`, async () => {
    const s = await setup([], {
      cols: 120,
      rows: 32,
      settings: { mode: "inline" },
      keybindings: new Keybindings({ ...defaultKeys({ vscode: false }), "scroll.bottom": follow }),
      extensions: [
        (api) => {
          api.registerView({ kind: "dock", title: () => "Key help dock", render: () => [] })
          api.registerCommand({
            name: "dock",
            description: "open dock",
            echo: false,
            run: (_args, ctx) => {
              ctx.openView?.({ kind: "dock", placement: "dock" })
            },
          })
        },
      ],
    })
    try {
      s.terminal.send("/dock\r")
      await waitFor(() => s.live().includes("Key help dock"), "dock footer")
      const footer = s.screen.lines.find((line) => line.includes("Esc close dock"))!
      if (follow.length) expect(footer).toContain("ctrl+alt+b follow")
      else expect(footer).not.toMatch(/\bfollow\b/)
      expect(footer).not.toContain("End follow")
    } finally {
      s.terminal.send("\x03\x03\x03")
      await s.exited
    }
  })
}
