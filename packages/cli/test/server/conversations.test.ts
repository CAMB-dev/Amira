import "./offline.ts"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { OwnedConversation } from "@amira/api"
import { ArtifactStore, createLocalAgentPort, SessionStore } from "@amira/core"
import { createCommandHost } from "../../src/control.ts"
import { createServerOperations } from "../../src/server/operations.ts"
import { createSession } from "../../src/session-factory.ts"

async function fixture() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-server-conversations-"))
  let owned!: OwnedConversation
  const session = await createSession({
    cwd,
    store: SessionStore.create({ cwd }),
    extensions: [],
    noBuiltins: false,
    autoTitle: false,
    ai: createAi({
      dialects: [createMockDialect([{ text: "first" }, { text: "second" }, { text: "child" }])],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    model: "mock/test",
    builtins: async () => [
      {
        source: "test:native",
        extension: async (api) => {
          owned = await api.conversations!.openOrCreate(
            { key: path.basename(cwd), name: "Native", cwd, systemPrompt: "", callableTools: [] },
            { askUser: async () => undefined },
          )
        },
      },
    ],
  })
  if (!owned) throw new Error(JSON.stringify(session.startupEvents))
  const commands = createCommandHost({ session, cwd })
  const port = createLocalAgentPort({ agent: session.agent, commands })
  const effects: unknown[] = []
  const request = createServerOperations({
    session,
    control: commands.control,
    generation: () => port.identity!.sessionGeneration,
    historyCut: (_ref, read) => ({
      history: read(),
      cut: { watermark: { daemonEpoch: "test", seq: 0 }, activity: { events: [] } },
    }),
    onFocus: (ref) => effects.push(ref),
  })
  return {
    session,
    commands,
    port,
    owned,
    request,
    effects,
    async close() {
      request.conversations.clear()
      await owned.release()
      await port.detach()
      await commands.agent.dispose("exit")
      session.host.unloadAll()
      await session.host.drain()
      await session.traceRecorder?.close()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}

test("native history is authorized by live binding/incarnation, paged against an immutable snapshot", async () => {
  const f = await fixture()
  try {
    await f.owned.send("one")
    await expect(f.request("conversations.history", { conversationId: f.owned.id })).rejects.toMatchObject({
      code: "stale_operation",
    })
    const binding = f.request.conversations.bind(f.owned)
    const ref = { conversationId: f.owned.id, incarnation: binding.incarnation }
    await expect(f.request("conversations.history", { ...ref, incarnation: "forged" })).rejects.toMatchObject(
      { code: "stale_operation" },
    )
    const listed = await f.request("conversations.list", {})
    expect(listed.conversations[0]).toMatchObject({
      id: f.owned.id,
      incarnation: binding.incarnation,
      name: "Native",
    })
    expect(listed.conversations[0]).not.toHaveProperty("send")
    const first = await f.request("conversations.history", { ...ref, limit: 1 })
    expect(first.messages).toHaveLength(1)
    expect(first.nextOffset).toBe(1)
    await f.owned.send("two")
    const second = await f.request("conversations.history", { ...ref, snapshot: first.snapshot, offset: 1 })
    expect(second.messages).toHaveLength(1)
    expect(second.nextOffset).toBeUndefined()
    expect((await f.request("conversations.history", ref)).messages).toHaveLength(4)
    expect(await f.request("conversations.focus", ref)).toEqual({ ...ref, sessionGeneration: 1 })
    await f.request("conversations.unfocus", {})
    expect(f.effects).toEqual([ref, null])
    binding()
    await expect(
      f.request("conversations.history", { ...ref, snapshot: first.snapshot }),
    ).rejects.toMatchObject({ code: "stale_operation" })
    const rebound = f.request.conversations.bind(f.owned)
    await f.owned.release()
    await expect(
      f.request("conversations.focus", { ...ref, incarnation: rebound.incarnation }),
    ).rejects.toMatchObject({ code: "stale_operation" })
  } finally {
    await f.close()
  }
})

test("public child history and controls are closed to foreign ids and old session generations", async () => {
  const f = await fixture()
  try {
    const group = f.session.tree.createGroup(f.session.agent, { name: "public" })
    const child = group.spawn({ prompt: "child history" })
    await child.result()
    const listed = await f.request("conversations.list", {})
    expect(listed.subagents.some((info) => info.id === child.id)).toBe(true)
    const history = await f.request("conversations.history", { conversationId: child.id })
    expect(JSON.stringify(history.messages)).toContain("child history")
    expect(await f.request("conversations.control", { conversationId: child.id, action: "pause" })).toEqual({
      accepted: false,
      sessionGeneration: 1,
    })
    for (const operation of ["conversations.history", "conversations.focus"] as const)
      await expect(f.request(operation, { conversationId: "foreign" })).rejects.toMatchObject({
        code: "stale_operation",
      })
    await expect(
      f.request("conversations.control", { conversationId: "foreign", action: "stop" }),
    ).rejects.toMatchObject({ code: "stale_operation" })
    const binding = f.request.conversations.bind(f.owned)
    await f.port.execute("session.clear", {})
    await expect(
      f.request(
        "conversations.history",
        { conversationId: child.id, snapshot: history.snapshot },
        { sessionGeneration: 1 },
      ),
    ).rejects.toMatchObject({ code: "stale_session" })
    expect((await f.request("conversations.list", {})).conversations).toEqual([])
    await expect(
      f.request("conversations.focus", { conversationId: f.owned.id, incarnation: binding.incarnation }),
    ).rejects.toMatchObject({ code: "stale_operation" })
    expect(await f.request("jobs.list", {})).toEqual({ jobs: [] })
    await expect(f.request("jobs.output", { id: "missing", maxChars: 32_769 })).rejects.toMatchObject({
      code: "invalid_frame",
    })
  } finally {
    await f.close()
  }
})

test("artifact authorization rejects another session's output-directory alias", async () => {
  const f = await fixture()
  const own = f.session.agent.artifacts
  const foreign = new ArtifactStore({
    dir: path.join(f.session.agent.cwd, "foreign", "outputs"),
    storageRoot: f.session.agent.cwd,
    sessionId: "foreign",
  })
  try {
    const output = await foreign.save({ text: "FOREIGN_SECRET", tool: "fixture" })
    mkdirSync(path.dirname(own.dir), { recursive: true })
    symlinkSync(foreign.dir, own.dir, process.platform === "win32" ? "junction" : "dir")
    await expect(f.request("artifacts.read", { id: output.id })).rejects.toThrow()
  } finally {
    rmSync(own.dir, { recursive: true, force: true })
    await f.close()
  }
})

test("a fork authorizes inherited artifacts without creating its own output directory", async () => {
  const f = await fixture()
  const original = f.session.agent.artifacts
  const parent = new ArtifactStore({
    dir: path.join(f.session.agent.cwd, "parent", "outputs"),
    storageRoot: f.session.agent.cwd,
    sessionId: "parent",
  })
  const fork = new ArtifactStore({
    dir: path.join(f.session.agent.cwd, "fork", "outputs"),
    storageRoot: f.session.agent.cwd,
    sessionId: "fork",
    parent,
  })
  try {
    const output = await parent.save({ text: "inherited output", tool: "fixture" })
    Object.defineProperty(f.session.agent, "artifacts", { value: fork })
    const result = await f.request("artifacts.read", { id: output.id })
    expect(Buffer.from(result.data, "base64").toString()).toBe("inherited output")
  } finally {
    Object.defineProperty(f.session.agent, "artifacts", { value: original })
    await f.close()
  }
})
