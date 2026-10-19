import "../server/offline.ts"
import { expect, test } from "bun:test"
import { encodeRemoteMessage, RemoteDecoder } from "../../src/remote/codec.ts"
import type { RemoteMessage, RemoteReset } from "../../src/remote/protocol.ts"
import {
  type RemoteJobInfo,
  type RemoteWorkspaceSnapshot,
  validateRemoteDto,
  validateRemoteFrame,
} from "../../src/remote-schema.ts"
import { hello, welcome } from "./loopback.ts"
import { eventFixtures } from "./schema-events.ts"
import { operationFixtures, snapshot, usage } from "./schema-fixtures.ts"

const job = {
  id: "job-1",
  command: "bun test",
  kind: "monitor",
  cwd: "/srv/project",
  owner: "child-1",
  startedAt: 1,
  status: "exited",
  pid: 123,
  contained: true,
  exitCode: 0,
  signal: null,
  endedAt: 2,
  stopRequested: false,
  outputChars: 120,
} satisfies RemoteJobInfo
const core = {
  seq: 3,
  ts: 12,
  sessionId: "child-1",
  parentSessionId: "root-1",
  turnId: "turn-1",
  type: "tool.execute.start",
  data: eventFixtures["tool.execute.start"],
}
const semantic = {
  status: { ...operationFixtures["status.read"].result, budget: { tokens: 100, costUsd: 1 } },
  models: operationFixtures["models.list"].result,
  subagents: [
    {
      id: "child-1",
      parentSessionId: "s1",
      depth: 1,
      role: "coder",
      title: "Task",
      task: "Implement task",
      status: "running",
      usage,
      groupId: "g1",
    },
  ],
  groups: [
    {
      ...eventFixtures["group.start"].group,
      limits: { maxConcurrent: 2, maxAgents: 4, budget: { tokens: 50 }, maxTurnsPerAgent: 3 },
      compact: true,
      status: "Working",
      agents: { ...eventFixtures["group.start"].group.agents, paused: 0 },
      outcomes: { done: 0, failed: 0, stopped: 0 },
      endReason: "Requested",
      exceeded: false,
    },
  ],
} satisfies RemoteWorkspaceSnapshot["semantic"]
const owner = {
  status: "idle" as const,
  busy: false,
  turnId: null,
  hold: null,
  steering: [],
  noticeRetry: null,
  inputQueue: [
    {
      id: "input-1",
      holdId: "hold-1",
      kind: "prompt" as const,
      message: { role: "user" as const, content: [{ type: "text" as const, text: "queued" }] },
      turnId: "turn-2",
    },
  ],
  noticeInbox: {
    queue: [
      {
        id: "notice-1",
        message: { role: "user" as const, content: [{ type: "text" as const, text: "notice" }] },
      },
    ],
    expected: 1,
  },
}
const workspace = {
  frontend: snapshot,
  semantic,
  pendingRequests: [eventFixtures["ui.request"]],
  startupEvents: [core],
  activity: { events: [core] },
  owners: { [snapshot.state.sessionId]: owner },
  jobs: [job],
}
const reset: RemoteReset = {
  v: 1,
  kind: "reset",
  daemonEpoch: "epoch-1",
  seq: 8,
  reason: "fresh",
  snapshot: workspace,
}
function roundtrip(message: RemoteMessage) {
  const decoder = new RemoteDecoder()
  const decoded = [...encodeRemoteMessage(message)].flatMap((bytes) => decoder.push(bytes))
  decoder.finish()
  expect(decoded).toEqual([message])
}

test("every reset reason roundtrips a closed workspace snapshot with original core envelopes", () => {
  validateRemoteDto("workspaceSnapshot", workspace)
  for (const reason of [
    "fresh",
    "epoch_changed",
    "cursor_expired",
    "future_cursor",
    "capture_failed",
  ] as const)
    roundtrip({ ...reset, reason })
  for (const invalid of [
    { ...reset, reason: "unknown" },
    { ...reset, seq: -1 },
    { ...reset, daemonEpoch: "" },
    { ...reset, unexpected: true },
  ])
    expect(() => validateRemoteFrame(invalid)).toThrow()
})

test("workspace snapshots reject missing and unknown fields, including nested DTOs", () => {
  for (const key of Object.keys(workspace)) {
    const missing = Object.fromEntries(Object.entries(workspace).filter(([name]) => name !== key))
    expect(() => validateRemoteDto("workspaceSnapshot", missing)).toThrow()
    expect(() => validateRemoteFrame({ ...reset, snapshot: missing })).toThrow()
  }
  for (const invalid of [
    {},
    { ...workspace, unexpected: true },
    { ...workspace, frontend: { ...snapshot, unexpected: true } },
    { ...workspace, pendingRequests: [{ ...workspace.pendingRequests[0], unexpected: true }] },
    { ...workspace, startupEvents: [{ ...core, unexpected: true }] },
    { ...workspace, activity: { events: [core], unexpected: true } },
    { ...workspace, activity: { events: [{ ...core, data: { ...core.data, unexpected: true } }] } },
    { ...workspace, activity: { events: [core.data] } },
    { ...workspace, jobs: [{ ...job, unexpected: true }] },
  ]) {
    expect(() => validateRemoteDto("workspaceSnapshot", invalid)).toThrow()
    expect(() => validateRemoteFrame({ ...reset, snapshot: invalid })).toThrow()
  }
})

