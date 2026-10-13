import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandContext } from "@amira/api"
import { Agent, SessionStore } from "@amira/core"
import { setup, waitFor } from "./app-harness.ts"

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: a dock's retained command printer saves into its originating session on switch`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amira-display-switch-"))
    const previous = SessionStore.create({ cwd: dir, dir })
    const nextStore = SessionStore.create({ cwd: dir, dir })
    let print: CommandContext["print"] | undefined
    let closed = false
    const s = await setup([], {
      cwd: dir,
      session: previous,
      rows: 32,
      settings: { mode },
      extensions: [
        (api) => {
          api.registerView({
            kind: "btw",
            title: () => "Old side conversation",
            render: () => [],
            onClose: () => {
              print?.("btw: old question", "info", { details: "old answer", persist: true })
              closed = true
            },
          })
          api.registerCommand({
            name: "btw",
            description: "open side conversation",
            echo: false,
            run: (_args, ctx) => {
              print = ctx.print
              ctx.openView?.({ kind: "btw", placement: "dock" })
            },
          })
        },
      ],
    })
    const next = new Agent({
      ai: s.ai,
      model: s.agent.model,
      cwd: dir,
      session: nextStore,
      bus: s.bus,
      systemPrompt: "",
    })
    try {
      s.terminal.send("/btw\r")
      await waitFor(() => s.live().includes("Old side conversation"), "old dock")
      await s.agent.dispose("switch")
      s.commands!.switchTo(next)
      await s.bus.flush()
      expect(closed).toBe(true)
      expect(nextStore.entries.filter((entry) => entry.type === "display")).toEqual([])
      const saved = SessionStore.open(previous.file).branch()
      expect(saved.find((entry) => entry.type === "display")).toMatchObject({
        text: "btw: old question",
        details: "old answer",
      })
      expect(next.messages).toEqual([])
      await waitFor(() => s.all().includes(next.sessionId), "new session boundary")
      // Inline keeps the old session in scrollback; neither view may print it after the new boundary.
      expect(s.all().slice(s.all().lastIndexOf(next.sessionId))).not.toContain("btw: old question")
    } finally {
      s.terminal.send("\x03\x03\x03")
      await s.exited
      await next.dispose()
      await s.agent.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
