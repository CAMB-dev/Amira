import "./offline.ts"
import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent, BackgroundJobChange, BackgroundJobInfo } from "@amira/api"
import { createLocalAgentPort } from "@amira/core"
import { frontendJson } from "../../../core/src/frontend/json.ts"
import { createCommandHost } from "../../src/control.ts"
import { type RemoteWorkspaceSnapshot, validateRemoteDto } from "../../src/remote-schema.ts"
import { createWorkspaceCapture } from "../../src/server/capture.ts"
import type { JournalEvent } from "../../src/server/journal.ts"
import type { ServerEvent } from "../../src/server/runtime.ts"
import { createSession } from "../../src/session-factory.ts"

async function fixture(
  eventDto = (event: AnyEvent): ServerEvent => {
    const dto = frontendJson(event)
    validateRemoteDto("coreEvent", dto)
    return dto as unknown as ServerEvent
  },
) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-capture-"))
  const session = await createSession({
    cwd,
    ai: createAi({
      dialects: [createMockDialect([])],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    model: "mock/test",
    autoTitle: false,
    extensions: [],
    noBuiltins: false,
    builtins: async () => [],
  })
  const commands = createCommandHost({ session, cwd, home: cwd })
  const port = createLocalAgentPort({ agent: session.agent, commands })
  let jobs: BackgroundJobInfo[] = []
  let changed!: (change: BackgroundJobChange) => void
  let subscribed = false
  const list = spyOn(session.host.backgroundJobs, "list").mockImplementation(() => jobs)
  const subscribe = spyOn(session.host.backgroundJobs, "subscribe").mockImplementation((listener) => {
    changed = listener
    subscribed = true
    return () => {
      subscribed = false
    }
  })
  const capture = createWorkspaceCapture({
    session,
    commands,
    port,
    eventDto,
    startupEvents: [],
    pending: () => [],
  })
  const snapshot = () => capture.snapshot() as unknown as RemoteWorkspaceSnapshot
  const job = (overrides: Partial<BackgroundJobInfo> = {}): BackgroundJobInfo => ({
    id: "job-1",
    command: "fixture-only",
    cwd,
    meta: { secret: "SENTINEL_META" },
    startedAt: 10,
    status: "running",
    contained: true,
    exitCode: null,
    signal: null,
    stopRequested: false,
    outputChars: 0,
    error: "SENTINEL_ERROR",
    logPath: "SENTINEL_LOG_PATH",
    logError: "SENTINEL_LOG_ERROR",
    ...overrides,
  })
  return {
    session,
    port,
    capture,
    snapshot,
    job,
    change(value: BackgroundJobInfo, type: BackgroundJobChange["type"] = "output") {
      jobs = [value]
      changed({ type, job: value, output: "not a process" })
    },
    subscribed: () => subscribed,
    async close() {
      capture.close()
      await port.detach()
      list.mockRestore()
      subscribe.mockRestore()
      await commands.agent.dispose("exit")
      session.host.unloadAll()
      await session.host.drain()
      await session.traceRecorder?.close()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}

function payload(event: JournalEvent) {
  const value = event.payload
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object payload")
  return value
}

test("capture orders core, job, and coalesced semantic updates and resets retain only public terminal job data", async () => {
  const f = await fixture()
  const events: JournalEvent[] = []
  const cut = f.capture.journal.open(
    undefined,
    () => f.capture.snapshot(),
    (event) => events.push(event),
  )
  try {
    const meta = { sessionId: f.session.agent.sessionId }
    const notice = f.session.agent.bus.emit(
      "extension.notice",
      { source: "fixture", text: "before job", level: "info" },
      meta,
    )
    f.change(f.job({ outputChars: 4096 }))
    const after = f.session.agent.bus.emit(
      "extension.notice",
      { source: "fixture", text: "after job", level: "info" },
      meta,
    )
    await f.session.agent.bus.flush()
    expect(events.map((event) => payload(event).type ?? payload(event).kind)).toEqual([
      "extension.notice",
      "jobs",
      "extension.notice",
      "semantic",
    ])
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    expect(frontendJson(events[0]!.payload)).toEqual(frontendJson(notice))
    expect(frontendJson(events[2]!.payload)).toEqual(frontendJson(after))
    expect(payload(events[3]!).semantic).toMatchObject({
      status: { info: { model: { model: "test" } } },
      models: [{ ref: "mock/test" }],
    })

    f.change(f.job({ status: "exited", exitCode: 7, endedAt: 20, outputChars: 8192 }), "end")
    const reset = f.capture.journal.open(
      undefined,
      () => f.capture.snapshot(),
      () => {},
    )
    try {
      const frame = reset.initial[0]!
      expect(frame.kind).toBe("reset")
      if (frame.kind !== "reset") throw new Error("Expected reset")
      validateRemoteDto("workspaceSnapshot", frame.snapshot)
      const state = frame.snapshot as unknown as RemoteWorkspaceSnapshot
      expect(state.jobs).toEqual([
        {
          id: "job-1",
          command: "fixture-only",
          cwd: f.session.agent.cwd,
          startedAt: 10,
          status: "exited",
          contained: true,
          exitCode: 7,
          signal: null,
          stopRequested: false,
          outputChars: 8192,
          endedAt: 20,
        },
      ])
      expect(JSON.stringify(frame.snapshot)).not.toContain("SENTINEL")
      expect(payload(events[1]!).jobs).toMatchObject([{ status: "running", outputChars: 4096 }])
      expect(payload(events.at(-1)!).jobs).toEqual(state.jobs)
    } finally {
      reset.close()
    }
    f.capture.close()
    expect(f.subscribed()).toBe(false)
    const watermark = f.capture.journal.watermark
    f.session.agent.bus.emit(
      "extension.notice",
      { source: "fixture", text: "after close", level: "info" },
      meta,
    )
    await f.session.agent.bus.flush()
    expect(f.capture.journal.watermark).toBe(watermark)
  } finally {
    cut.close()
    await f.close()
  }
})

test("capture reset retains message partials and tool completion synchronously before settled history", async () => {
  const f = await fixture()
  try {
    const bus = f.session.agent.bus
    const meta = { sessionId: f.session.agent.sessionId, turnId: "turn-1" }
    const start = bus.emit("message.start", { model: { provider: "mock", model: "test" } }, meta)
    const stream = bus.emit("message.stream", { kind: "contentStart", index: 0 }, meta)
    const delta = bus.emit("message.delta", { kind: "text", text: "unfinished text" }, meta)
    const toolStart = bus.emit(
      "tool.execute.start",
      { toolCallId: "call-1", name: "fixture", args: {} },
      meta,
    )
    const update = bus.emit(
      "tool.execute.update",
      {
        toolCallId: "call-1",
        name: "fixture",
        partial: { content: [{ type: "text", text: "working" }] },
      },
      meta,
    )
    const partial = f.snapshot()
    expect(partial.frontend.transcript.messages).toEqual([])
    expect(frontendJson(partial.activity.events)).toEqual(
      frontendJson([start, stream, delta, toolStart, update]),
    )
    const end = bus.emit(
      "tool.execute.end",
      {
        toolCallId: "call-1",
        name: "fixture",
        durationMs: 3,
        result: { content: [{ type: "text", text: "completed before history" }] },
      },
      meta,
    )
    const completed = f.snapshot()
    validateRemoteDto("workspaceSnapshot", completed)
    expect(completed.frontend.transcript.messages).toEqual([])
    expect(frontendJson(completed.activity.events)).toEqual(
      frontendJson([start, stream, delta, toolStart, end]),
    )
    expect(frontendJson(partial.activity.events)).toEqual(
      frontendJson([start, stream, delta, toolStart, update]),
    )
    expect(Object.isFrozen(completed.activity.events)).toBe(true)
  } finally {
    await f.close()
  }
})

test("a failed synchronous event capture fails closed rather than returning incomplete activity or replay", async () => {
  let invalid = false
  const f = await fixture((event) => {
    if (invalid) throw new Error("SENTINEL_INVALID_EVENT")
    return event as ServerEvent
  })
  try {
    invalid = true
    expect(() =>
      f.session.agent.bus.emit(
        "message.start",
        {
          model: { provider: "mock", model: "test" },
        },
        { sessionId: f.session.agent.sessionId },
      ),
    ).not.toThrow()
    expect(() => f.snapshot()).toThrow("Frontend activity requires authoritative recovery")
    expect(() =>
      f.capture.journal.open(
        {
          daemonEpoch: f.capture.journal.daemonEpoch,
          after: 0,
        },
        () => f.capture.snapshot(),
        () => {},
      ),
    ).toThrow("Frontend activity requires authoritative recovery")
  } finally {
    await f.close()
  }
})

test("invalid public job data rejects reset construction and marks replay capture failed after recovery", async () => {
  const f = await fixture()
  try {
    f.change(f.job({ outputChars: -1.5 }))
    expect(() => f.snapshot()).toThrow()
    f.change(f.job({ status: "failed", exitCode: 1, outputChars: 42 }), "end")
    const cut = f.capture.journal.open(
      {
        daemonEpoch: f.capture.journal.daemonEpoch,
        after: 0,
      },
      () => f.capture.snapshot(),
      () => {},
    )
    try {
      expect(cut.initial).toMatchObject([
        {
          kind: "reset",
          reason: "capture_failed",
          snapshot: { jobs: [{ status: "failed", outputChars: 42 }] },
        },
      ])
      expect(JSON.stringify(cut.initial)).not.toContain("SENTINEL")
    } finally {
      cut.close()
    }
  } finally {
    await f.close()
  }
})

test("selection of an idle replacement can recover a retired capture failure without claiming missing live work", async () => {
  let invalid = false
  const f = await fixture((event) => {
    if (invalid) throw new Error("SENTINEL_OLD_CAPTURE")
    return event as ServerEvent
  })
  try {
    invalid = true
    f.session.agent.bus.emit(
      "extension.notice",
      { source: "fixture", level: "info", text: "invalid source" },
      { sessionId: f.session.agent.sessionId },
    )
    expect(() => f.snapshot()).toThrow("recovery")
    invalid = false
    expect(await f.port.execute("session.clear", {})).toEqual({ sessionGeneration: 2 })
    expect(f.snapshot().frontend).toMatchObject({ sessionGeneration: 2, state: { status: "idle" } })
  } finally {
    await f.close()
  }
})
