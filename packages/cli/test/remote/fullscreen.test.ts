import "../server/offline.ts"
import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { OwnedConversation } from "@amira/api"
import { runInteractive } from "@amira/tui"
import { FakeTerminal } from "@amira/tui-kit"
import { noProbe } from "../../../tui/test/app-harness.ts"
import { VirtualScreen } from "../../../tui-kit/test/screen.ts"
import { createRemoteOverlayBackend } from "../../src/remote/agent-port-requests.ts"
import { remoteConversationSource } from "../../src/remote/conversations.ts"
import { createRemoteFileSource } from "../../src/remote/file-source.ts"
import { remotePresentationPort } from "../../src/remote/presentation-port.ts"
import { agentPortFixture, until } from "./agent-port-fixture.ts"

async function mount(fixture: Awaited<ReturnType<typeof agentPortFixture>>) {
  const presentation = remotePresentationPort(fixture.port)
  await presentation.refreshCommands()
  const requests = createRemoteOverlayBackend(fixture.port)
  const conversations = remoteConversationSource(fixture.port)
  const terminal = new FakeTerminal(100, 30)
  const screen = new VirtualScreen(100, 30)
  const write = terminal.write.bind(terminal)
  terminal.write = (text) => {
    write(text)
    screen.write(text)
  }
  const ready = Promise.withResolvers<void>()
  let detach = () => {}
  const exited = runInteractive({
    onReady: () => ready.resolve(),
    frontend: presentation.frontend,
    status: presentation.status,
    registerCommand: presentation.registerCommand,
    completions: presentation.completions,
    subscribeFrontendEffects(listener) {
      detach = () => listener({ kind: "detach" })
      return presentation.subscribeFrontendEffects(listener)
    },
    conversations,
    requests,
    files: createRemoteFileSource(fixture.port),
    terminal,
    setup: noProbe,
    env: {},
    settings: { margin: 0, marginRows: 0 },
    localCwd: process.cwd(),
  })
  const live = () => screen.lines.join("\n")
  await ready.promise
  return {
    terminal,
    live,
    async close() {
      detach()
      await exited
      conversations.dispose()
      requests.dispose()
      presentation.dispose()
    },
  }
}

test("codec-backed fullscreen has no local Agent, sends turns, reconnects with a draft and runs local theme", async () => {
  const f = await agentPortFixture()
  const ui = await mount(f)
  try {
    ui.terminal.send("codec prompt\r")
    await until(() => ui.live().includes("loopback answer"))
    ui.terminal.send("kept draft")
    await until(() => ui.live().includes("kept draft"))
    f.disconnect()
    await until(() => f.port.status === "disconnected")
    await f.port.reconnect()
    await until(() => ui.live().includes("Remote connected"))
    expect(ui.live()).toContain("kept draft")
    ui.terminal.send("\x15/theme amber\r")
    await until(() => ui.live().includes("Theme: amber"))
    const mode = f.port.snapshot.state.permissionMode
    ui.terminal.send("\x1b[Z")
    await until(() => f.port.snapshot.state.permissionMode !== mode)
    await until(() => ui.live().includes("Permission mode:"))
    expect(
      f.port.snapshot.transcript.messages.some(
        (entry) =>
          entry.message.role === "user" &&
          entry.message.content.some((block) => block.type === "text" && block.text.includes("/theme")),
      ),
    ).toBe(false)
  } finally {
    await ui.close()
    await f.close()
  }
})

test("JSON-roundtrip active snapshot shows its prompt once without collapsing distinct identical prompts", async () => {
  const release = Promise.withResolvers<void>()
  const mock = createMockDialect([
    { text: "first answer" },
    { text: "active answer continues", hold: { chunks: 1, until: release.promise } },
  ])
  const f = await agentPortFixture({
    ai: createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }], env: {} }),
  })
  let ui: Awaited<ReturnType<typeof mount>> | undefined
  try {
    await f.port.execute("turn.prompt", { message: "identical prompt", turnId: "first-turn" })
    await until(
      () => f.port.snapshot.state.status === "idle" && f.port.snapshot.transcript.messages.length === 2,
    )
    await f.port.execute("turn.prompt", { message: "identical prompt", turnId: "active-turn" })
    await until(() =>
      f.port.workspaceSnapshot.activity.events.some((event) => event.type === "message.delta"),
    )
    ui = await mount(f)
    await until(() => ui!.live().includes("active"))
    expect(ui.live().split("identical prompt")).toHaveLength(3)
  } finally {
    release.resolve()
    await ui?.close()
    await f.close()
  }
})

