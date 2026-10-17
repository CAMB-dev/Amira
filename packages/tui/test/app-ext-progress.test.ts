import { expect, test } from "bun:test"
import type { ExtensionAdmin } from "@amira/api"
import commandsExtension from "../../../extensions/commands/src/index.ts"
import { closeImageApp, paste, setup, waitFor } from "./app-harness.ts"

test("short fullscreen terminals keep a multiline draft and its caret visible during a turn and command", async () => {
  const turn = Promise.withResolvers<void>()
  const command = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const s = await setup([{ text: "Done", hold: { chunks: 0, until: turn.promise } }], {
    rows: 8,
    settings: { mode: "fullscreen" },
    commands: [
      {
        name: "loading",
        description: "Loading",
        run: async () => {
          started.resolve()
          await command.promise
        },
      },
    ],
  })
  try {
    s.terminal.send("go\r")
    await waitFor(() => s.agent.busy, "turn started")
    s.terminal.send("/loading\r")
    await started.promise
    s.terminal.send(paste("first draft line\nsecond draft line"))
    await waitFor(() => s.live().includes("second draft line"), "multiline draft")
    expect(s.screen.cursorVisible).toBe(true)
    expect(s.screen.lines[s.screen.y]).toContain("second draft line")
    expect(s.live()).not.toContain("/loading…")
  } finally {
    command.resolve()
    turn.resolve()
    await closeImageApp(s)
  }
})

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: command activity describes Esc closing the dock before cancelling work`, async () => {
    const started = Promise.withResolvers<void>()
    let cancelled = false
    const s = await setup([], {
      rows: 32,
      settings: { mode },
      extensions: [
        (api) => {
          api.registerView({ kind: "dock", title: () => "Fixture dock", render: () => [] })
          api.registerCommand({
            name: "dock",
            description: "Dock",
            run: (_args, ctx) => void ctx.openView?.({ kind: "dock", placement: "dock" }),
          })
          api.registerCommand({
            name: "loading",
            description: "Loading",
            run: async (_args, ctx) => {
              started.resolve()
              await new Promise<void>((resolve) => {
                ctx.signal.addEventListener(
                  "abort",
                  () => {
                    cancelled = true
                    ctx.print("cancelled")
                    resolve()
                  },
                  { once: true },
                )
              })
            },
          })
        },
      ],
    })
    try {
      s.terminal.send("/dock\r")
      await waitFor(() => s.live().includes("Fixture dock"), "dock opened")
      s.terminal.send("/loading\r")
      await started.promise
      await waitFor(() => s.live().includes("/loading…"), "command activity")
      expect(
        s
          .live()
          .split("\n")
          .find((row) => row.includes("/loading…")),
      ).toContain("esc close dock")
      s.terminal.send("\x1b[27u")
      await waitFor(() => !s.live().includes("Fixture dock"), "dock closed")
      expect(cancelled).toBe(false)
      expect(
        s
          .live()
          .split("\n")
          .find((row) => row.includes("/loading…")),
      ).toContain("esc stop")
      s.terminal.send("\x1b[27u")
      await waitFor(() => cancelled && !s.live().includes("/loading…"), "command cancelled")
    } finally {
      await closeImageApp(s)
    }
  })
  test(`${mode}: /ext progress animates without new events and commits the outcome once`, async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const admin: ExtensionAdmin = {
      list: () => [],
      search: async () => ({ extensions: [], warnings: [] }),
      install: async (name, _scope, opts) => {
        opts.onProgress({ name, phase: "fetching", percent: 42, detail: "128 KiB" })
        started.resolve()
        await release.promise
        return { name, version: "1.0.0", warnings: [] }
      },
      update: async () => {},
      remove: () => {},
      setEnabled: () => false,
    }
    const s = await setup([], {
      settings: { mode },
      extensions: [commandsExtension],
      control: {
        extensionAdmin: admin,
        info: () => ({
          id: s.agent.sessionId,
          cwd: s.agent.cwd,
          model: { provider: "mock", model: "m1" },
          contextWindow: 128_000,
          busy: false,
          shell: "auto",
        }),
      },
    })
    try {
      s.terminal.send("/ext install fixture\r")
      await started.promise
      await waitFor(() => s.live().includes("fixture · fetching 42%"), "live progress")
      const row = () =>
        s
          .live()
          .split("\n")
          .find((line) => line.includes("fixture · fetching"))
      const before = row()
      await waitFor(() => row() !== before, "progress spinner frame")
      release.resolve()
      await s.shows("Installed fixture 1.0.0")
      await waitFor(() => !s.live().includes("fetching"), "progress cleared")
      expect(s.all().match(/Installed fixture 1\.0\.0/g)).toHaveLength(1)
    } finally {
      release.resolve()
      await closeImageApp(s)
    }
  })
}
