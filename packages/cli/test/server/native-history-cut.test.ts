import "./offline.ts"
import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import type { OwnedConversation } from "@amira/api"
import { agentSessionOwner } from "../../../core/src/session-routing.ts"
import type { RemoteWorkspaceSnapshot } from "../../src/remote-schema.ts"
import type { JournalEvent } from "../../src/server/journal.ts"
import { createWorkspaceRuntime, type ServerEffect } from "../../src/server/runtime.ts"

async function eventually(check: () => boolean) {
  const end = Date.now() + 3000
  while (!check() && Date.now() < end) await Bun.sleep(1)
  expect(check()).toBe(true)
}
async function fixture(steps: MockStep[]) {
  const cwd = mkdtempSync(path.join(tmpdir(), "amira-native-cut-"))
  let owned!: OwnedConversation
  const runtime = await createWorkspaceRuntime({
    cwd,
    autoTitle: false,
    model: "mock/test",
    ai: createAi({
      dialects: [createMockDialect(steps)],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    builtins: async () => [
      {
        source: "test:native",
        extension: async (api) => {
          owned = await api.conversations!.openOrCreate(
            { key: path.basename(cwd), name: "Native", cwd, systemPrompt: "", callableTools: [] },
            { askUser: async () => undefined },
          )
          api.registerCommand({
            name: "native",
            description: "test",
            run: (_args, ctx) => {
              ctx.focusConversation?.(owned)
            },
          })
        },
      },
    ],
  })
  let effect: Extract<ServerEffect, { kind: "focus" }> | undefined
  const port = runtime.attach({
    onEffect: (value) => {
      if (value.kind === "focus") effect = value
    },
  })
  return {
    cwd,
    owned,
    runtime,
    port,
    async focus() {
      expect(await port.execute("command.run", { line: "/native" })).toMatchObject({ ok: true })
      if (!effect) throw new Error("Missing native focus")
      return { conversationId: effect.conversationId, incarnation: effect.incarnation }
    },
    async close() {
      await runtime.stop()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}

test("first native focus mid-stream seeds complete authoritative activity for RESET", async () => {
  const gate = Promise.withResolvers<void>()
  const f = await fixture([
    { text: "existing prefix then remainder", hold: { chunks: 1, until: gate.promise } },
  ])
  let partial = false
  const off = agentSessionOwner(f.owned.id)!.bus.capture(
    (event) => {
      if (event.type === "message.delta") partial = true
    },
    () => {},
  )
  const turn = f.owned.send("native input")
  try {
    await eventually(() => partial)
    const ref = await f.focus()
    const history = await f.port.request("conversations.history", ref)
    expect(
      history.activity.events.some(
        (event) =>
          event.type === "message.delta" && event.data.kind === "text" && event.data.text === "existing",
      ),
    ).toBe(true)
    const reset = f.runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot
    expect(reset.owners[f.owned.id]?.busy).toBe(true)
    const activity = reset.activity.events.filter((event) => event.sessionId === f.owned.id)
    expect(activity.some((event) => event.type === "message.start")).toBe(true)
    expect(
      activity.some(
        (event) =>
          event.type === "message.delta" && event.data.kind === "text" && event.data.text === "existing",
      ),
    ).toBe(true)
  } finally {
    gate.resolve()
    await turn
    off()
    await f.close()
  }
})

test("native history budgeting never calls the cloning public history or materializes branch first", async () => {
  const f = await fixture([])
  const owner = agentSessionOwner(f.owned.id)!
  owner.session!.appendMessage({
    role: "user",
    content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }],
  })
  const publicHistory = spyOn(f.owned, "history").mockImplementation(() => {
    throw new Error("public history cloned before budget")
  })
  const branch = spyOn(owner.session!, "branch").mockImplementation(() => {
    throw new Error("branch materialized before budget")
  })
  try {
    const ref = await f.focus()
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(f.port.request("conversations.history", { ...ref, limit: 1 })).rejects.toThrow(
        "page limit",
      )
    expect(publicHistory).not.toHaveBeenCalled()
    expect(branch).not.toHaveBeenCalled()
  } finally {
    branch.mockRestore()
    publicHistory.mockRestore()
    await f.close()
  }
})

test("history pages retain one atomic watermark and reconcile completed messages against live events", async () => {
  const f = await fixture([{ text: "first answer" }, { text: "later answer" }])
  const events: JournalEvent[] = []
  const cut = f.runtime.journal.open(
    undefined,
    () => f.runtime.workspaceSnapshot(),
    (event) => events.push(event),
  )
  try {
    const ref = await f.focus()
    await f.owned.send("first input")
    const first = await f.port.request("conversations.history", { ...ref, limit: 1 })
    const watermark = { daemonEpoch: f.runtime.journal.daemonEpoch, seq: f.runtime.journal.watermark }
    expect(first).toMatchObject({ watermark })
    expect(first.activity.events.every((event) => event.sessionId === f.owned.id)).toBe(true)
    await f.owned.send("later input")
    const second = await f.port.request("conversations.history", {
      ...ref,
      snapshot: first.snapshot,
      offset: 1,
    })
    expect(second).toMatchObject({ watermark, activity: first.activity })
    expect(second.nextOffset).toBeUndefined()
    const completed = events.filter(
      (event) =>
        event.payload &&
        typeof event.payload === "object" &&
        !Array.isArray(event.payload) &&
        event.payload.type === "message.end",
    )
    expect(completed.some((event) => event.seq <= watermark.seq)).toBe(true)
    const live = completed.filter((event) => event.seq > watermark.seq)
    expect(live).toHaveLength(1)
    expect(JSON.stringify(second.messages)).toContain("first answer")
    expect(JSON.stringify(live)).toContain("later answer")
  } finally {
    cut.close()
    await f.close()
  }
})

test("reentrant refocus during native delta capture neither journals nor seeds that delta twice", async () => {
  const gate = Promise.withResolvers<void>()
  const f = await fixture([
    { text: "existing prefix then remainder", hold: { chunks: 1, until: gate.promise } },
  ])
  let refocus: Promise<unknown> | undefined
  let deltas = 0
  const cut = f.runtime.journal.open(
    undefined,
    () => f.runtime.workspaceSnapshot(),
    (event) => {
      const payload = event.payload
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        payload.type !== "message.delta" ||
        payload.sessionId !== f.owned.id
      )
        return
      deltas++
      if (!refocus) refocus = f.port.execute("command.run", { line: "/native" })
    },
  )
  await f.focus()
  const turn = f.owned.send("native input")
  try {
    await eventually(() => !!refocus)
    await refocus
    const reset = f.runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot
    const text = reset.activity.events
      .filter((event) => event.type === "message.delta" && event.sessionId === f.owned.id)
      .map((event) => (event.type === "message.delta" && event.data.kind === "text" ? event.data.text : ""))
      .join("")
    expect(deltas).toBe(1)
    expect(text).toBe("existing")
  } finally {
    gate.resolve()
    await turn
    cut.close()
    await f.close()
  }
})

test("native persistence failure cannot certify a history or RESET cut that drops completed memory", async () => {
  const f = await fixture([{ text: "completed volatile answer" }])
  const owner = agentSessionOwner(f.owned.id)!
  const append = owner.session!.append.bind(owner.session!)
  const failing = spyOn(owner.session!, "append").mockImplementation((entry) => {
    if (entry.type === "message" && entry.message.role === "assistant") throw new Error("fixture disk full")
    return append(entry)
  })
  try {
    const ref = await f.focus()
    await f.owned.send("persisted user")
    expect(JSON.stringify(owner.messages)).toContain("completed volatile answer")
    await expect(f.port.request("conversations.history", ref)).rejects.toThrow("persistence")
    expect(() => f.runtime.workspaceSnapshot()).toThrow("persistence")
  } finally {
    failing.mockRestore()
    await f.close()
  }
})

test("first binding during an active bus publication fences the seeded event from live capture", async () => {
  const gate = Promise.withResolvers<void>()
  const f = await fixture([
    { text: "existing prefix then remainder", hold: { chunks: 1, until: gate.promise } },
  ])
  let focus: Promise<unknown> | undefined
  const off = agentSessionOwner(f.owned.id)!.bus.capture(
    (event) => {
      if (event.type === "message.delta" && !focus) focus = f.port.execute("command.run", { line: "/native" })
    },
    () => {},
  )
  const turn = f.owned.send("native input")
  try {
    await eventually(() => !!focus)
    await focus
    expect((await f.port.request("conversations.list", {})).conversations).toHaveLength(1)
    const snapshot = f.runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot
    const text = snapshot.activity.events
      .filter((event) => event.sessionId === f.owned.id && event.type === "message.delta")
      .map((event) => (event.type === "message.delta" && event.data.kind === "text" ? event.data.text : ""))
      .join("")
    expect(text).toBe("existing")
  } finally {
    gate.resolve()
    await turn
    off()
    await f.close()
  }
})
