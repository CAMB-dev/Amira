import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandContext } from "@amira/api"
import { Agent, SessionStore } from "@amira/core"
import { setup, waitFor } from "./app-harness.ts"

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: a deleted-session printer shows a warning in the current view without leaking its answer`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amira-deleted-display-tui-"))
    const previous = SessionStore.create({ cwd: dir, dir })
    previous.append({ type: "display", text: "previous session", level: "info" })
    const nextStore = SessionStore.create({ cwd: dir, dir })
    let print!: CommandContext["print"]
    const s = await setup([], {
      cwd: dir,
      session: previous,
      rows: 40,
      settings: { mode },
      commands: [
        {
          name: "btw",
          description: "retain printer",
          echo: false,
          run: (_args, ctx) => {
            print = ctx.print
          },
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
      await waitFor(() => !!print, "retained printer")
      await s.agent.dispose("switch")
      s.commands!.switchTo(next)
      await s.bus.flush()
      rmSync(previous.file)
      expect(() =>
        print("private late answer", "info", { details: "secret details", persist: true }),
      ).not.toThrow()
      await waitFor(() => s.live().includes("Could not save display output"), "deleted-session warning")
      expect(s.live()).not.toContain("private late answer")
      expect(s.live()).not.toContain("secret details")
      expect(nextStore.entries.filter((entry) => entry.type === "display")).toEqual([])
      expect(existsSync(previous.file)).toBe(false)
    } finally {
      s.terminal.send("\x03\x03\x03")
      await s.exited
      await next.dispose()
      await s.agent.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