test("workspace semantic state requires status, models, subagents, and strict spawn groups", () => {
  for (const key of Object.keys(semantic)) {
    const missing = Object.fromEntries(Object.entries(semantic).filter(([name]) => name !== key))
    expect(() => validateRemoteDto("workspaceSnapshot", { ...workspace, semantic: missing })).toThrow()
    expect(() => validateRemoteFrame({ ...reset, snapshot: { ...workspace, semantic: missing } })).toThrow()
  }
  for (const invalid of [
    { ...semantic, unexpected: true },
    { ...semantic, status: { ...semantic.status, unexpected: true } },
    { ...semantic, status: { ...semantic.status, info: {} } },
    { ...semantic, status: { ...semantic.status, budget: { tokens: "100" } } },
    { ...semantic, models: [{ ...semantic.models[0], unexpected: true }] },
    { ...semantic, subagents: [{ ...semantic.subagents[0], unexpected: true }] },
    { ...semantic, subagents: [{ ...semantic.subagents[0], status: "unknown" }] },
    { ...semantic, groups: [{}] },
    { ...semantic, groups: [{ ...semantic.groups[0], unexpected: true }] },
    { ...semantic, groups: [{ ...semantic.groups[0], state: "unknown" }] },
    { ...semantic, groups: [{ ...semantic.groups[0], limits: { unexpected: true } }] },
    { ...semantic, groups: [{ ...semantic.groups[0], limits: { budget: { unexpected: true } } }] },
    { ...semantic, groups: [{ ...semantic.groups[0], agents: { total: 1 } }] },
    { ...semantic, groups: [{ ...semantic.groups[0], outcomes: { done: 0, failed: 0 } }] },
  ]) {
    expect(() => validateRemoteDto("workspaceSnapshot", { ...workspace, semantic: invalid })).toThrow()
    expect(() => validateRemoteFrame({ ...reset, snapshot: { ...workspace, semantic: invalid } })).toThrow()
  }
  validateRemoteDto("workspaceSnapshot", {
    ...workspace,
    semantic: { ...semantic, groups: [eventFixtures["group.start"].group] },
  })
  validateRemoteDto("workspaceSnapshot", {
    ...workspace,
    semantic: {
      status: operationFixtures["status.read"].result,
      models: [],
      subagents: [],
      groups: [],
    },
  })
})

test("job events allow explicit public fields only, never opaque metadata or host log/error fields", () => {
  validateRemoteDto("backgroundJob", job)
  roundtrip({ v: 1, kind: "event", daemonEpoch: "epoch-1", seq: 9, payload: { kind: "jobs", jobs: [job] } })
  for (const invalid of [
    { ...job, meta: { secret: "hidden" } },
    { ...job, logPath: "/host/private/log" },
    { ...job, logError: "private error" },
    { ...job, error: "private error" },
    { ...job, status: "unknown" },
    { ...job, kind: "unknown" },
    { ...job, outputChars: -1 },
    { ...job, pid: "123" },
    {},
  ]) {
    expect(() => validateRemoteDto("backgroundJob", invalid)).toThrow()
    expect(() =>
      validateRemoteFrame({
        v: 1,
        kind: "event",
        daemonEpoch: "epoch-1",
        seq: 9,
        payload: { kind: "jobs", jobs: [invalid] },
      }),
    ).toThrow()
  }
  const { kind: _kind, owner: _owner, pid: _pid, endedAt: _endedAt, ...minimal } = job
  validateRemoteDto("backgroundJob", { ...minimal, status: "running", exitCode: null, signal: "SIGTERM" })
})

test("large reset snapshots use the existing chunk transfer without changing the ACK envelope", () => {
  roundtrip({
    ...reset,
    snapshot: {
      ...workspace,
      frontend: {
        ...snapshot,
        transcript: {
          messages: [],
          displays: [{ id: "d1", before: 0, level: "info", text: "x".repeat(400_000), options: {} }],
        },
      },
    },
  })
  roundtrip({ v: 1, kind: "ack", channel: "control", id: "epoch-1", seq: 8 })
})

