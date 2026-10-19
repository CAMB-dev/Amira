import "./offline.ts"
import { expect, jest, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import type { BackgroundJobInfo, ChildSession, ExtensionAPI, PendingNotice } from "@amira/api"
import { type Agent, SessionStore } from "@amira/core"
import { heldInputSnapshot } from "../../../core/src/agent/held-input.ts"
import * as noticeInput from "../../../core/src/agent/notice-input.ts"
import { Child } from "../../../core/src/subagents/child.ts"
import * as commandFactory from "../../src/control.ts"
import { encodeRemoteMessage, RemoteDecoder } from "../../src/remote/codec.ts"
import type { RemoteWorkspaceSnapshot } from "../../src/remote-schema.ts"
import type { JournalEvent } from "../../src/server/journal.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import * as sessionFactory from "../../src/session-factory.ts"

// This is deliberately not a journal reducer: every expected value comes from a live
// owner or the host at the synchronous cut, including work with no public core event.
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const notice = (text: string) => userMessage(text, { origin: "subagent", text: "Background result" })
const fail = { error: { message: "property fixture provider failure" } }

async function settle() {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

async function eventually(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) {
    await settle()
    // Bun.sleep yields to native file I/O without advancing the mocked retry clock.
    if (!check()) await Bun.sleep(1)
  }
  expect(check()).toBe(true)
}

function random(seed: number) {
  let state = seed >>> 0
  return (length: number) => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) % length
  }
}

