import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { Agent, StatusRegistry, UiRequests } from "@amira/core"
import { FakeTerminal } from "@amira/tui-kit"
import { runInteractive } from "../src/app.ts"
import { fileList } from "../src/file-index.ts"
import { noProbe } from "./app-harness.ts"

for (const replacementTurn of [false, true]) {
  test(`an approval predating attachment stops only its owner (replacement: ${replacementTurn})`, async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const ai = createAi({
      dialects: [
        createMockDialect([
          { text: "first", hold: { chunks: 0, until: first.promise } },
          { text: "second", hold: { chunks: 0, until: second.promise } },
        ]),
      ],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    })
    const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/workspace", systemPrompt: "" })
    const ui = new UiRequests(agent.bus)
    let request!: AnyEvent
    let start!: AnyEvent
    const off = agent.bus.subscribe((event) => {
      if (event.type === "ui.request") request = event
      if (event.type === "turn.start") start = event
    })
    const old = agent.prompt("original")
    const answer = ui.api("approval").confirm("Old pending approval")
    await agent.bus.flush()
    if (replacementTurn) {
      first.resolve()
      await old
    }
    const replacement = replacementTurn ? agent.prompt("replacement") : old
    await agent.bus.flush()
    off()
    const terminal = new FakeTerminal(80, 24)
    const ready = Promise.withResolvers<void>()
    const exited = runInteractive({
      agent,
      ui,
      status: new StatusRegistry(),
      terminal,
      setup: noProbe,
      env: {},
      files: fileList(async () => []),
      startupEvents: [request, start],
      onReady: () => ready.resolve(),
    })
    try {
      await ready.promise
      terminal.send("\x1b")
      expect(await answer).toBeUndefined()
      await Bun.sleep(0)
      if (replacementTurn) second.resolve()
      else first.resolve()
      expect((await replacement).reason).toBe(replacementTurn ? "done" : "aborted")
    } finally {
      first.resolve()
      second.resolve()
      ui.cancelAll()
      agent.abort()
      await replacement
      await agent.bus.flush()
      terminal.send("\x03\x03")
      await exited
      await agent.dispose()
    }
  })
}
