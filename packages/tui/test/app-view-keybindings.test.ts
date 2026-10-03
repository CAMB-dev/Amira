import { expect, test } from "bun:test"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { closeImageApp, setup, waitFor } from "./app-harness.ts"

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: extension overlays receive configured host keys and keep wheel scrolling`, async () => {
    const s = await setup([], {
      settings: { mode },
      rows: 12,
      keybindings: new Keybindings({
        ...defaultKeys({ vscode: false }),
        "view.back": ["ctrl+b"],
        "view.close": ["ctrl+x"],
        "view.scroll-down": [],
        "scroll.page-down": ["ctrl+n"],
      }),
      extensions: [
        (api) => {
          api.registerView({
            kind: "key-test",
            title: () => "Key test",
            follow: false,
            render: () => Array.from({ length: 50 }, (_, i) => ({ kind: "text", text: `row ${i}` })),
          })
          api.registerCommand({
            name: "key-test",
            description: "Open a test view",
            run: (_args, ctx) => void ctx.openView?.({ kind: "key-test", data: {} }),
          })
        },
      ],
    })
    try {
      s.terminal.send("/key-test\r")
      await waitFor(() => s.live().includes("1–9 of 50"), "view at top")
      s.terminal.send("\x1b[27uq")
      await s.idle()
      expect(s.live()).toContain("Key test")
      s.terminal.send("\x0e")
      await waitFor(() => s.live().includes("9–17 of 50"), "configured page key")
      s.terminal.send("\x1b[<65;10;5M")
      await waitFor(() => s.live().includes("12–20 of 50"), "wheel with arrow binding disabled")
      s.terminal.send("\x02")
      await waitFor(() => !s.live().includes("Key test"), "configured back key")
      s.terminal.send("/key-test\r")
      await waitFor(() => s.live().includes("Key test"), "view reopened")
      s.terminal.send("\x18")
      await waitFor(() => !s.live().includes("Key test"), "configured close key")
    } finally {
      s.terminal.send("\x02\x18\x03")
      await closeImageApp(s)
    }
  })
}
