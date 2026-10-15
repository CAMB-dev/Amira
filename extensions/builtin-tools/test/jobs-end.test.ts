import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import type { BackgroundJobDetails, UserMessage } from "@amira/api"
import { defineTool } from "@amira/api"
import { createAi, createMockDialect, type MockStep } from "../../../packages/ai/src/index.ts"
import { Agent, SessionBackgroundJobHost } from "../../../packages/core/src/index.ts"
import { type JobEvent, JobRegistry } from "../../../packages/proc/src/index.ts"
import { jobIsWatched, jobOutputTool, jobStopTool, startBackground, watchJobEnds } from "../src/jobs.ts"
import type { Shell } from "../src/shell.ts"
import { makeCtx, tempDirs } from "./util.ts"

const tmp = tempDirs()
let dir: string
const cleanup: (() => void | Promise<void>)[] = []
beforeAll(async () => {
  dir = await tmp.make("amira-job-ends-")
})
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop()
})
afterAll(() => tmp.cleanup())

const shell: Shell = {
  kind: "bash",
  path: "fake-shell",
  command: (command, cwd) => ({ argv: [command], cwd, env: {}, gated: false }),
}

function setup(steps: MockStep[]) {
  const emitters: ((event: JobEvent) => void)[] = []
  const host = new SessionBackgroundJobHost(
    new JobRegistry({
      maxRunning: 64,
      start(_spec, emit) {
        emitters.push(emit)
        emit({ type: "spawned", pid: emitters.length, contained: true })
        return { stop: () => emit({ type: "exit", code: null, signal: null }) }
      },
    }),
  )
  const mock = createMockDialect(steps)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const agent = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: dir,
    systemPrompt: "",
    backgroundJobs: host,
  })
  const startTool = defineTool<{ count: number; command?: string }>({
    name: "start_jobs",
    description: "",
    parameters: {},
    async execute({ count, command }, ctx) {
      const results = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          startBackground("bash", shell, `${command ?? "build"}-${i}`, {
            ...ctx,
            // Separate tool calls have separate session facades, but the same owner.
            ...(ctx.session ? { session: { ...ctx.session, dir } } : {}),
          }),
        ),
      )
      return {
        content: [
          { type: "text", text: results.map((r) => (r.details as BackgroundJobDetails).jobId).join(", ") },
        ],
      }
    },
  })
  agent.tools.register(startTool, "test")
  cleanup.push(
    () => agent.dispose(),
    () => host.stopAll(undefined, 0).then(() => {}),
  )
  const off = watchJobEnds(host)
  cleanup.push(off)
  return {
    agent,
    ai,
    mock,
    host,
    off,
    startTool,
    emit: (id: string, event: JobEvent) => emitters[Number(id.slice(3)) - 1]!(event),
    end: (id: string) => emitters[Number(id.slice(3)) - 1]!({ type: "exit", code: 0, signal: null }),
  }
}

const startSteps = (count: number): MockStep[] => [
  { toolCalls: [{ name: "start_jobs", args: { count } }] },
  { text: "started" },
]
const textOf = (message: UserMessage) =>
  message.content.map((part) => (part.type === "text" ? part.text : "")).join("")

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for job-end notice")
    await Bun.sleep(5)
  }
}

for (const busy of [false, true]) {
  for (const spreadMs of [0, 30]) {
    test(`16 ordinary completions over ${spreadMs} ms send one notice to a ${busy ? "busy" : "fast idle"} Agent`, async () => {
      const steps: MockStep[] = busy
        ? [startSteps(16)[0]!, { toolCalls: [{ name: "work", args: {} }] }, { text: "handled" }]
        : [...startSteps(16), ...Array.from({ length: 20 }, () => ({ text: "handled" }))]
      const s = setup(steps)
      let release!: () => void
      let working = false
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      s.agent.tools.register(
        defineTool({
          name: "work",
          description: "",
          parameters: {},
          async execute() {
            working = true
            await held
            return { content: [] }
          },
        }),
        "test",
      )
      const run = s.agent.prompt("start jobs")
      try {
        if (busy) await until(() => working)
        else await run
        const ids = s.host.list().map((job) => job.id)
        expect(ids).toHaveLength(16)
        await Promise.all(
          ids.map(
            (id, i) =>
              new Promise<void>((resolve) => {
                setTimeout(
                  () => {
                    s.end(id)
                    resolve()
                  },
                  (i * spreadMs) / 15,
                )
              }),
          ),
        )
        await Bun.sleep(160)
        if (busy) expect(s.agent.waitingNotices).toBe(1)
        release()
        await run
        await until(() => !s.agent.busy)
        expect(s.mock.requests).toHaveLength(3)
        const notices = s.agent.messages.filter(
          (message) => message.role === "user" && message.display?.origin === "job",
        )
        expect(notices).toHaveLength(1)
        const message = notices[0]!
        expect(message.role).toBe("user")
        if (message.role !== "user") throw new Error("expected a user notice")
        expect(message.content).toHaveLength(1)
        for (const id of ids) expect(textOf(message)).toContain(`Background job ${id} `)
        expect(s.agent.expectedNotices).toBe(0)
        expect(s.agent.waitingNotices).toBe(0)
      } finally {
        release()
        await run
      }
    })
  }
}

