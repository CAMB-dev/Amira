import "./offline.ts"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import { createLocalAgentPort, SessionStore } from "@amira/core"
import { SessionHold } from "../../../core/src/agent/hold.ts"
import { registerHeldInput as registerRecovery } from "../../../core/src/agent/notice-input.ts"
import { NoticeInbox } from "../../../core/src/agent/notices.ts"
import { frontendJson } from "../../../core/src/frontend/json.ts"
import { Child } from "../../../core/src/subagents/child.ts"
import { createCommandHost } from "../../src/control.ts"
import { encodeRemoteMessage, RemoteDecoder } from "../../src/remote/codec.ts"
import type { RemoteWorkspaceSnapshot } from "../../src/remote-schema.ts"
import { validateRemoteDto } from "../../src/remote-schema.ts"
import { createWorkspaceCapture } from "../../src/server/capture.ts"
import type { ServerEvent } from "../../src/server/runtime.ts"
import { createSession } from "../../src/session-factory.ts"

async function fixture() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-owner-fence-"))
  const store = SessionStore.create({ cwd, dir: path.join(cwd, "sessions") })
  const session = await createSession({
    cwd,
    store,
    executionOnly: true,
    extensions: [],
    noBuiltins: false,
    model: "mock/test",
    autoTitle: false,
    catalog: false,
    ai: createAi({
      dialects: [createMockDialect([{ text: "recorded" }])],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    builtins: async () => [
      {
        source: "fixture",
        extension: (api) => {
          api.registerFileRestoration({ label: "test checkpoint", restore: async () => {} })
        },
      },
    ],
  })
  const commands = createCommandHost({
    session,
    cwd,
    home: cwd,
    announce: (agent, reason) => agent.start(reason),
  })
  const port = createLocalAgentPort({ agent: session.agent, commands })
  const capture = createWorkspaceCapture({
    session,
    commands,
    port,
    pending: () => [],
    startupEvents: [],
    eventDto: (event) => frontendJson(event) as unknown as ServerEvent,
  })
  session.agent.start("startup")
  await session.agent.prompt("create a rewind entry")
  await session.agent.bus.flush()
  return {
    session,
    commands,
    port,
    capture,
    async close() {
      capture.close()
      await port.detach()
      await commands.agent.dispose("exit")
      session.host.unloadAll()
      await session.host.drain()
      await session.traceRecorder?.close()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}

function decodeReset(capture: Awaited<ReturnType<typeof fixture>>["capture"]): RemoteWorkspaceSnapshot {
  const cut = capture.journal.open(
    undefined,
    () => capture.snapshot(),
    () => {},
  )
  try {
    const decoder = new RemoteDecoder()
    const frames = cut.initial.flatMap((frame) =>
      [...encodeRemoteMessage(frame)].flatMap((bytes) => decoder.push(bytes)),
    )
    decoder.finish()
    const frame = frames[0]!
    if (frame.kind !== "reset") throw new Error("Expected RESET")
    validateRemoteDto("workspaceSnapshot", frame.snapshot)
    return frame.snapshot as unknown as RemoteWorkspaceSnapshot
  } finally {
    cut.close()
  }
}

test("same-session file rewind cannot publish the retired hold cleanup over the replacement hold", async () => {
  const f = await fixture()
  const original = f.commands.agent
  const gate = Promise.withResolvers<void>()
  let held: Promise<void> | undefined
  const off = f.commands.onSwitch((replacement) => {
    held = replacement.hold("replacement stays held", () => gate.promise)
  })
  const before = f.capture.journal.watermark
  try {
    expect(await f.port.execute("session.rewind", { index: 0 })).toEqual({ sessionGeneration: 2 })
    expect(f.commands.agent).not.toBe(original)
    expect(f.commands.agent.sessionId).toBe(original.sessionId)
    expect(f.commands.agent.holdId).toBeDefined()
    const replay = f.capture.journal.open(
      { daemonEpoch: f.capture.journal.daemonEpoch, after: before },
      () => f.capture.snapshot(),
      () => {},
    )
    try {
      const decoder = new RemoteDecoder()
      const frames = replay.initial.flatMap((frame) =>
        [...encodeRemoteMessage(frame)].flatMap((bytes) => decoder.push(bytes)),
      )
      decoder.finish()
      const holds = frames.flatMap((frame) => {
        if (frame.kind !== "event") return []
        const payload = frame.payload
        return payload && typeof payload === "object" && !Array.isArray(payload) && payload.kind === "hold"
          ? [payload]
          : []
      })
      const snapshot = decodeReset(f.capture)
      expect(holds.at(-1)).toMatchObject({
        sessionId: original.sessionId,
        sessionGeneration: 2,
        hold: snapshot.owners[original.sessionId]!.hold,
      })
      expect(snapshot.owners[original.sessionId]!.hold).toEqual({
        id: f.commands.agent.holdId!,
        what: "replacement stays held",
      })
    } finally {
      replay.close()
    }
  } finally {
    gate.resolve()
    await held
    off()
    await f.close()
  }
}, 15_000)

test("genuinely removed owners still publish explicit empty cleanup including a late hold release", async () => {
  const f = await fixture()
  const gate = Promise.withResolvers<void>()
  let held: Promise<void> | undefined
  try {
    const child = f.session.tree.spawn(f.commands.agent, { prompt: "child work", persistent: true })
    if (!(child instanceof Child)) throw new Error("Expected real child")
    const until = Date.now() + 3000
    while (child.state !== "idle" && Date.now() < until) await Bun.sleep(1)
    expect(child.state).toBe("idle")
    held = child.agent.hold("held child", () => gate.promise)
    child.agent.steer(userMessage("held input"))
    child.agent.expectNotice().deliver(userMessage("quiet notice"), { wake: false })
    const before = f.capture.journal.watermark
    child.abort("remove owner")
    await child.result()
    gate.resolve()
    await held
    await child.agent.bus.flush()
    expect(decodeReset(f.capture).owners[child.id]).toBeUndefined()
    const replay = f.capture.journal.open(
      { daemonEpoch: f.capture.journal.daemonEpoch, after: before },
      () => f.capture.snapshot(),
      () => {},
    )
    try {
      const latest: Record<string, unknown> = {}
      for (const frame of replay.initial) {
        if (frame.kind !== "event") continue
        const value = frame.payload
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          value.sessionId !== child.id ||
          typeof value.kind !== "string"
        )
          continue
        latest[value.kind] = value[value.kind]
      }
      expect(latest).toMatchObject({
        hold: null,
        inputQueue: [],
        steering: [],
        noticeInbox: { queue: [], expected: 0 },
      })
    } finally {
      replay.close()
    }
  } finally {
    gate.resolve()
    await held
    await f.close()
  }
}, 15_000)

test("all owner-scoped notification channels discard delayed callbacks from a replaced incarnation", async () => {
  const f = await fixture()
  const retired = f.commands.agent
  const gate = Promise.withResolvers<void>()
  let held: Promise<void> | undefined
  let inbox: NoticeInbox | undefined
  try {
    await f.port.execute("session.rewind", { index: 0 })
    const replacement = f.commands.agent
    expect(replacement.sessionId).toBe(retired.sessionId)
    expect(replacement).not.toBe(retired)
    // A synthetic delayed producer retains the real retired sender identity. This drives
    // each existing host capture seam without reaching into either Agent's private fields.
    const state = { abort: undefined as AbortController | undefined }
    const prompt = async () => ({ reason: "done" as const, steps: 0 })
    let hold!: SessionHold
    inbox = new NoticeInbox({
      retryMs: [10_000],
      disposed: () => false,
      turn: () => undefined,
      holding: () => hold.what,
      busy: () => state.abort !== undefined,
      onIdleNotice: undefined,
      prompt,
      emit: () => {},
    })
    hold = new SessionHold({ state, inbox, prompt, emit: () => {} })
    registerRecovery(retired, hold, inbox, () => [])
    const before = f.capture.journal.watermark
    held = hold.run("retired producer", () => gate.promise)
    hold.steer(userMessage("retired input"))
    inbox.receive(userMessage("retired notice"), false)
    inbox.scheduleRetry("retired retry")
    inbox.cancelRetry()
    hold.cancel()
    inbox.clear()
    gate.resolve()
    await held
    expect(f.capture.journal.watermark).toBe(before)
    expect(decodeReset(f.capture).owners[replacement.sessionId]).toMatchObject({
      hold: null,
      inputQueue: [],
      noticeInbox: { queue: [], expected: 0 },
      noticeRetry: null,
      steering: [],
    })
  } finally {
    inbox?.cancelRetry()
    gate.resolve()
    await held
    await f.close()
  }
}, 15_000)
