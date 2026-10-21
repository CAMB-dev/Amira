import "../server/offline.ts"
import { expect, spyOn, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent, OwnedConversation } from "@amira/api"
import { runInteractive } from "@amira/tui"
import { FakeTerminal } from "@amira/tui-kit"
import { agentSessionOwner } from "../../../core/src/session-routing.ts"
import { noProbe } from "../../../tui/test/app-harness.ts"
import { VirtualScreen } from "../../../tui-kit/test/screen.ts"
import type { RemoteAgentPort } from "../../src/remote/agent-port.ts"
import { remoteConversationSource } from "../../src/remote/conversations.ts"
import { remotePresentationPort } from "../../src/remote/presentation-port.ts"
import type { RemoteOwnerState, RemoteWorkspaceSnapshot } from "../../src/remote-schema.ts"
import { agentPortFixture, until } from "./agent-port-fixture.ts"

function turnStart(sessionId: string, turnId: string): AnyEvent {
  return {
    type: "turn.start",
    sessionId,
    turnId,
    seq: 1,
    ts: 1,
    data: { prompt: { role: "user", content: [{ type: "text", text: "prompt" }] } },
  }
}

function sourceFixture(activity: AnyEvent[] = []) {
  const events = new Set<Parameters<RemoteAgentPort["subscribeEvents"]>[0]>()
  const resets = new Set<Parameters<RemoteAgentPort["subscribeReset"]>[0]>()
  const owners: Record<string, RemoteOwnerState> = {}
  const workspace = {
    owners,
    semantic: { subagents: [] },
    activity: { events: [] },
  } as unknown as RemoteWorkspaceSnapshot
  const port = {
    workspaceSnapshot: workspace,
    sessionGeneration: 1,
    cursor: { daemonEpoch: "epoch", seq: 10 },
    subscribeEvents(listener: Parameters<RemoteAgentPort["subscribeEvents"]>[0]) {
      events.add(listener)
      return () => events.delete(listener)
    },
    subscribeReset(listener: Parameters<RemoteAgentPort["subscribeReset"]>[0]) {
      resets.add(listener)
      return () => resets.delete(listener)
    },
    async request(operation: string) {
      if (operation === "conversations.list")
        return {
          conversations: [{ id: "owned", incarnation: "owned-1", name: "Owned", cwd: "/owned", busy: false }],
        }
      if (operation === "conversations.history")
        return {
          snapshot: "cut",
          watermark: { daemonEpoch: "epoch", seq: 10 },
          messages: [],
          activity: { events: activity },
        }
      throw new Error(`Unexpected operation: ${operation}`)
    },
  } as unknown as RemoteAgentPort
  const source = remoteConversationSource(port)
  const owner = (parentSessionId?: string): RemoteOwnerState => ({
    parentSessionId,
    status: "working",
    busy: true,
    turnId: "stale-turn",
    hold: null,
    inputQueue: [],
    steering: [],
    noticeInbox: { queue: [], expected: 0 },
    noticeRetry: null,
  })
  return { source, owners, owner, workspace, events, resets }
}

test("source ancestry is available before focus, from authoritative RESET owners and live envelopes", () => {
  const f = sourceFixture()
  try {
    f.owners.child = f.owner("main")
    f.owners.grandchild = f.owner("child")
    f.owners["owned-child"] = f.owner("owned")
    f.owners["cycle-a"] = f.owner("cycle-b")
    f.owners["cycle-b"] = f.owner("cycle-a")
    expect(f.source.containsSession!("main", "grandchild")).toBe(true)
    expect(f.source.containsSession!("owned", "owned-child")).toBe(true)
    expect(f.source.containsSession!("main", "owned-child")).toBe(false)
    expect(f.source.containsSession!("main", "unrelated")).toBe(false)
    expect(f.source.containsSession!("main", "cycle-a")).toBe(false)
    const live = { ...turnStart("live-child", "turn"), parentSessionId: "grandchild" }
    for (const listener of f.events) listener(live, { replay: false, seq: 11 })
    expect(f.source.containsSession!("main", "live-child")).toBe(true)
    // A fresh RESET is authoritative: absent ancestry must not survive from the old stream.
    for (const listener of f.resets) listener(f.workspace, "cursor_expired")
    expect(f.source.containsSession!("main", "live-child")).toBe(false)
  } finally {
    f.source.dispose()
  }
  expect(f.events.size + f.resets.size).toBe(0)
})

