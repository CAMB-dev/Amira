import "./offline.ts"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import { createLocalAgentPort } from "@amira/core"
import { type HeldInput, heldInputSnapshot, subscribeHeldInput } from "../../../core/src/agent/held-input.ts"
import { frontendJson } from "../../../core/src/frontend/json.ts"
import { createCommandHost } from "../../src/control.ts"
import { createWorkspaceCapture } from "../../src/server/capture.ts"
import type { JournalEvent } from "../../src/server/journal.ts"
import type { ServerEvent } from "../../src/server/runtime.ts"
import { createSession } from "../../src/session-factory.ts"

async function fixture() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-held-input-"))
  const mock = createMockDialect([{ text: "released" }])
  const session = await createSession({
    cwd,
    ai: createAi({
      dialects: [mock],
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
  const capture = createWorkspaceCapture({
    session,
    commands,
    port,
    eventDto: (event) => frontendJson(event) as unknown as ServerEvent,
    startupEvents: [],
    pending: () => [],
  })
  const gate = Promise.withResolvers<void>()
  const hold = session.agent.hold("compaction", () => gate.promise)
  return {
    session,
    port,
    capture,
    mock,
    async release() {
      gate.resolve()
      await hold
    },
    async close() {
      await session.agent.dispose("exit")
      gate.resolve()
      await hold
      capture.close()
      await port.detach()
      session.host.unloadAll()
      await session.host.drain()
      await session.traceRecorder?.close()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}

test("reset and journal retain held prompt admission and sequence its removal before turn start", async () => {
  const f = await fixture()
  const events: JournalEvent[] = []
  const cut = f.capture.journal.open(
    undefined,
    () => f.capture.snapshot(),
    (event) => events.push(event),
  )
  try {
    const message = userMessage("accepted behind compaction")
    const holdId = f.session.agent.holdId!
    expect(
      await f.port.execute("turn.prompt", { message, turnId: "held-turn", expectedHoldId: holdId }),
    ).toEqual({ sessionGeneration: 1 })
    expect(f.mock.requests).toHaveLength(0)
    expect(f.capture.snapshot()).toMatchObject({
      owners: { [f.session.agent.sessionId]: { inputQueue: [{ message, turnId: "held-turn", holdId }] } },
    })
    const admission = heldInputSnapshot(f.session.agent)
    expect(events[0]!.payload).toEqual({
      kind: "inputQueue",
      inputQueue: frontendJson(admission),
      sessionId: f.session.agent.sessionId,
      sessionGeneration: 1,
    })
    const watermark = f.capture.journal.watermark
    await f.release()
    await f.session.agent.currentTurn
    expect(f.mock.requests).toHaveLength(1)
    expect(f.capture.snapshot()).toMatchObject({
      owners: { [f.session.agent.sessionId]: { inputQueue: [] } },
    })
    const replay = f.capture.journal.open(
      { daemonEpoch: f.capture.journal.daemonEpoch, after: watermark },
      () => f.capture.snapshot(),
      () => {},
    )
    try {
      const payloads = replay.initial.flatMap((frame) => {
        if (frame.kind !== "event") return []
        const payload = frame.payload
        return payload && typeof payload === "object" && !Array.isArray(payload) ? [payload] : []
      })
      const removed = payloads.findIndex((payload) => payload.kind === "inputQueue")
      const started = payloads.findIndex((payload) => payload.type === "turn.start")
      expect(removed).toBeGreaterThanOrEqual(0)
      expect(payloads[removed]).toEqual({
        kind: "inputQueue",
        inputQueue: [],
        sessionId: f.session.agent.sessionId,
        sessionGeneration: 1,
      })
      expect(started).toBeGreaterThan(removed)
    } finally {
      replay.close()
    }
  } finally {
    cut.close()
    await f.close()
  }
})

test("host held-input seam captures synchronous admission, duplicate identity, and drain before turn start", async () => {
  const f = await fixture()
  const agent = f.session.agent
  const changes: (readonly HeldInput[])[] = []
  const order: string[] = []
  const off = subscribeHeldInput(agent, (queue) => {
    // Resampling creates DTO copies; admission ids, not JS object references, are stable.
    expect(heldInputSnapshot(agent)).toEqual(queue)
    changes.push(queue)
    order.push(`queue:${queue.length}`)
  })
  const offBus = agent.bus.capture(
    (event) => {
      if (event.type === "turn.steer") order.push(event.data.state)
      if (event.type === "turn.start") {
        expect(heldInputSnapshot(agent)).toEqual([])
        order.push(`start:${event.turnId}`)
      }
    },
    () => {},
  )
  try {
    const message = userMessage("duplicate")
    await f.port.execute("turn.steer", { message })
    await f.port.execute("turn.steer", { message })
    const admission = f.port.execute("turn.prompt", { message, turnId: "admitted-turn" })
    expect(changes.map((queue) => queue.length)).toEqual([1, 2, 3])
    expect(heldInputSnapshot(agent)).toMatchObject([
      { kind: "steer", message, holdId: agent.holdId },
      { kind: "steer", message, holdId: agent.holdId },
      { kind: "prompt", message, holdId: agent.holdId, turnId: "admitted-turn" },
    ])
    const before = heldInputSnapshot(agent)
    expect(new Set(before.map((entry) => entry.id)).size).toBe(3)
    expect(before[0]).toEqual(changes[0]![0])
    expect(Object.isFrozen(before)).toBe(true)
    expect(Object.isFrozen(before[0]!.message.content)).toBe(true)
    expect(before[0]!.message).not.toBe(message)
    await admission
    await expect(f.port.execute("turn.prompt", { message: "refused" })).rejects.toThrow()
    expect(heldInputSnapshot(agent)).toEqual(before)
    expect(changes).toHaveLength(3)
    await f.release()
    await agent.currentTurn
    expect(changes.map((queue) => queue.length)).toEqual([1, 2, 3, 0])
    expect(before).toHaveLength(3)
    expect(order).toEqual([
      "queue:1",
      "queued",
      "queue:2",
      "queued",
      "queue:3",
      "queue:0",
      "promoted",
      "promoted",
      "start:admitted-turn",
    ])
    expect(f.mock.requests).toHaveLength(1)
    expect(heldInputSnapshot(agent)).toEqual([])
  } finally {
    off()
    offBus()
    await f.close()
  }
})

test("host held-input seam gives an unlabelled prompt its eventual turn identity", async () => {
  const f = await fixture()
  try {
    await f.port.execute("turn.prompt", { message: "generated identity" })
    const [entry] = heldInputSnapshot(f.session.agent)
    expect(entry!.turnId).toBeString()
    const started: string[] = []
    const off = f.session.agent.bus.capture(
      (event) => {
        if (event.type === "turn.start") started.push(event.turnId!)
      },
      () => {},
    )
    try {
      await f.release()
      await f.session.agent.currentTurn
      expect(started).toEqual([entry!.turnId!])
    } finally {
      off()
    }
  } finally {
    await f.close()
  }
})

for (const outcome of ["abort", "dispose"] as const) {
  test(`host held-input seam removes dropped input before events on hold ${outcome}`, async () => {
    const f = await fixture()
    const agent = f.session.agent
    const order: string[] = []
    const off = subscribeHeldInput(agent, (queue) => order.push(`queue:${queue.length}`))
    const offBus = agent.bus.capture(
      (event) => {
        if (event.type === "turn.steer") order.push(event.data.state)
        if (event.type === "session.end") order.push("session.end")
      },
      () => {},
    )
    try {
      await f.port.execute("turn.prompt", { message: "drop me", turnId: "dropped-turn" })
      if (outcome === "abort") {
        await f.port.execute("turn.abort", { holdId: agent.holdId })
        await f.release()
      } else {
        await agent.dispose("switch")
        await f.release()
      }
      expect(heldInputSnapshot(agent)).toEqual([])
      expect(order).toEqual(
        outcome === "abort"
          ? ["queue:1", "queue:0", "dropped"]
          : ["queue:1", "queue:0", "dropped", "session.end"],
      )
      expect(f.mock.requests).toHaveLength(0)
    } finally {
      off()
      offBus()
      await f.close()
    }
  })
}

test("host held-input observers are removable and capture failures cannot reject admitted work", async () => {
  const f = await fixture()
  const errors: unknown[] = []
  const changes: number[] = []
  const failure = new Error("capture failed")
  const offFailure = subscribeHeldInput(
    f.session.agent,
    () => {
      throw failure
    },
    (error) => {
      errors.push(error)
    },
  )
  const off = subscribeHeldInput(f.session.agent, (queue) => changes.push(queue.length))
  try {
    await expect(f.port.execute("turn.prompt", { message: "accepted despite observer" })).resolves.toEqual({
      sessionGeneration: 1,
    })
    expect(errors).toEqual([failure])
    expect(changes).toEqual([1])
    off()
    offFailure()
    await f.release()
    await f.session.agent.currentTurn
    expect(changes).toEqual([1])
    expect(errors).toEqual([failure])
    expect(f.mock.requests).toHaveLength(1)
    expect(heldInputSnapshot(f.session.agent)).toEqual([])
  } finally {
    off()
    offFailure()
    await f.close()
  }
})