test("a retained remote dialog mounts from snapshot and remains answerable after reconnect", async () => {
  let answer: boolean | undefined
  const f = await agentPortFixture({
    builtins: async () => [
      {
        source: "test:dialog",
        extension(api) {
          api.registerCommand({
            name: "question",
            description: "test",
            async run(_args, ctx) {
              answer = await ctx.ui.confirm("Keep this remote request?")
            },
          })
        },
      },
    ],
  })
  const command = f.port.execute("command.run", { line: "/question" }).catch(() => {})
  await until(() => f.port.pendingRequests.length === 1)
  const ui = await mount(f)
  try {
    await until(() => ui.live().includes("Keep this remote request?"))
    f.disconnect()
    await until(() => f.port.status === "disconnected")
    await f.port.reconnect()
    expect(f.port.pendingRequests).toHaveLength(1)
    ui.terminal.send("\x1b[B\r")
    await until(() => answer !== undefined)
    expect(answer).toBe(true)
    await until(() => f.port.pendingRequests.length === 0)
    await command
  } finally {
    await ui.close()
    await f.close()
  }
})

test("remote skill input runs the host skill rather than sending its name as a prompt", async () => {
  let runs = 0
  const f = await agentPortFixture({
    builtins: async () => [
      {
        source: "test:skill",
        extension(api) {
          api.registerSkill({
            name: "deploy:prod",
            description: "Deploy fixture",
            run(args, ctx) {
              runs++
              ctx.print(`Deployed ${args}`)
            },
          })
        },
      },
    ],
  })
  const ui = await mount(f)
  try {
    expect((await f.port.request("commands.describe", {})).skills.map((skill) => skill.name)).toContain(
      "deploy:prod",
    )
    ui.terminal.send("$deploy:prod production\r")
    await until(() => runs === 1 && ui.live().includes("Deployed production"))
    expect(f.port.snapshot.transcript.messages).toHaveLength(0)
    ui.terminal.send("$100 is the price\r")
    await until(() => ui.live().includes("loopback answer"))
    expect(runs).toBe(1)
    expect(f.port.snapshot.transcript.messages[0]?.message.content).toEqual([
      { type: "text", text: "$100 is the price" },
    ])
  } finally {
    await ui.close()
    await f.close()
  }
})

test("host-issued remote focus reads scoped history and restores the main draft", async () => {
  let owned!: OwnedConversation
  const f = await agentPortFixture({
    builtins: async () => [
      {
        source: "test:focus",
        async extension(api) {
          owned = await api.conversations!.openOrCreate(
            {
              key: crypto.randomUUID(),
              name: "Remote native",
              cwd: process.cwd(),
              systemPrompt: "",
              callableTools: [],
            },
            { askUser: async () => undefined },
          )
          api.registerCommand({
            name: "native",
            description: "test",
            run(_args, ctx) {
              ctx.focusConversation?.(owned)
            },
          })
        },
      },
    ],
  })
  const ui = await mount(f)
  try {
    ui.terminal.send("main draft")
    const effect = Promise.withResolvers<void>()
    const off = f.port.subscribeWorkspace((update) => {
      if ("kind" in update && update.kind === "effect" && update.effect.kind === "focus") effect.resolve()
    })
    await f.port.execute("command.run", { line: "/native" })
    await effect.promise
    off()
    await until(() => ui.live().includes("Message Remote native")).catch(() => {
      throw new Error(ui.live())
    })
    ui.terminal.send("\x1b[17~") // F6: return to main without stopping the remote conversation.
    await until(() => ui.live().includes("main draft"))
    expect(owned.status().busy).toBe(false)
  } finally {
    await ui.close()
    await f.close()
  }
})
