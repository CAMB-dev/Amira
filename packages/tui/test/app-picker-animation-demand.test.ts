import { expect, jest, test } from "bun:test"
import { emptyUsage, type SubagentInfo } from "@amira/api"
import { agentsCommand } from "../../../extensions/agent/src/agents-command.ts"
import { setup, waitFor } from "./app-harness.ts"

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: /agents sleeps on static states and restarts only for visible working options`, async () => {
    const active = new Set<ReturnType<typeof setInterval>>()
    const schedule = globalThis.setInterval
    const start = jest
      .spyOn(globalThis, "setInterval")
      .mockImplementation((...args: Parameters<typeof setInterval>) => {
        const timer = schedule(...args)
        active.add(timer)
        return timer
      })
    const stop = jest.spyOn(globalThis, "clearInterval")
    const activeCount = () =>
      [...active].filter((timer) => !stop.mock.calls.some(([id]) => id === timer)).length
    const child: SubagentInfo = {
      id: "child",
      parentSessionId: "main",
      depth: 1,
      role: "explorer",
      title: "Selected child",
      task: "task",
      status: "idle",
      usage: emptyUsage(),
    }
    const app = await setup([], {
      cols: 80,
      rows: 32,
      settings: { mode },
      control: { subagents: () => [child] },
      extensions: [
        (api) => {
          api.registerCommand(agentsCommand())
        },
      ],
    })
    app.host.setSessionControl(app.commands!.control, () => app.agent)
    try {
      app.terminal.send("/agents\r")
      await waitFor(() => app.live().includes("idle    Selected child"), "static picker")
      expect(activeCount()).toBe(0)
      for (const state of ["working", "paused", "working", "queued", "idle"] as const) {
        child.status = state === "working" ? "running" : state
        app.bus.emit(
          "subagent.state",
          { childSessionId: child.id, state, turns: 1 },
          { sessionId: app.agent.sessionId },
        )
        await waitFor(() => app.live().includes(`${state.padEnd(7)} Selected child`), state)
        // Working: the spinner cadence and the live clock that keeps its elapsed time ticking.
        expect(activeCount()).toBe(state === "working" ? 2 : 0)
        if (state === "working") {
          const first = app.live()
          await waitFor(() => app.live() !== first, "animated picker frame")
        }
      }
    } finally {
      app.terminal.send("\x1b[27u\x03\x03")
      await app.exited
      start.mockRestore()
      stop.mockRestore()
    }
  })
}
