import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AnyEvent, CommandContext } from "@amira/api"
import { Agent, SessionStore } from "@amira/core"
import { setup, waitFor } from "./app-harness.ts"

for (const mode of ["inline", "fullscreen"] as const) {
  for (const printAfterFirstTurn of [false, true]) {
    test(`${mode}: retained printing ${printAfterFirstTurn ? "between" : "before"} resumed turns keeps both turns saved`, async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "amira-display-resume-"))
      const previous = SessionStore.create({ cwd: dir, dir })
      const nextStore = SessionStore.create({ cwd: dir, dir })
      let print!: CommandContext["print"]
      const s = await setup(
        [{ text: "initial answer" }, { text: "first resumed answer" }, { text: "second resumed answer" }],
        {
          cwd: dir,
          session: previous,
          rows: 40,
          settings: { mode },
          prepare: (agent) => agent.prompt("initial question"),
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
        },
      )
      const events: AnyEvent[] = []
      s.bus.subscribe((event) => void events.push(event))
      const replacements: Agent[] = []
      const makeAgent = (session: SessionStore) => {
        const agent = new Agent({
          ai: s.ai,
          model: s.agent.model,
          cwd: dir,
          session,
          bus: s.bus,
          systemPrompt: "",
        })
        replacements.push(agent)
        return agent
      }
      try {
        s.terminal.send("/btw\r")
        await waitFor(() => !!print, "retained printer")
        await s.agent.dispose("switch")
        const next = makeAgent(nextStore)
        s.commands!.switchTo(next)
        await s.bus.flush()
        await next.dispose("switch")
        const resumedStore = SessionStore.open(previous.file)
        const resumed = makeAgent(resumedStore)
        s.commands!.switchTo(resumed)
        await s.bus.flush()
        const latePrint = () =>
          print("btw: retained question", "info", { details: "retained answer", persist: true })
        if (!printAfterFirstTurn) expect(latePrint).not.toThrow()
        s.terminal.send("first resumed question\r")
        await waitFor(() => resumed.status === "idle" && resumed.messages.length === 4, "first resumed turn")
        if (printAfterFirstTurn) expect(latePrint).not.toThrow()
        s.terminal.send("second resumed question\r")
        await waitFor(() => resumed.status === "idle" && resumed.messages.length === 6, "second resumed turn")
        await s.bus.flush()
        expect(
          events.filter((event) => event.type === "extension.error" && event.data.source === "session"),
        ).toEqual([])
        const saved = SessionStore.open(previous.file)
        expect(saved.restore().messages).toEqual(resumed.messages)
        expect(saved.restore().messages).toHaveLength(6)
        expect(saved.branch().filter((entry) => entry.type === "display")).toEqual([
          expect.objectContaining({ text: "btw: retained question", details: "retained answer" }),
        ])
        expect(nextStore.entries.filter((entry) => entry.type === "display")).toEqual([])
        await waitFor(() => s.all().includes("second resumed answer"), "second answer displayed")
        expect(s.all()).not.toContain("could not save the session")
        expect(s.all()).not.toContain("Could not save display output")
        for (const request of s.mock.requests)
          expect(JSON.stringify(request)).not.toContain("retained question")
      } finally {
        s.terminal.send("\x03\x03\x03")
        await s.exited
        for (const agent of replacements) await agent.dispose()
        await s.agent.dispose()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
}