test("the first completion reserves one print-mode notice synchronously; unsubscribe cancels the batch", async () => {
  const s = setup(startSteps(2))
  await s.agent.prompt("start jobs")
  s.end("job1")
  expect(s.agent.expectedNotices).toBe(1)
  expect(s.mock.requests).toHaveLength(2)
  s.off()
  s.off()
  expect(s.agent.expectedNotices).toBe(0)
  s.end("job2")
  await Bun.sleep(160)
  expect(s.mock.requests).toHaveLength(2)
  expect(s.agent.waitingNotices).toBe(0)
})

test("a queued batch and subsequent completions follow the replacement Agent", async () => {
  const s = setup([...startSteps(2), { text: "handled by replacement" }])
  await s.agent.prompt("start jobs")
  s.end("job1")
  const next = new Agent({
    ai: s.ai,
    model: s.ai.model("mock/m"),
    cwd: dir,
    systemPrompt: "",
    backgroundJobs: s.host,
  })
  cleanup.push(() => next.dispose())
  s.agent.handoverBackgroundNotices(next)
  await s.host.handoverRoot(s.agent.sessionId, next.sessionId, 0)
  await s.agent.dispose("switch")
  expect(next.expectedNotices).toBe(1)
  s.end("job2")
  await until(() => s.mock.requests.length === 3 && !next.busy)
  expect(next.expectedNotices).toBe(0)
  const message = s.mock.requests[2]!.messages.at(-1)!
  expect(message.role).toBe("user")
  if (message.role !== "user") throw new Error("expected a user notice")
  expect(message.content).toHaveLength(1)
  expect(textOf(message)).toContain("Background job job1 ")
  expect(textOf(message)).toContain("Background job job2 ")
  expect(s.agent.currentTurn).toBeUndefined()
})

test("suppression is captured on end, not after output waits and stop calls release their watches", async () => {
  const s = setup([...startSteps(4), { text: "handled unwatched job" }])
  await s.agent.prompt("start jobs")
  const ctx = {
    ...makeCtx(dir),
    backgroundJobs: s.host.forSession({ sessionId: s.agent.sessionId, depth: 0 }),
  }
  const observed: { id: string; watched: boolean; stopped: boolean }[] = []
  const off = s.host.subscribe(({ type, job }) => {
    if (type === "end")
      observed.push({ id: job.id, watched: jobIsWatched(job.id), stopped: job.stopRequested })
  })
  cleanup.push(off)
  const reads = [1, 2].map(() => jobOutputTool.execute({ job_id: "job1", timeout: 1000 }, ctx))
  expect(jobIsWatched("job1")).toBe(true)
  s.end("job1")
  await Promise.all(reads)
  expect(jobIsWatched("job1")).toBe(false)
  s.end("job2")
  // Reading after the natural end must not erase an already queued completion.
  await jobOutputTool.execute({ job_id: "job2", timeout: 1000 }, ctx)
  await jobStopTool.execute({ job_id: "job3" }, ctx)
  await s.host.stop("job4", 0)
  expect(observed).toEqual([
    { id: "job1", watched: true, stopped: false },
    { id: "job2", watched: false, stopped: false },
    { id: "job3", watched: true, stopped: true },
    { id: "job4", watched: false, stopped: true },
  ])
  await until(() => s.mock.requests.length === 3 && !s.agent.busy)
  await Bun.sleep(120)
  expect(s.mock.requests).toHaveLength(3)
  const message = s.mock.requests[2]!.messages.at(-1)!
  if (message.role !== "user") throw new Error("expected a user notice")
  expect(textOf(message)).toContain("Background job job2 ")
  for (const id of ["job1", "job3", "job4"]) expect(textOf(message)).not.toContain(`Background job ${id} `)
})

