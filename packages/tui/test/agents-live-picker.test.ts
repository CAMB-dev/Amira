import { expect, test } from "bun:test"
import { emptyUsage, type SubagentInfo } from "@amira/api"
import { agentsCommand } from "../../../extensions/agent/src/agents-command.ts"
import { subagentView } from "../../../extensions/agent/src/subagent-view.ts"
import { setup, waitFor } from "./app-harness.ts"

for (const mode of ["inline", "fullscreen"] as const) {
  test(`${mode}: an open agents picker updates statuses without reopening or losing selection`, async () => {
    const agents: SubagentInfo[] = ["First child", "Selected child", "Failed child", "Stopped child"].map(
      (title, index) => ({
        id: `child-${index}`,
        parentSessionId: "main",
        depth: 1,
        role: "explorer",
        title,
        task: title,
        status: "running",
        usage: emptyUsage(),
      }),
    )
    const app = await setup([], {
      cols: 80,
      rows: 32,
      settings: { mode },
      control: { subagents: () => agents, subagentMessages: () => [] },
      extensions: [
        (api) => {
          api.registerCommand(agentsCommand())
          api.registerView(subagentView(api))
        },
      ],
    })
    app.host.setSessionControl(app.commands!.control, () => app.agent)
    const waiting: string[] = []
    const off = app.bus.subscribe((event) => {
      if (event.type === "ui.waiting") waiting.push(event.data.change)
    })
    try {
      app.terminal.send("/agents\r")
      await waitFor(() => app.live().includes("working Selected child"), "initial agents picker")
      app.terminal.send("\x1b[B")
      const requestId = app.host.ui.pending[0]!.requestId
      const selected = agents[1]!
      for (const state of ["paused", "idle", "queued", "working"] as const) {
        selected.status = state === "working" ? "running" : state
        app.bus.emit(
          "subagent.state",
          { childSessionId: selected.id, state, turns: 1 },
          { sessionId: app.agent.sessionId },
        )
        await waitFor(() => app.live().includes(`${state.padEnd(7)} Selected child`), `picker ${state}`)
        expect(app.host.ui.pending.map((request) => request.requestId)).toEqual([requestId])
      }
      for (const [index, status, word] of [
        [1, "done", "done"],
        [2, "error", "failed"],
        [3, "aborted", "stopped"],
      ] as const) {
        const child = agents[index]!
        child.status = status
        app.bus.emit(
          "subagent.end",
          { childSessionId: child.id, status, usage: emptyUsage(), durationMs: 1000 },
          { sessionId: app.agent.sessionId },
        )
        await waitFor(() => app.live().includes(`${word.padEnd(7)} ${child.title}`), `picker ${word}`)
      }
      expect(waiting.filter((change) => change === "opened")).toHaveLength(1)
      app.terminal.send("\r")
      await waitFor(
        () => app.screen.inAltScreen && app.screen.lines[0]!.includes("done Selected child"),
        "selected child details",
      )
      expect(app.host.ui.pending).toHaveLength(0)
    } finally {
      off()
      app.terminal.send("\x1b[27u\x03\x03")
      await app.exited
    }
  })
}