for (const active of [false, true]) {
  test(`history cut, not stale cached ownership or descendant activity, selects control target; active=${active}`, async () => {
    const activity = [turnStart("owned-child", "child-turn")]
    if (active) activity.push(turnStart("owned", "current-root-turn"))
    const f = sourceFixture(activity)
    f.owners.owned = f.owner()
    try {
      const watch = await f.source.open({ conversationId: "owned", incarnation: "owned-1" }, () => {})
      expect(watch.snapshot.busy).toBe(active)
      expect(watch.snapshot.turnId).toBe(active ? "current-root-turn" : undefined)
      watch.dispose()
    } finally {
      f.source.dispose()
    }
  })
}

test("immediate Esc after first focus mid-turn stops the turn from the authoritative history cut", async () => {
  const gate = Promise.withResolvers<void>()
  let owned!: OwnedConversation
  const f = await agentPortFixture({
    ai: createAi({
      dialects: [
        createMockDialect([
          { text: "native prefix then remainder", hold: { chunks: 1, until: gate.promise } },
        ]),
      ],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    builtins: async () => [
      {
        source: "test:focus-control",
        async extension(api) {
          owned = await api.conversations!.openOrCreate(
            {
              key: crypto.randomUUID(),
              name: "Native mid-turn",
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
  const presentation = remotePresentationPort(f.port)
  const source = remoteConversationSource(f.port)
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
    conversations: source,
    subscribeFrontendEffects(listener) {
      detach = () => listener({ kind: "detach" })
      return presentation.subscribeFrontendEffects(listener)
    },
    terminal,
    setup: noProbe,
    settings: { margin: 0, marginRows: 0 },
    env: {},
    localCwd: process.cwd(),
  })
  const owner = agentSessionOwner(owned.id)!
  let partial = false
  let ended: string | undefined
  const off = owner.bus.capture(
    (event) => {
      if (event.type === "message.delta") partial = true
      if (event.type === "turn.end") ended = event.data.reason
    },
    () => {},
  )
  const stop = spyOn(owned, "stop")
  const execute = spyOn(f.port, "execute")
  const turn = owned.send("native prompt")
  try {
    await ready.promise
    await until(() => partial)
    const turnId = owner.turnId!
    // Native activity began before binding, so the attach-time owners cache has no control target.
    expect(f.port.workspaceSnapshot.owners[owned.id]).toBeUndefined()
    await f.port.execute("command.run", { line: "/native" })
    await until(() => screen.lines.join("\n").includes("Message Native mid-turn"))
    expect(screen.lines.join("\n").split("native prompt")).toHaveLength(2)
    expect(f.port.workspaceSnapshot.owners[owned.id]?.turnId).not.toBe(turnId)
    terminal.send("\x1b")
    await until(() => execute.mock.calls.some(([operation]) => operation === "conversation.stop"))
    expect(execute.mock.calls.find(([operation]) => operation === "conversation.stop")?.[1]).toEqual({
      conversationId: owned.id,
      incarnation: expect.any(String),
      expectedTurnId: turnId,
    })
    await until(() => stop.mock.calls.length === 1)
    // The mock's explicit hold is not abort-aware; release it after host stop admission.
    gate.resolve()
    await turn
    expect(owned.status().busy).toBe(false)
    expect(ended).toBe("aborted")
  } finally {
    gate.resolve()
    await turn
    stop.mockRestore()
    execute.mockRestore()
    off()
    detach()
    await exited
    source.dispose()
    presentation.dispose()
    await f.close()
  }
})
