import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent, CommandContext, SessionControl } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { CommandHost, CommandRegistry } from "../src/commands.ts"
import { EventBus } from "../src/event-bus.ts"
import { SessionStore } from "../src/session-store.ts"
import { UiRequests } from "../src/ui-requests.ts"

async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-command-print-resume-"))
  const mock = createMockDialect([
    { text: "initial answer" },
    { text: "first answer" },
    { text: "second answer" },
  ])
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const originalStore = SessionStore.create({ cwd: dir, dir })
  const nextStore = SessionStore.create({ cwd: dir, dir })
  const agents: Agent[] = []
  const makeAgent = (session: SessionStore) => {
    const agent = new Agent({ ai, bus, model: ai.model("mock/m"), cwd: dir, session, systemPrompt: "" })
    agents.push(agent)
    return agent
  }
  const original = makeAgent(originalStore)
  const registry = new CommandRegistry()
  let print!: CommandContext["print"]
  registry.register(
    {
      name: "btw",
      description: "retain printer",
      run: (_args, ctx) => {
        print = ctx.print
      },
    },
    "test",
  )
  const host = new CommandHost({
    registry,
    bus,
    agent: original,
    ui: new UiRequests(bus),
    control: {} as SessionControl,
  })
  await original.prompt("initial question")
  expect((await host.run("/btw", { frontend: "tui" })).ok).toBe(true)
  await original.dispose("switch")
  const next = makeAgent(nextStore)
  host.switchTo(next)
  await next.dispose("switch")
  const resumedStore = SessionStore.open(originalStore.file)
  const resumed = makeAgent(resumedStore)
  host.switchTo(resumed)
  return {
    dir,
    bus,
    events,
    mock,
    originalStore,
    nextStore,
    resumedStore,
    resumed,
    host,
    makeAgent,
    print: () => print("retained side question", "info", { details: "retained side answer", persist: true }),
    cleanup: async () => {
      for (const agent of agents) await agent.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test("a retained printer before two resumed main turns does not stop either turn saving", async () => {
  const s = await setup()
  try {
    expect(s.resumedStore).not.toBe(s.originalStore)
    expect(() => s.print()).not.toThrow()
    await s.resumed.prompt("first resumed question")
    await s.resumed.prompt("second resumed question")
    await s.bus.flush()
    expect(
      s.events.filter((event) => event.type === "extension.error" && event.data.source === "session"),
    ).toEqual([])
    const saved = SessionStore.open(s.originalStore.file)
    expect(saved.restore().messages).toEqual(s.resumed.messages)
    expect(saved.restore().messages).toHaveLength(6)
    expect(saved.branch().filter((entry) => entry.type === "display")).toEqual([
      expect.objectContaining({ text: "retained side question", details: "retained side answer" }),
    ])
    expect(s.nextStore.entries.filter((entry) => entry.type === "display")).toEqual([])
    for (const request of s.mock.requests) {
      expect(JSON.stringify(request)).not.toContain("retained side")
    }
  } finally {
    await s.cleanup()
  }
})

test("without retained printing both resumed main turns save", async () => {
  const s = await setup()
  try {
    await s.resumed.prompt("first resumed question")
    await s.resumed.prompt("second resumed question")
    await s.bus.flush()
    expect(
      s.events.filter((event) => event.type === "extension.error" && event.data.source === "session"),
    ).toEqual([])
    const saved = SessionStore.open(s.originalStore.file)
    expect(saved.restore().messages).toEqual(s.resumed.messages)
    expect(saved.restore().messages).toHaveLength(6)
    expect(saved.branch().filter((entry) => entry.type === "display")).toEqual([])
  } finally {
    await s.cleanup()
  }
})

test("a retained printer between resumed turns appends through the current owner", async () => {
  const s = await setup()
  try {
    await s.resumed.prompt("first resumed question")
    expect(() => s.print()).not.toThrow()
    await s.resumed.prompt("second resumed question")
    await s.bus.flush()
    expect(
      s.events.filter((event) => event.type === "extension.error" && event.data.source === "session"),
    ).toEqual([])
    expect(s.events.filter((event) => event.type === "extension.notice")).toEqual([])
    const saved = SessionStore.open(s.originalStore.file)
    expect(saved.restore().messages).toEqual(s.resumed.messages)
    expect(saved.restore().messages).toHaveLength(6)
    expect(saved.branch().map((entry) => entry.type)).toEqual([
      "model_change",
      "message",
      "message",
      "message",
      "message",
      "display",
      "message",
      "message",
    ])
    expect(s.nextStore.entries.filter((entry) => entry.type === "display")).toEqual([])
  } finally {
    await s.cleanup()
  }
})

test("a retained printer routes to an origin owned outside the host's current session", async () => {
  const s = await setup()
  try {
    s.host.switchTo(s.makeAgent(s.nextStore))
    expect(() => s.print()).not.toThrow()
    await s.resumed.prompt("first resumed question")
    await s.resumed.prompt("second resumed question")
    await s.bus.flush()
    expect(
      s.events.filter((event) => event.type === "extension.error" && event.data.source === "session"),
    ).toEqual([])
    const saved = SessionStore.open(s.originalStore.file)
    expect(saved.restore().messages).toEqual(s.resumed.messages)
    expect(saved.restore().messages).toHaveLength(6)
    expect(s.resumedStore.branch().filter((entry) => entry.type === "display")).toHaveLength(1)
    expect(s.originalStore.entries.filter((entry) => entry.type === "display")).toEqual([])
    expect(s.nextStore.entries.filter((entry) => entry.type === "display")).toEqual([])
    expect(s.events.find((event) => event.type === "command.output")?.sessionId).toBe(s.resumed.sessionId)
  } finally {
    await s.cleanup()
  }
})

test("successive inactive retained prints re-read the latest origin and release their temporary lease", async () => {
  const s = await setup()
  try {
    await s.resumed.prompt("first resumed question")
    await s.resumed.dispose("switch")
    s.host.switchTo(s.makeAgent(s.nextStore))
    expect(() => s.print()).not.toThrow()
    expect(() => s.print()).not.toThrow()
    const reopened = SessionStore.open(s.originalStore.file)
    expect(reopened.restore().messages).toEqual(s.resumed.messages)
    expect(reopened.branch().filter((entry) => entry.type === "display")).toHaveLength(2)
    expect(s.originalStore.entries.filter((entry) => entry.type === "display")).toEqual([])
    const again = s.makeAgent(reopened)
    expect(() => s.print()).not.toThrow()
    await again.prompt("second resumed question")
    await s.bus.flush()
    expect(
      s.events.filter(
        (event) =>
          event.type === "extension.notice" ||
          (event.type === "extension.error" && event.data.source === "session"),
      ),
    ).toEqual([])
    expect(SessionStore.open(s.originalStore.file).restore().messages).toEqual(again.messages)
    expect(again.messages).toHaveLength(6)
    expect(s.nextStore.entries.filter((entry) => entry.type === "display")).toEqual([])
  } finally {
    await s.cleanup()
  }
})

test("ambiguous live owners drop retained output with a warning, then release restores safe routing", async () => {
  const s = await setup()
  try {
    const twin = s.makeAgent(SessionStore.open(s.originalStore.file))
    expect(() => s.print()).not.toThrow()
    await s.bus.flush()
    expect(s.events.filter((event) => event.type === "extension.notice")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          level: "warning",
          text: expect.stringContaining("Could not save display output"),
        }),
      }),
    ])
    expect(s.events.filter((event) => event.type === "command.output")).toEqual([])
    expect(
      SessionStore.open(s.originalStore.file)
        .branch()
        .filter((entry) => entry.type === "display"),
    ).toEqual([])
    await twin.dispose("switch")
    expect(() => s.print()).not.toThrow()
    await s.resumed.prompt("first resumed question")
    await s.resumed.prompt("second resumed question")
    await s.bus.flush()
    expect(
      s.events.filter((event) => event.type === "extension.error" && event.data.source === "session"),
    ).toEqual([])
    const saved = SessionStore.open(s.originalStore.file)
    expect(saved.restore().messages).toEqual(s.resumed.messages)
    expect(saved.restore().messages).toHaveLength(6)
    expect(saved.branch().filter((entry) => entry.type === "display")).toHaveLength(1)
    expect(s.nextStore.entries.filter((entry) => entry.type === "display")).toEqual([])
  } finally {
    await s.cleanup()
  }
})