async function fixture() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-reset-property-"))
  const mock = createMockDialect()
  let session!: sessionFactory.Session
  let api!: ExtensionAPI
  const live = new Map<string, Agent>()
  const publicByRoot = new Map<string, Set<string>>()
  const rootOf = new Map<string, string>()
  const disposals: (() => void)[] = []
  const track = (agent: Agent) => {
    live.set(agent.sessionId, agent)
    const dispose = agent.dispose.bind(agent)
    const spy = spyOn(agent, "dispose").mockImplementation((reason) => {
      // Disposal unregisters synchronously. An old incarnation must not delete its successor.
      if (live.get(agent.sessionId) === agent) live.delete(agent.sessionId)
      return dispose(reason)
    })
    disposals.push(() => spy.mockRestore())
  }
  let commands!: ReturnType<typeof commandFactory.createCommandHost>
  const makeCommands = commandFactory.createCommandHost
  const control = spyOn(commandFactory, "createCommandHost").mockImplementation((options) => {
    commands = makeCommands({ ...options, home: cwd })
    return commands
  })
  let restoreSession = () => {}
  const create = sessionFactory.createSession
  const construction = spyOn(sessionFactory, "createSession").mockImplementation(async (options) => {
    session = await create(options)
    track(session.agent)
    rootOf.set(session.agent.sessionId, session.agent.sessionId)
    publicByRoot.set(session.agent.sessionId, new Set([session.agent.sessionId]))
    const spawn = session.tree.spawn.bind(session.tree)
    const spawning = spyOn(session.tree, "spawn").mockImplementation((parent, options, group) => {
      const child = spawn(parent, options, group)
      // ChildSession's public handle has a concrete Agent; no production owner registry is read.
      if (!(child instanceof Child)) throw new Error("Expected the real tree's Child handle")
      track(child.agent)
      const root = rootOf.get(parent.sessionId)!
      rootOf.set(child.id, root)
      if (!child.ephemeral) publicByRoot.get(root)!.add(child.id)
      return child
    })
    const resume = session.resume.bind(session)
    const resuming = spyOn(session, "resume").mockImplementation((store, model, acquired, options) =>
      resume(
        store,
        model,
        (construct) => {
          const make = () => {
            const next = construct()
            track(next)
            rootOf.set(next.sessionId, next.sessionId)
            if (!publicByRoot.has(next.sessionId)) publicByRoot.set(next.sessionId, new Set([next.sessionId]))
            return next
          }
          return acquired ? acquired(make) : make()
        },
        options,
      ),
    )
    restoreSession = () => {
      spawning.mockRestore()
      resuming.mockRestore()
    }
    return session
  })
  const runtime = await createWorkspaceRuntime({
    cwd,
    store: SessionStore.create({ cwd, dir: path.join(cwd, "sessions") }),
    ai: createAi({
      dialects: [mock],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      retry: { retries: 0 },
    }),
    model: "mock/test",
    autoTitle: false,
    noticeRetryMs: [10_000, 20_000],
    builtins: async () => [
      {
        source: "property-fixture",
        extension: (value) => {
          api = value
        },
      },
    ],
  }).finally(() => {
    construction.mockRestore()
    control.mockRestore()
  })
  const local = runtime.attach()
  let jobs: BackgroundJobInfo[] = []
  // No job.start or subprocess API is called. RESET must consult the actual host list,
  // even if a change never produced a jobs journal event.
  const list = spyOn(session.host.backgroundJobs, "list").mockImplementation(() => jobs)
  const gates: (() => void)[] = []
  return {
    session,
    api,
    mock,
    runtime,
    local,
    gates,
    commands,
    live,
    get root() {
      return commands.agent
    },
    get publicIds() {
      return publicByRoot.get(commands.agent.sessionId)!
    },
    owners() {
      expect(live.get(commands.agent.sessionId)).toBe(commands.agent)
      return [...live.values()].filter((agent) => agent.bus === session.agent.bus)
    },
    setJobs(value: BackgroundJobInfo[]) {
      jobs = value
    },
    job(id: string, owner?: string): BackgroundJobInfo {
      return {
        id,
        command: "in-memory fixture only",
        cwd,
        ...(owner ? { owner } : {}),
        meta: { private: "PROPERTY_PRIVATE_META" },
        startedAt: 10,
        status: "running",
        contained: true,
        exitCode: null,
        signal: null,
        stopRequested: false,
        outputChars: 0,
        error: "PROPERTY_PRIVATE_ERROR",
        logPath: "PROPERTY_PRIVATE_LOG_PATH",
        logError: "PROPERTY_PRIVATE_LOG_ERROR",
      }
    },
    gateModel() {
      const gate = Promise.withResolvers<void>()
      gates.push(gate.resolve)
      let reached = false
      mock.push({
        text: "successful settlement",
        hold: {
          chunks: 0,
          get until() {
            reached = true
            return gate.promise
          },
        },
      })
      return { release: gate.resolve, reached: () => reached }
    },
    async close() {
      for (const release of gates) release()
      session.host.ui.cancelAll()
      list.mockRestore()
      await local.detach()
      await runtime.stop()
      restoreSession()
      for (const restore of disposals) restore()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

function reset(f: Fixture) {
  const cut = f.runtime.journal.open(
    undefined,
    () => f.runtime.workspaceSnapshot(),
    () => {},
    true,
  )
  try {
    expect(cut.initial).toHaveLength(1)
    const original = cut.initial[0]!
    expect(original.kind).toBe("reset")
    // Exercise the real validated wire codec, not a cast of workspaceSnapshot().
    const decoder = new RemoteDecoder()
    const decoded = [...encodeRemoteMessage(original)].flatMap((bytes) => decoder.push(bytes))
    decoder.finish()
    expect(decoded).toHaveLength(1)
    const frame = decoded[0]!
    if (frame.kind !== "reset") throw new Error("Expected authoritative RESET")
    expect(frame.seq).toBe(cut.watermark)
    return frame.snapshot as unknown as RemoteWorkspaceSnapshot
  } finally {
    cut.close()
  }
}

function assertReset(f: Fixture) {
  const snapshot = reset(f)
  expect(snapshot).toHaveProperty("owners")
  expect(snapshot).not.toHaveProperty("inputQueue")
  expect(snapshot).not.toHaveProperty("noticeInbox")
  const expected: Record<string, unknown> = {}
  for (const agent of f.owners()) {
    const inbox = noticeInput.noticeInputSnapshot(agent)
    expect(inbox.queue).toHaveLength(agent.waitingNotices)
    expect(inbox.expected).toBe(agent.expectedNotices)
    expected[agent.sessionId] = json({
      ...(agent.parentSessionId ? { parentSessionId: agent.parentSessionId } : {}),
      status: agent.status,
      busy: agent.busy,
      turnId: agent.turnId ?? null,
      hold: agent.holdId ? { id: agent.holdId, what: agent.holdingFor! } : null,
      inputQueue: heldInputSnapshot(agent),
      steering: noticeInput.steeringInputSnapshot(agent),
      noticeInbox: inbox,
      noticeRetry: agent.noticeRetry ?? null,
    })
  }
  expect<unknown>(snapshot.owners).toEqual(expected)
  expect<unknown>(snapshot.pendingRequests).toEqual(json(f.session.host.ui.pending))
  // Identity is tracked from spawn results, including ended public children. Never
  // infer visibility from the returned RESET or its activity/history projection.
  const jobs = f.session.host.backgroundJobs
    .list()
    .filter((job) => !job.owner || f.publicIds.has(job.owner))
    .map(({ meta: _meta, error: _error, logPath: _logPath, logError: _logError, ...job }) => job)
  expect(snapshot.jobs).toEqual(json(jobs))
  expect(JSON.stringify(snapshot.jobs)).not.toContain("PROPERTY_PRIVATE_")
  expect(snapshot.activity.events.filter((event) => event.type === "turn.steer")).toEqual([])
  expect(snapshot.activity.events.filter((event) => event.type === "notice.retry")).toEqual([])
  return snapshot
}

function replayOracle(f: Fixture) {
  let after = f.runtime.journal.watermark
  const events: JournalEvent[] = []
  const live = f.runtime.journal.open(
    { daemonEpoch: f.runtime.journal.daemonEpoch, after },
    () => f.runtime.workspaceSnapshot(),
    (event) => events.push(event),
  )
  expect(live.initial).toEqual([])
  const patches = new Map<string, Record<string, unknown>>()
  const fields = ["hold", "inputQueue", "steering", "noticeInbox", "noticeRetry"] as const
  return {
    close: live.close,
    check(snapshot: RemoteWorkspaceSnapshot) {
      const replay = f.runtime.journal.open(
        { daemonEpoch: f.runtime.journal.daemonEpoch, after },
        () => f.runtime.workspaceSnapshot(),
        () => {},
      )
      try {
        const decoder = new RemoteDecoder()
        const decoded = replay.initial.flatMap((frame) =>
          [...encodeRemoteMessage(frame)].flatMap((bytes) => decoder.push(bytes)),
        )
        decoder.finish()
        expect(decoded).toHaveLength(events.length)
        const batch = events.splice(0)
        for (let i = 0; i < decoded.length; i++) {
          const frame = decoded[i]!
          expect(frame.kind).toBe("event")
          if (frame.kind !== "event") throw new Error("Replay unexpectedly required reset")
          expect(frame.replay).toBe(true)
          expect(frame.seq).toBe(batch[i]!.seq)
          expect(frame.payload).toEqual(batch[i]!.payload)
          const patch = frame.payload
          if (!patch || typeof patch !== "object" || Array.isArray(patch)) continue
          if (typeof patch.sessionId !== "string" || typeof patch.sessionGeneration !== "number") continue
          const key = `${patch.sessionGeneration}:${patch.sessionId}`
          const owner = patches.get(key) ?? {}
          for (const field of fields) {
            if (patch.kind === field) owner[field] = patch[field]
          }
          patches.set(key, owner)
        }
        after = replay.watermark
        for (const [id, owner] of Object.entries(snapshot.owners)) {
          const patch = patches.get(`${snapshot.frontend.sessionGeneration}:${id}`)
          for (const field of fields) {
            if (patch && field in patch) expect(patch[field]).toEqual(owner[field])
          }
        }
      } finally {
        replay.close()
      }
    },
  }
}

async function runSeed(seed: number) {
  const f = await fixture()
  let root = f.root
  const offSwitch = f.commands.onSwitch((next) => {
    root = next
  })
  const pick = random(seed)
  const children: ChildSession[] = []
  const handles: { agent: Agent; pending: PendingNotice }[] = []
  const history: string[] = []
  const covered = new Set<string>()
  let serial = 0
  let held: { release(): void; done: Promise<unknown> } | undefined
  let model: ReturnType<typeof f.gateModel> | undefined
  const idle = () => !root.busy && !root.holdingFor && !root.turnId
  const replay = replayOracle(f)
  const checkpoint = () => {
    const snapshot = assertReset(f)
    replay.check(snapshot)
    return snapshot
  }
  const step = async (name: string, action: () => unknown | Promise<unknown>) => {
    history.push(name)
    await action()
    covered.add(name)
    checkpoint()
  }
  const startHold = () => {
    const gate = Promise.withResolvers<void>()
    f.gates.push(gate.resolve)
    held = { release: gate.resolve, done: root.hold("property hold", () => gate.promise) }
  }
  const releaseHold = async (abort = false) => {
    if (abort) root.abort()
    held!.release()
    await held!.done
    held = undefined
    await root.currentTurn
    await settle()
  }
  const startModel = async () => {
    model = f.gateModel()
    void root.prompt(`held model ${serial++}`)
    await eventually(model.reached)
  }
  const releaseModel = async (abort = false) => {
    if (abort) root.abort()
    model!.release()
    await root.currentTurn
    model = undefined
    await settle()
  }
  const failNotice = async () => {
    f.mock.push(fail)
    root.expectNotice().deliver(notice(`retry notice ${serial++}`))
    expect((await root.currentTurn)?.reason).toBe("error")
    expect(root.noticeRetry).toMatchObject({ attempt: 1 })
  }
  const tickRetry = async (failure: boolean) => {
    const retry = root.noticeRetry!
    if (failure) f.mock.push(fail)
    else f.mock.push({ text: "retry recovered" })
    jest.advanceTimersByTime(Math.max(0, retry.at - Date.now()))
    // Assert the timer's synchronous removal too, before its replacement turn settles.
    expect(root.noticeRetry).toBeUndefined()
    checkpoint()
    await root.currentTurn
    await settle()
  }
  const spawn = (ephemeral = false, persistent = true) => {
    const child = f.session.tree.spawn(root, {
      prompt: `child work ${serial++}`,
      persistent,
      ...(ephemeral ? { ephemeral: true } : {}),
    })
    if (!ephemeral) {
      children.push(child)
    }
    return child
  }
  const rewind = async () => {
    // Real rewind rejects live public children: retire handles and wait for actual disposal.
    const retiring = f.session.tree.children
    for (const child of retiring) child.abort("property rewind")
    await Promise.all(retiring.map((child) => child.result()))
    await eventually(() => retiring.every((child) => !f.live.has(child.id)))
    await root.prompt(`stored rewind target ${serial++}`)
    const old = root
    const restoreGate = Promise.withResolvers<void>()
    f.gates.push(restoreGate.resolve)
    let restoring = false
    const unregister = f.api.registerFileRestoration({
      label: "In-memory property restoration",
      restore: async () => {
        restoring = true
        await restoreGate.promise
      },
    })
    const switched = f.commands.onSwitch((next) => {
      expect(next).not.toBe(old)
      expect(next.sessionId).toBe(old.sessionId)
      expect(f.live.get(next.sessionId)).toBe(next)
      startHold()
    })
    try {
      const index = root.messages.findIndex((message) => message.role === "user")
      const done = f.local.execute("session.rewind", { index })
      await eventually(() => restoring)
      expect(old.holdingFor).toBe("file restore")
      checkpoint()
      restoreGate.resolve()
      await done
      expect(root).not.toBe(old)
      expect(root.holdingFor).toBe("property hold")
      expect(f.live.get(root.sessionId)).toBe(root)
      // The old file-restore hold has now finished, while its replacement remains gated.
      checkpoint()
    } finally {
      switched()
      unregister()
      restoreGate.resolve()
    }
  }
  const clear = async () => {
    const old = root
    await f.local.execute("session.clear", {})
    expect(root).not.toBe(old)
    expect(root.sessionId).not.toBe(old.sessionId)
    expect(f.live.has(old.sessionId)).toBe(false)
    expect(f.publicIds).toEqual(new Set([root.sessionId]))
  }
  jest.useFakeTimers()
  try {
    // Verify the independent membership oracle detects the review's excluded-root mutation.
    const enumerate = noticeInput.noticeInputAgents
    const omitRoot = spyOn(noticeInput, "noticeInputAgents").mockImplementation((bus) =>
      enumerate(bus).filter((agent) => agent !== root),
    )
    try {
      expect(() => assertReset(f)).toThrow()
    } finally {
      omitRoot.mockRestore()
    }
    checkpoint()
    await step("same-session restoration rewind", rewind)
    await step("replacement hold release", () => releaseHold())
    await step("session clear", clear)
    // Mandatory witnesses precede random exploration so coverage never depends on luck.
    // This is review3's omitted-input path: send() to B while A owns the only slot.
    const group = f.session.tree.createGroup(root, { name: "queued witnesses", maxConcurrent: 1 })
    const gate = f.gateModel()
    const first = group.spawn({ prompt: "occupy the only slot", persistent: true })
    children.push(first)
    await eventually(gate.reached)
    const queued = group.spawn({ prompt: "wait for the slot", persistent: true })
    children.push(queued)
    if (!(queued instanceof Child)) throw new Error("Expected real queued Child")
    const queuedAgent = queued.agent
    const expectedNotice = queued.expectNotice()
    await step("queued child send", () => {
      expect(f.session.tree.subagent(queued.id)?.info.status).toBe("queued")
      expect(queued.send("UNIQUE_FOLLOWUP")).toBe(true)
      const inbox = noticeInput.noticeInputSnapshot(queuedAgent)
      // Bun's asymmetric matcher normalizes its input, even frozen objects. Never let
      // assertions mutate the live host oracle's admission identities.
      expect(json(inbox)).toMatchObject({
        queue: [{ id: expect.any(String), message: userMessage("UNIQUE_FOLLOWUP") }],
        expected: 1,
      })
      expect(typeof inbox.queue[0]!.id).toBe("string")
      const fresh = reset(f)
      expect(JSON.stringify(fresh)).toContain("UNIQUE_FOLLOWUP")
      expect(JSON.stringify(fresh)).toContain(inbox.queue[0]!.id)
      const snapshot = checkpoint()
      expect<unknown>(snapshot.owners[queued.id]!.noticeInbox).toEqual(json(inbox))
    })
    await step("queued child delivery", () => expectedNotice.deliver(notice("announced child result")))
    await step("child settlement", async () => {
      gate.release()
      await eventually(() =>
        children.every((child) => f.session.tree.subagent(child.id)?.info.status === "idle"),
      )
      expect(queuedAgent.waitingNotices).toBe(0)
      expect(JSON.stringify(f.mock.requests)).toContain("UNIQUE_FOLLOWUP")
    })

    let cancelled!: PendingNotice
    await step("notice expectation", () => {
      cancelled = root.expectNotice()
    })
    await step("notice cancellation", () => {
      cancelled.cancel()
      cancelled.deliver(notice("cancelled delivery must stay absent"))
      expect(root.expectedNotices).toBe(0)
      expect(root.waitingNotices).toBe(0)
    })
    await step("hold", startHold)
    await step("held prompt", async () => {
      await f.local.execute("turn.prompt", { message: "held user input", turnId: `property-${seed}` })
    })
    await step("held steer", () => root.steer("held steering"))
    await step("held notice", () => root.expectNotice().deliver(notice("held result")))
    await step("hold release", () => releaseHold())
    await step("hold", startHold)
    await step("held steer", () => root.steer("drop on hold abort"))
    await step("hold abort", () => releaseHold(true))
    await step("model start", startModel)
    await step("steer", () => root.steer("steering awaiting next model call"))
    await step("model notice", () => root.expectNotice().deliver(notice("during model work")))
    await step("model settlement", () => releaseModel())
    await step("model start", startModel)
    await step("model abort", () => releaseModel(true))

    await step("retry schedule", failNotice)
    await step("retry cancel", () => root.cancelNoticeRetry())
    await step("successful prompt", async () => {
      expect((await root.prompt("recover after explicit cancellation")).reason).toBe("done")
    })
    await step("retry schedule", failNotice)
    await step("successful follow-up", async () => {
      expect((await root.prompt("success cancels the scheduled retry")).reason).toBe("done")
      expect(root.noticeRetry).toBeUndefined()
    })
    await step("retry schedule", failNotice)
    await step("retry firing", () => tickRetry(true))
    expect(root.noticeRetry?.attempt).toBe(2)
    await step("retry exhaustion", () => tickRetry(true))
    expect(root.noticeRetry).toBeUndefined()
    await step("exhaustion stays idle", async () => {
      const requests = f.mock.requests.length
      jest.advanceTimersByTime(60_000)
      await settle()
      expect(f.mock.requests).toHaveLength(requests)
      expect(root.busy).toBe(false)
    })
    await step("successful prompt", () => root.prompt("reset retry streak after exhaustion"))

    let privateChild!: ChildSession
    let historical!: ChildSession
    await step("private child", async () => {
      privateChild = spawn(true)
      await eventually(() => privateChild.state === "idle")
      privateChild.expectNotice().deliver(notice("PRIVATE_INPUT_SENTINEL"), { wake: false })
      expect(f.owners().some((agent) => agent.sessionId === privateChild.id)).toBe(false)
      expect(JSON.stringify(checkpoint())).not.toContain("PRIVATE_INPUT_SENTINEL")
    })
    await step("historical child", async () => {
      historical = spawn(false, false)
      await historical.result()
      await eventually(() => !f.live.has(historical.id))
    })
    await step("jobs", () => {
      f.setJobs([
        f.job("ownerless"),
        f.job("live", queued.id),
        { ...f.job("historical", historical.id), status: "exited", exitCode: 0, endedAt: 20 },
        f.job("private", privateChild.id),
        f.job("unrelated", "not-a-visible-session"),
      ])
    })
    await step("ui request", () => {
      void f.api.ui.confirm("Authoritative pending approval")
      expect(f.session.host.ui.pending).toHaveLength(1)
    })
    await step("ui answer", async () => {
      const pending = f.session.host.ui.pending[0]!
      await f.local.request("ui.respond", { requestId: pending.requestId, value: true })
      expect(f.session.host.ui.pending).toHaveLength(0)
    })

    // Switch with live/historical/private job owners still in the host list; public job
    // identities are scoped to the newly selected root, not accumulated across sessions.
    await step("session clear", clear)
    await step("same-session restoration rewind", rewind)
    await step("replacement hold release", () => releaseHold())

    for (let i = 0; i < 60; i++) {
      // Select only enabled actions: a seed describes the same logical interleaving
      // regardless of native filesystem latency or how many microtasks a turn takes.
      const actions: { name: string; run: () => unknown | Promise<unknown> }[] = [
        { name: "expect notice", run: () => handles.push({ agent: root, pending: root.expectNotice() }) },
        {
          name: "notice",
          run: () => root.expectNotice().deliver(notice(`queued ${serial++}`), { wake: false }),
        },
        {
          name: "jobs",
          run: () => {
            const owner = [...f.publicIds][pick(f.publicIds.size)]!
            f.setJobs([
              { ...f.job("changing-owner", owner), outputChars: pick(10_000) },
              { ...f.job("ownerless"), status: "exited", exitCode: pick(8), endedAt: 30 },
              f.job("private", privateChild.id),
            ])
          },
        },
      ]
      if (handles.length) {
        actions.push(
          { name: "notice cancel", run: () => handles.splice(pick(handles.length), 1)[0]!.pending.cancel() },
          {
            name: "notice delivery",
            run: () =>
              handles
                .splice(pick(handles.length), 1)[0]!
                .pending.deliver(notice(`delivered ${serial++}`), { wake: false }),
          },
        )
      }
      if (f.session.host.ui.pending.length) {
        actions.push({
          name: "ui answer",
          run: () =>
            f.local.request("ui.respond", {
              requestId: f.session.host.ui.pending[0]!.requestId,
              value: Boolean(pick(2)),
            }),
        })
      } else {
        actions.push({
          name: "ui request",
          run: () => {
            void f.api.ui.confirm(`Approval ${serial++}`)
          },
        })
      }
      if (held) {
        actions.push(
          { name: "held steer", run: () => root.steer(`held ${serial++}`) },
          { name: "hold release", run: () => releaseHold() },
          { name: "hold abort", run: () => releaseHold(true) },
        )
        if (!heldInputSnapshot(root).some((entry) => entry.kind === "prompt")) {
          actions.push({
            name: "held prompt",
            run: () => f.local.execute("turn.prompt", { message: `prompt ${serial++}` }),
          })
        }
      } else if (model) {
        actions.push(
          { name: "steer", run: () => root.steer(`steer ${serial++}`) },
          { name: "model settlement", run: () => releaseModel() },
          { name: "model abort", run: () => releaseModel(true) },
        )
      } else if (idle()) {
        actions.push(
          { name: "hold", run: startHold },
          { name: "model start", run: startModel },
          { name: "successful prompt", run: () => root.prompt(`user ${serial++}`) },
          { name: "session clear", run: clear },
          { name: "same-session restoration rewind", run: rewind },
          {
            name: "child spawn",
            run: async () => {
              const child = spawn()
              await eventually(() => f.session.tree.subagent(child.id)?.info.status === "idle")
            },
          },
        )
        const live = children.filter(
          (child) => f.live.has(child.id) && f.session.tree.subagent(child.id)?.info.status === "idle",
        )
        if (live.length) {
          actions.push({
            name: "child send",
            run: async () => {
              const child = live[pick(live.length)]!
              expect(child.send(`follow-up ${serial++}`)).toBe(true)
              checkpoint()
              await eventually(() => f.session.tree.subagent(child.id)?.info.status === "idle")
              await settle()
            },
          })
        }
        if (root.noticeRetry) {
          actions.push(
            { name: "retry cancel", run: () => root.cancelNoticeRetry() },
            { name: "retry firing", run: () => tickRetry(Boolean(pick(2))) },
          )
        } else {
          // A successful turn resets the failure streak before another scheduled failure.
          actions.push({
            name: "retry schedule",
            run: async () => {
              await root.prompt("reset retry streak")
              await failNotice()
            },
          })
        }
      }
      const action = actions[pick(actions.length)]!
      await step(action.name, action.run)
    }
    if (held) await step("hold release", () => releaseHold())
    if (model) await step("model settlement", () => releaseModel())
    for (const { pending } of handles) pending.cancel()
    f.session.host.ui.cancelAll()
    root.cancelNoticeRetry()
    await step("final settlement", () => root.prompt("finish all accepted inputs"))
    expect(root.waitingNotices).toBe(0)
    expect(heldInputSnapshot(root)).toEqual([])
    expect(noticeInput.steeringInputSnapshot(root)).toEqual([])
    for (const required of [
      "queued child send",
      "queued child delivery",
      "child settlement",
      "notice expectation",
      "notice cancellation",
      "hold",
      "held prompt",
      "held steer",
      "held notice",
      "hold release",
      "hold abort",
      "model start",
      "steer",
      "model notice",
      "model settlement",
      "model abort",
      "retry schedule",
      "retry cancel",
      "successful follow-up",
      "retry firing",
      "retry exhaustion",
      "exhaustion stays idle",
      "private child",
      "historical child",
      "jobs",
      "ui request",
      "ui answer",
      "same-session restoration rewind",
      "replacement hold release",
      "session clear",
      "final settlement",
    ])
      expect(covered.has(required)).toBe(true)
  } catch (error) {
    console.error(`RESET property seed=0x${seed.toString(16)} actions=${JSON.stringify(history)}`)
    throw error
  } finally {
    for (const release of f.gates) release()
    root.cancelNoticeRetry()
    offSwitch()
    replay.close()
    jest.useRealTimers()
    await f.close()
  }
}

test("fresh RESET matches authoritative owners and host state across seeded input/retry/lifecycle interleavings", async () => {
  for (const seed of [0x4a17, 0x73b9, 0xc0ffee]) await runSeed(seed)
}, 30_000)