test("optional retained-state, controller token, and cancel generation fields remain backwards compatible", () => {
  roundtrip(hello)
  roundtrip(welcome)
  roundtrip({
    ...hello,
    snapshot: true,
    resume: { daemonEpoch: "epoch-1", after: 8, controllerToken: "token-1" },
  })
  roundtrip({ ...hello, snapshot: false })
  roundtrip({ ...welcome, controllerToken: "token-1" })
  roundtrip({ v: 1, kind: "cancel", channel: "control", id: "op-1" })
  roundtrip({
    v: 1,
    kind: "cancel",
    channel: "control",
    id: "op-1",
    controllerGeneration: 2,
    sessionGeneration: 3,
  })
  for (const invalid of [
    { ...hello, snapshot: "true" },
    { ...welcome, controllerToken: "" },
    { v: 1, kind: "cancel", channel: "control", id: "op-1", controllerGeneration: -1 },
    { v: 1, kind: "cancel", channel: "control", id: "op-1", sessionGeneration: "3" },
  ])
    expect(() => validateRemoteFrame(invalid)).toThrow()
})

test("held input snapshots and sequenced queue updates cross the codec without losing identities", () => {
  const event: RemoteMessage = {
    v: 1,
    kind: "event",
    daemonEpoch: "epoch-1",
    seq: 10,
    payload: {
      kind: "inputQueue",
      sessionId: "root-1",
      sessionGeneration: 1,
      inputQueue: owner.inputQueue,
    },
  }
  roundtrip(reset)
  roundtrip(event)
  roundtrip({
    ...event,
    payload: { kind: "inputQueue", sessionId: "root-1", sessionGeneration: 1, inputQueue: [] },
  })
  for (const inputQueue of [
    [{ ...owner.inputQueue[0], holdId: 7 }],
    [{ ...owner.inputQueue[0], message: { role: "user", content: [], callback: "forbidden" } }],
    [{ ...owner.inputQueue[0], ignored: true }],
  ])
    expect(() =>
      validateRemoteDto("workspaceSnapshot", {
        ...workspace,
        owners: { [snapshot.state.sessionId]: { ...owner, inputQueue } },
      }),
    ).toThrow()
  expect(() => validateRemoteFrame({ ...event, payload: { kind: "inputQueue", inputQueue: [] } })).toThrow()
})

test("notice inbox admissions and removals are scoped finite wire state", () => {
  validateRemoteDto("noticeInbox", owner.noticeInbox)
  const envelope = {
    v: 1 as const,
    kind: "event" as const,
    daemonEpoch: "epoch-1",
    seq: 20,
    payload: {
      kind: "noticeInbox",
      sessionId: "root-1",
      sessionGeneration: 1,
      noticeInbox: owner.noticeInbox,
    },
  }
  roundtrip(envelope)
  roundtrip({ ...envelope, payload: { ...envelope.payload, noticeInbox: { queue: [], expected: 0 } } })
  for (const noticeInbox of [
    { ...owner.noticeInbox, expected: -1 },
    { ...owner.noticeInbox, unexpected: true },
    {
      ...owner.noticeInbox,
      queue: [{ id: "one", message: { role: "user", content: [], callback: "forbidden" } }],
    },
    { queue: [] },
  ])
    expect(() =>
      validateRemoteDto("workspaceSnapshot", {
        ...workspace,
        owners: { [snapshot.state.sessionId]: { ...owner, noticeInbox } },
      }),
    ).toThrow()
})

test("reset owners are keyed complete host records, not optional root-only queue aliases", () => {
  validateRemoteDto("ownerState", owner)
  for (const field of Object.keys(owner)) {
    const missing = Object.fromEntries(Object.entries(owner).filter(([key]) => key !== field))
    expect(() =>
      validateRemoteDto("workspaceSnapshot", { ...workspace, owners: { root: missing } }),
    ).toThrow()
  }
  expect(() => validateRemoteDto("workspaceSnapshot", { ...workspace, owners: [] })).toThrow()
  expect(() => validateRemoteDto("workspaceSnapshot", { ...workspace, inputQueue: [] })).toThrow()
  expect(() =>
    validateRemoteDto("workspaceSnapshot", { ...workspace, noticeInbox: owner.noticeInbox }),
  ).toThrow()
  const base = { v: 1 as const, kind: "event" as const, daemonEpoch: "epoch", seq: 25 }
  for (const noticeRetry of [null, { attempt: 2, at: 1000 }])
    roundtrip({
      ...base,
      payload: { kind: "noticeRetry", sessionId: "root", sessionGeneration: 1, noticeRetry },
    })
  for (const hold of [null, { id: "hold-1", what: "compaction" }])
    roundtrip({ ...base, payload: { kind: "hold", sessionId: "root", sessionGeneration: 1, hold } })
  roundtrip({
    ...base,
    payload: {
      kind: "steering",
      sessionId: "root",
      sessionGeneration: 1,
      steering: [owner.inputQueue[0]!.message],
    },
  })
})