test("startup waits suppress immediate job ends through the same shared watch helper", async () => {
  const s = setup(startSteps(2))
  const run = s.agent.prompt("start jobs")
  await until(() => s.host.running().length === 2)
  for (const job of s.host.running()) {
    expect(jobIsWatched(job.id)).toBe(true)
    s.end(job.id)
  }
  await run
  await Bun.sleep(160)
  expect(s.mock.requests).toHaveLength(2)
  expect(s.agent.expectedNotices).toBe(0)
  expect(jobIsWatched("job1")).toBe(false)
  expect(jobIsWatched("job2")).toBe(false)
})

test("a fixed batch window flushes even when another completion arrives near its deadline", async () => {
  const s = setup([...startSteps(3), { text: "first batch" }, { text: "second batch" }])
  await s.agent.prompt("start jobs")
  s.end("job1")
  await Bun.sleep(60)
  s.end("job2")
  await Bun.sleep(65)
  expect(s.mock.requests).toHaveLength(3)
  expect(s.host.get("job3")!.status).toBe("running")
  s.end("job3")
  await until(() => s.mock.requests.length === 4 && !s.agent.busy)
})

test("a UTF-8 batch bounds optional commands, failure details and output without dropping completion IDs", async () => {
  const s = setup([
    { toolCalls: [{ name: "start_jobs", args: { count: 16, command: "界".repeat(5000) } }] },
    { text: "started" },
    { text: "handled" },
  ])
  await s.agent.prompt("start jobs")
  for (const job of s.host.list()) {
    s.emit(job.id, { type: "output", data: "界".repeat(5000) })
    s.emit(job.id, { type: "exit", code: null, signal: null, error: "失敗".repeat(5000) })
  }
  await until(() => s.mock.requests.length === 3 && !s.agent.busy)
  const message = s.mock.requests[2]!.messages.at(-1)!
  if (message.role !== "user") throw new Error("expected a user notice")
  const text = textOf(message)
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096)
  expect(text).not.toContain("\uFFFD")
  for (const job of s.host.list())
    expect(text.match(new RegExp(`Background job ${job.id} `, "g"))).toHaveLength(1)
  expect(s.agent.expectedNotices).toBe(0)
})

test("one registry batches independently for each owning Agent without mixing completion IDs", async () => {
  const s = setup([
    ...startSteps(2),
    ...startSteps(2),
    { text: "first owner handled" },
    { text: "second owner handled" },
  ])
  const other = new Agent({
    ai: s.ai,
    model: s.ai.model("mock/m"),
    cwd: dir,
    systemPrompt: "",
    backgroundJobs: s.host,
  })
  other.tools.register(s.startTool, "test")
  cleanup.push(() => other.dispose())
  await s.agent.prompt("start jobs")
  await other.prompt("start jobs")
  for (const id of ["job1", "job3", "job2", "job4"]) s.end(id)
  expect(s.agent.expectedNotices).toBe(1)
  expect(other.expectedNotices).toBe(1)
  await until(() => s.mock.requests.length === 6 && !s.agent.busy && !other.busy)
  for (const [owner, ids, absent] of [
    [s.agent, ["job1", "job2"], "job3"],
    [other, ["job3", "job4"], "job1"],
  ] as const) {
    const notices = owner.messages.filter(
      (message) => message.role === "user" && message.display?.origin === "job",
    )
    expect(notices).toHaveLength(1)
    const message = notices[0]!
    if (message.role !== "user") throw new Error("expected a user notice")
    for (const id of ids) expect(textOf(message)).toContain(`Background job ${id} `)
    expect(textOf(message)).not.toContain(`Background job ${absent} `)
    expect(owner.expectedNotices).toBe(0)
  }
})

test("large synchronous batches retain every completion ID even after ended jobs are pruned", async () => {
  const s = setup([...startSteps(128), { text: "handled" }])
  s.host.configure({ maxRunning: 128 })
  await s.agent.prompt("start jobs")
  const ids = s.host.list().map((job) => job.id)
  for (const id of ids) s.end(id)
  expect(s.host.list()).toHaveLength(50)
  expect(s.agent.expectedNotices).toBe(1)
  await until(() => s.mock.requests.length === 3 && !s.agent.busy)
  const message = s.mock.requests[2]!.messages.at(-1)!
  if (message.role !== "user") throw new Error("expected a user notice")
  const text = textOf(message)
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096)
  for (const id of ids) expect(text).toContain(`Background job ${id} `)
  expect(s.agent.expectedNotices).toBe(0)
})
