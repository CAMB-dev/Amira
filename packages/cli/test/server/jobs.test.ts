import "./offline.ts"
import { expect, test } from "bun:test"
import { SessionBackgroundJobHost } from "@amira/core"
import { type JobEvent, JobRegistry } from "@amira/proc"
import { validateRemoteParams, validateRemoteResult } from "../../src/remote-schema.ts"
import { createServerJobs } from "../../src/server/jobs.ts"

function fixture() {
  const emitters: ((event: JobEvent) => void)[] = []
  const host = new SessionBackgroundJobHost(
    new JobRegistry({
      bufferChars: 12,
      start: (_spec, emit) => {
        emitters.push(emit)
        emit({ type: "spawned", pid: 123, contained: true })
        return { stop: () => emit({ type: "exit", code: null, signal: "SIGTERM" }) }
      },
    }),
  )
  const root = host.forSession({ sessionId: "root", depth: 0 })
  const child = host.forSession({ sessionId: "child", parentSessionId: "root", depth: 1 })
  const foreign = host.forSession({ sessionId: "foreign", depth: 0 })
  let generation = 1
  const service = createServerJobs({
    jobs: () => root,
    generation: () => generation,
    visible: (job, scope) => !scope.conversationId || job.owner === scope.conversationId,
  })
  const start = (jobs: typeof root) =>
    jobs.start({
      command: "fake",
      argv: ["not-executed"],
      cwd: "/linux/work",
      meta: { secret: "DO_NOT_PROJECT" },
    })
  return { host, root, child, foreign, service, start, emitters, switch: () => generation++ }
}

test("job snapshots, lifecycle notifications and controls are session/conversation scoped", async () => {
  const f = fixture()
  const changes: unknown[] = []
  const off = f.service.subscribe((change) => changes.push(change))
  try {
    const own = f.start(f.root)
    const child = f.start(f.child)
    const hidden = f.start(f.foreign)
    expect(f.service.handlers["jobs.list"]({}).jobs.map((job) => job.id)).toEqual([own.id, child.id])
    expect(f.service.handlers["jobs.list"]({ conversationId: "child" }).jobs.map((job) => job.id)).toEqual([
      child.id,
    ])
    expect(() => f.service.handlers["jobs.output"]({ id: hidden.id })).toThrow("unavailable")
    expect(() => f.service.handlers["jobs.output"]({ id: own.id, conversationId: "child" })).toThrow(
      "unavailable",
    )
    expect(JSON.stringify(changes)).not.toContain("DO_NOT_PROJECT")
    expect(changes).toHaveLength(4)
    for (const job of f.service.handlers["jobs.list"]({}).jobs) validateRemoteResult("jobs.stop", job)
    const stopped = await f.service.handlers["jobs.stop"]({ id: own.id, graceMs: 0 })
    expect(stopped.status).toBe("stopped")
    expect(f.host.get(hidden.id)!.stopRequested).toBe(false)
    const cut = changes.length
    f.switch()
    f.emitters[1]!({ type: "output", data: "old" })
    expect(changes).toHaveLength(cut)
  } finally {
    off()
    await f.host.stopAll(undefined, 0)
  }
})

test("bounded output uses caller-owned offsets and reports buffer loss separately from pagination", async () => {
  const f = fixture()
  try {
    const job = f.start(f.root)
    f.emitters[0]!({ type: "output", data: "0123456789abcdef" })
    const first = f.service.handlers["jobs.output"]({ id: job.id, from: 0, maxChars: 5 })
    expect(first).toEqual({ text: "45678", from: 4, to: 9, dropped: 4, availableTo: 16, truncated: true })
    const second = f.service.handlers["jobs.output"]({ id: job.id, from: first.to, maxChars: 5 })
    expect(second).toEqual({ text: "9abcd", from: 9, to: 14, dropped: 0, availableTo: 16, truncated: true })
    expect(f.service.handlers["jobs.output"]({ id: job.id, from: second.to })).toMatchObject({
      text: "ef",
      to: 16,
      truncated: false,
    })
    expect(f.root.cursor(job.id, "tools")).toBe(0)
    expect(() => f.service.handlers["jobs.output"]({ id: job.id, from: 17 })).toThrow("ahead")
    validateRemoteResult("jobs.output", first)
  } finally {
    await f.host.stopAll(undefined, 0)
  }
})

test("wait matches literals, times out, aborts and stops without spawning processes", async () => {
  const f = fixture()
  try {
    const job = f.start(f.root)
    const wait = f.service.handlers["jobs.wait"]({ id: job.id, contains: "[ok]", timeoutMs: 1000 })
    f.emitters[0]!({ type: "output", data: "[ok]\n" })
    expect(await wait).toEqual({ reason: "match", line: "[ok]" })
    expect(await f.service.handlers["jobs.wait"]({ id: job.id, contains: "no", timeoutMs: 0 })).toEqual({
      reason: "timeout",
    })
    const abort = new AbortController()
    const pending = f.service.handlers["jobs.wait"]({ id: job.id, timeoutMs: 1000 }, abort.signal)
    abort.abort()
    expect(await pending).toEqual({ reason: "aborted" })
    const ending = f.service.handlers["jobs.wait"]({ id: job.id, timeoutMs: 1000 })
    await f.service.handlers["jobs.stop"]({ id: job.id, graceMs: 0 })
    expect(await ending).toEqual({ reason: "exit" })
  } finally {
    await f.host.stopAll(undefined, 0)
  }
})

test("server task schemas reject unbounded or executable requests", () => {
  for (const params of [
    { id: "j", maxChars: 32_769 },
    { id: "j", from: -1 },
    { id: "j", reader: "shared" },
  ])
    expect(() => validateRemoteParams("jobs.output", params)).toThrow()
  expect(() => validateRemoteParams("jobs.wait", { id: "j", timeoutMs: 600_001 })).toThrow()
  expect(() => validateRemoteParams("jobs.wait", { id: "j", timeoutMs: 0, pattern: ".*" })).toThrow()
  expect(() => validateRemoteParams("jobs.stop", { id: "j", graceMs: 10_001 })).toThrow()
  expect(() =>
    validateRemoteParams("conversations.control", { conversationId: "c", action: "message" }),
  ).toThrow()
  expect(() =>
    validateRemoteParams("conversations.control", { conversationId: "c", action: "stop", text: "extra" }),
  ).toThrow()
})
