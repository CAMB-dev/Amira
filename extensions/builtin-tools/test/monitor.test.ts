import { afterEach, expect, test } from "bun:test"
import { type BackgroundJobDetails, defineTool, type ToolSession, type UserMessage } from "@amira/api"
import { createAi, createMockDialect } from "../../../packages/ai/src/index.ts"
import { Agent, SessionBackgroundJobHost } from "../../../packages/core/src/index.ts"
import { Permissions } from "../../../packages/core/src/permissions/policy.ts"
import { type JobEvent, JobRegistry } from "../../../packages/proc/src/index.ts"
import { jobOutputTool, jobStopTool, jobsConfig, startBackground, watchJobEnds } from "../src/jobs.ts"
import { createMonitorTool, MAX_MONITOR_TIMEOUT_MS } from "../src/monitor.ts"
import { MAX_MONITOR_LINE_CHARS } from "../src/monitor-events.ts"
import type { Shell } from "../src/shell.ts"
import { makeCtx, textOf } from "./util.ts"

const hosts: SessionBackgroundJobHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stopAll(undefined, 0)
  await Bun.sleep(0)
})

const shell: Shell = {
  kind: "bash",
  path: "fake-shell",
  command: (command, cwd) => ({ argv: [command], cwd, env: {}, gated: false }),
}

function setup(
  options: {
    filter?: string
    timeout_ms?: number
    intervalMs?: number
    sessionId?: string
    depth?: number
    bufferChars?: number
    keepEnded?: number
    maxRunning?: number
    stopDelayMs?: number
    sync?: (emit: (e: JobEvent) => void) => void
  } = {},
) {
  let emit!: (event: JobEvent) => void
  const processes: ((event: JobEvent) => void)[] = []
  const host = new SessionBackgroundJobHost(
    new JobRegistry({
      bufferChars: options.bufferChars,
      keepEnded: options.keepEnded,
      maxRunning: options.maxRunning,
      start(_spec, onEvent) {
        emit = onEvent
        processes.push(onEvent)
        onEvent({ type: "spawned", pid: 42, contained: true })
        options.sync?.(onEvent)
        return {
          stop(graceMs) {
            const end = () => onEvent({ type: "exit", code: null, signal: null })
            if (graceMs > 0 && options.stopDelayMs) setTimeout(end, options.stopDelayMs)
            else end()
          },
        }
      },
    }),
  )
  hosts.push(host)
  const deliveries: { message: UserMessage; wake?: boolean }[] = []
  let expected = 0
  const sessionId = options.sessionId ?? "main"
  const depth = options.depth ?? 0
  const session: ToolSession = {
    sessionId,
    depth,
    maxDepth: 2,
    model: { provider: "mock", model: "m" },
    deferredTools: () => [],
    loadTools: () => [],
    expectNotice() {
      expected++
      let open = true
      return {
        deliver(message, opts) {
          if (!open) return
          open = false
          expected--
          deliveries.push({ message, wake: opts?.wake })
        },
        cancel() {
          if (open) expected--
          open = false
        },
      }
    },
  }
  const registry = host.forSession({ sessionId, depth, ...(depth ? { parentSessionId: "main" } : {}) })
  const ctx = { ...makeCtx(process.cwd()), backgroundJobs: registry, session }
  const tool = createMonitorTool(async () => shell, { batchMs: 10, intervalMs: options.intervalMs ?? 20 })
  const start = () =>
    tool.execute(
      {
        command: "watch",
        filter: options.filter,
        timeout_ms: options.timeout_ms ?? 60_000,
        description: "Build watcher",
      },
      ctx,
    )
  return {
    host,
    ctx,
    tool,
    start,
    deliveries,
    processes,
    expected: () => expected,
    emit: (event: JobEvent) => emit(event),
  }
}

const noticeText = (message: UserMessage) =>
  message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
const idOf = (result: { details?: unknown }) => (result.details as BackgroundJobDetails).jobId

async function until(check: () => boolean) {
  const end = Date.now() + 5000
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for notice")
    await Bun.sleep(5)
  }
}

test("monitor returns immediately, labels its registry job, batches each complete line and never repeats partial lines", async () => {
  const s = setup()
  const result = await s.start()
  expect(textOf(result)).toContain("Started monitor job1: Build watcher")
  expect(s.host.get(idOf(result))).toMatchObject({
    kind: "monitor",
    meta: { description: "Build watcher", shellKind: "bash" },
  })
  expect(s.expected()).toBe(1)
  s.emit({ type: "output", data: "one\ntw" })
  s.emit({ type: "output", data: "o\r\nthree\npartial" })
  expect(s.deliveries).toHaveLength(0)
  await until(() => s.deliveries.length === 1)
  expect(noticeText(s.deliveries[0]!.message)).toEndWith("one\ntwo\nthree")
  expect(s.deliveries[0]!.wake).toBe(true)
  expect(s.expected()).toBe(1)
  s.emit({ type: "output", data: " end\n" })
  await until(() => s.deliveries.length === 2)
  expect(noticeText(s.deliveries[1]!.message)).toEndWith("partial end")
})

test.each(["ready|error", "port (3000"])(
  "monitor filters per line, case-insensitively with literal fallback: %s",
  async (filter) => {
    const s = setup({ filter })
    await s.start()
    s.emit({ type: "output", data: "ignore\nREADY\nError: bad\nPORT (3000)\nignored\n" })
    await until(() => s.deliveries.length === 1)
    const text = noticeText(s.deliveries[0]!.message)
    expect(text).not.toContain("ignore")
    if (filter.startsWith("ready")) {
      expect(text).toEndWith("READY\nError: bad")
      expect(text).not.toContain("PORT")
    } else expect(text).toEndWith("PORT (3000)")
  },
)

test("monitor rate limits batches rather than sending a notice for every output chunk", async () => {
  const s = setup({ intervalMs: 100 })
  await s.start()
  s.emit({ type: "output", data: "first\n" })
  await until(() => s.deliveries.length === 1)
  s.emit({ type: "output", data: "second\n" })
  await Bun.sleep(25)
  s.emit({ type: "output", data: "third\n" })
  expect(s.deliveries).toHaveLength(1)
  await until(() => s.deliveries.length === 2)
  expect(noticeText(s.deliveries[1]!.message)).toEndWith("second\nthird")
})

test("monitor caps UTF-8 notices with a line marker, pauses after 200 events, but still reports exit", async () => {
  const s = setup()
  await s.start()
  s.emit({
    type: "output",
    data: Array.from({ length: 250 }, (_, i) => `${i} ${"界".repeat(200)}\n`).join(""),
  })
  await until(() => s.deliveries.length === 1)
  const text = noticeText(s.deliveries[0]!.message)
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096)
  expect(text).toMatch(/\+\d+ more lines/)
  expect(text).toContain("throttled after 200 events")
  expect(text).toContain("narrower filter")
  s.emit({ type: "output", data: "not sent\n" })
  await Bun.sleep(30)
  expect(s.deliveries).toHaveLength(1)
  s.emit({ type: "exit", code: 3, signal: null })
  await until(() => s.deliveries.length === 2)
  expect(noticeText(s.deliveries[1]!.message)).toContain("exited with code 3")
  expect(s.expected()).toBe(0)
})

test("monitor sends a final notice on exit, including an unfinished last line", async () => {
  const s = setup()
  await s.start()
  s.emit({ type: "output", data: "last partial" })
  s.emit({ type: "exit", code: 0, signal: null })
  await until(() => s.deliveries.length === 1)
  expect(noticeText(s.deliveries[0]!.message)).toEndWith("last partial\nexited with code 0")
  expect(s.deliveries[0]!.wake).toBe(true)
  expect(s.expected()).toBe(0)
})

test("monitor handles synchronous output and startup failure", async () => {
  const s = setup({
    sync(emit) {
      emit({ type: "output", data: "startup failure\n" })
      emit({ type: "exit", code: null, signal: null, error: "cannot start" })
    },
  })
  await s.start()
  await until(() => s.deliveries.length === 1)
  expect(noticeText(s.deliveries[0]!.message)).toContain("startup failure")
  expect(noticeText(s.deliveries[0]!.message)).toContain("cannot start")
  expect(s.expected()).toBe(0)
})

test("monitor timeout kills the process and wakes with one final notice", async () => {
  const s = setup({ timeout_ms: 20 })
  await s.start()
  await until(() => s.deliveries.length === 1)
  expect(s.host.running()).toEqual([])
  expect(noticeText(s.deliveries[0]!.message)).toContain("Timed out after 20 ms")
  expect(s.deliveries[0]!.wake).toBe(true)
  expect(s.expected()).toBe(0)
})

test("job_stop stops monitors and their final notice does not wake on request", async () => {
  const s = setup()
  const result = await s.start()
  await jobStopTool.execute({ job_id: idOf(result) }, s.ctx)
  await until(() => s.deliveries.length === 1)
  expect(noticeText(s.deliveries[0]!.message)).toContain("was stopped")
  expect(s.deliveries[0]!.wake).toBe(false)
  expect(s.expected()).toBe(0)
})

test("monitor is scoped to its sub-agent; closing its owner stops it and cancels pending batches", async () => {
  const s = setup({ sessionId: "child", depth: 1 })
  const result = await s.start()
  const id = idOf(result)
  const root = s.host.forSession({ sessionId: "main", depth: 0 })
  const sibling = s.host.forSession({ sessionId: "sibling", depth: 1, parentSessionId: "main" })
  expect(root.get(id)?.kind).toBe("monitor")
  expect(sibling.get(id)).toBeUndefined()
  s.emit({ type: "output", data: "queued\n" })
  await s.host.closeSession("child", 0)
  await Bun.sleep(30)
  expect(s.host.get(id)?.status).toBe("stopped")
  expect(s.deliveries).toEqual([])
  expect(s.expected()).toBe(0)
})

test("monitor validates input, clamps timeouts and applies the normal shell permission policy", async () => {
  const s = setup()
  expect((await s.tool.execute({ command: "" }, s.ctx)).isError).toBe(true)
  expect((await s.tool.execute({ command: "bad\0command" }, s.ctx)).isError).toBe(true)
  expect(textOf(await s.tool.execute({ command: "watch", timeout_ms: Infinity }, s.ctx))).toContain(
    `${MAX_MONITOR_TIMEOUT_MS} ms`,
  )
  const policy = new Permissions({ mode: "plan" })
  expect((await policy.check(s.tool, { command: "echo hello" }, process.cwd())).decision).toBe("deny")
  const denied = new Permissions({
    mode: "auto",
    rules: [{ command: ["rm"], decision: "deny", source: { scope: "user", file: "test.json" } }],
  })
  expect((await denied.check(s.tool, { command: "rm important" }, process.cwd())).decision).toBe("deny")
})

test("a monitor event wakes an idle real Agent into a new mock-dialect turn", async () => {
  const s = setup()
  const mock = createMockDialect([
    { toolCalls: [{ name: "monitor", args: { command: "watch" } }] },
    { text: "watching" },
    { text: "handled the event" },
    { text: "monitor ended" },
  ])
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const agent = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: process.cwd(),
    systemPrompt: "",
    backgroundJobs: s.host,
  })
  agent.tools.register(s.tool, "test")
  await agent.prompt("watch the build")
  expect(agent.busy).toBe(false)
  expect(agent.expectedNotices).toBe(1)
  s.emit({ type: "output", data: "build ready\n" })
  await until(() => mock.requests.length === 3 && !agent.busy)
  const last = mock.requests[2]!.messages.at(-1)!
  expect(last.role).toBe("user")
  expect(last.role === "user" && noticeText(last)).toContain("build ready")
  expect(agent.expectedNotices).toBe(1)
  s.emit({ type: "exit", code: 0, signal: null })
  await until(() => mock.requests.length === 4 && !agent.busy)
  expect(agent.expectedNotices).toBe(0)
  await agent.dispose()
})

test("an ordinary job ending on its own wakes an idle Agent; a requested stop does not", async () => {
  const s = setup()
  const off = watchJobEnds(s.host)
  const mock = createMockDialect([
    { toolCalls: [{ name: "start_background", args: {} }] },
    { text: "working elsewhere" },
    { text: "handled the job end" },
    { toolCalls: [{ name: "start_background", args: {} }] },
    { text: "another job started" },
  ])
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const agent = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: process.cwd(),
    systemPrompt: "",
    backgroundJobs: s.host,
  })
  agent.tools.register(
    defineTool({
      name: "start_background",
      description: "",
      parameters: {},
      execute: (_args, ctx) => startBackground("bash", shell, "build", ctx),
    }),
    "test",
  )
  try {
    await agent.prompt("start a job")
    expect(mock.requests).toHaveLength(2)
    expect(agent.busy).toBe(false)
    s.emit({ type: "exit", code: 0, signal: null })
    await until(() => mock.requests.length === 3 && !agent.busy)
    const message = mock.requests[2]!.messages.at(-1)!
    expect(message.role === "user" && noticeText(message)).toContain("Background job job1")
    await agent.prompt("start another job")
    await s.host.stop("job2", 0)
    await Bun.sleep(30)
    expect(mock.requests).toHaveLength(5)
    expect(agent.waitingNotices).toBe(0)
  } finally {
    off()
    await agent.dispose()
  }
})

test("monitor sees a matching line before a large chunk is trimmed from the job buffer", async () => {
  const s = setup({ filter: "READY", bufferChars: 1000 })
  await s.start()
  s.emit({ type: "output", data: `READY\n${"unmatched\n".repeat(1000)}` })
  expect(s.host.output("job1").text).not.toContain("READY")
  await until(() => s.deliveries.length === 1)
  expect(noticeText(s.deliveries[0]!.message)).toEndWith("READY")
})

test("a root monitor retains output observation and its timeout across session handover", async () => {
  const s = setup({ timeout_ms: 150 })
  const oldRegistry = jobsConfig.registry
  jobsConfig.registry = s.host
  try {
    await s.start()
    await s.host.handoverRoot("main", "replacement", 0)
    const next = s.host.forSession({ sessionId: "replacement", depth: 0 })
    expect(next.running()).toHaveLength(1)
    s.emit({ type: "output", data: "after handover\n" })
    await until(() => s.deliveries.length >= 1)
    expect(noticeText(s.deliveries[0]!.message)).toContain("after handover")
    await until(() => s.deliveries.length === 2)
    expect(noticeText(s.deliveries[1]!.message)).toContain("Timed out after 150 ms")
    expect(s.host.running()).toEqual([])
    expect(s.expected()).toBe(0)
  } finally {
    jobsConfig.registry = oldRegistry
  }
})

test("a one-shot sub-agent without notice support is not silently given a non-notifying monitor", async () => {
  const s = setup({ sessionId: "child", depth: 1 })
  const { expectNotice: _notice, ...session } = s.ctx.session
  const result = await s.tool.execute({ command: "watch" }, { ...s.ctx, session })
  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain("cannot receive monitor notices")
  expect(s.host.running()).toEqual([])
})

test("an ordinary child agent receives monitor events while working and its monitor ends with it", async () => {
  const s = setup()
  const mock = createMockDialect([
    { toolCalls: [{ name: "monitor", args: { command: "watch" } }] },
    { toolCalls: [{ name: "work", args: {} }] },
    { text: "handled child output" },
  ])
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const child = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: process.cwd(),
    systemPrompt: "",
    depth: 1,
    parentSessionId: "main",
    backgroundJobs: s.host,
  })
  child.tools.register(s.tool, "test")
  let working = false
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  child.tools.register(
    defineTool({
      name: "work",
      description: "",
      parameters: {},
      async execute() {
        working = true
        await hold
        return { content: [] }
      },
    }),
    "test",
  )
  const run = child.prompt("watch while working")
  try {
    await until(() => working)
    s.emit({ type: "output", data: "child build ready\n" })
    await until(() => child.waitingNotices === 1)
    release()
    await run
    expect(JSON.stringify(mock.requests[2]!.messages)).toContain("child build ready")
    expect(s.host.list()[0]?.owner).toBe(child.sessionId)
    await child.dispose()
    expect(s.host.running()).toEqual([])
    expect(mock.requests).toHaveLength(3)
  } finally {
    release()
    await run
    await child.dispose()
  }
})

test("monitor refuses to execute a shell different from its authorized classification", async () => {
  const s = setup()
  const result = await s.tool.execute({ command: "watch" }, { ...s.ctx, shellKind: "powershell" })
  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain("shell changed after authorization")
  expect(s.host.running()).toEqual([])
})

test("even a long failure message cannot exceed the monitor notice byte cap", async () => {
  const s = setup()
  await s.start()
  s.emit({ type: "exit", code: null, signal: null, error: "界".repeat(5000) })
  await until(() => s.deliveries.length === 1)
  const text = noticeText(s.deliveries[0]!.message)
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096)
  expect(text).toContain("+1 more lines")
})

test("acceptance: a requested delayed stop suppresses a queued output wake", async () => {
  const s = setup({ stopDelayMs: 80 })
  const result = await s.start()
  s.emit({ type: "output", data: "queued before stop\n" })
  const stopping = jobStopTool.execute({ job_id: idOf(result) }, s.ctx)
  expect(s.host.get(idOf(result))?.stopRequested).toBe(true)
  await Bun.sleep(30)
  const wakes = s.deliveries.filter((d) => d.wake !== false)
  await stopping
  await Bun.sleep(0)
  expect(wakes).toEqual([])
  expect(s.deliveries).toHaveLength(1)
  expect(s.deliveries[0]!.wake).toBe(false)
  expect(noticeText(s.deliveries[0]!.message)).toContain("was stopped")
})

test("acceptance: a monitor actively watched by job_output does not wake again on exit", async () => {
  const s = setup()
  const result = await s.start()
  const watching = jobOutputTool.execute({ job_id: idOf(result), timeout: 1000 }, s.ctx)
  s.emit({ type: "exit", code: 0, signal: null })
  await watching
  await Bun.sleep(0)
  expect(s.deliveries).toHaveLength(1)
  expect(s.deliveries[0]!.wake).toBe(false)
})

test("acceptance: a matching partial line survives retained-buffer trimming", async () => {
  const s = setup({ filter: "READY", bufferChars: 1000 })
  await s.start()
  s.emit({ type: "output", data: `READY${"x".repeat(2000)}` })
  s.emit({ type: "output", data: "\n" })
  await Bun.sleep(30)
  expect(s.deliveries).toHaveLength(1)
  expect(noticeText(s.deliveries[0]!.message)).toContain("READY")
})

test("acceptance: synchronous startup output is framed before registry trimming", async () => {
  const s = setup({
    filter: "READY",
    bufferChars: 1000,
    sync(emit) {
      emit({ type: "output", data: `READY${"x".repeat(2000)}` })
      emit({ type: "output", data: "\n" })
    },
  })
  await s.start()
  await Bun.sleep(30)
  expect(s.deliveries).toHaveLength(1)
  expect(noticeText(s.deliveries[0]!.message)).toContain("READY")
})

test.each([0, 50])("acceptance: registry retention %i cannot discard final notices", async (keepEnded) => {
  const count = keepEnded ? 60 : 1
  const s = setup({ keepEnded, maxRunning: 64 })
  for (let i = 0; i < count; i++) await s.start()
  for (const [code, emit] of s.processes.entries()) emit({ type: "exit", code, signal: null })
  expect(s.expected()).toBe(count)
  await until(() => s.deliveries.length === 1)
  const text = noticeText(s.deliveries[0]!.message)
  for (let i = 0; i < count; i++) {
    expect(text).toContain(`Monitor job${i + 1} `)
    expect(text).toContain(`exited with code ${i}`)
  }
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096)
  expect(s.expected()).toBe(0)
})

test("oversized lines are explicitly omitted before filtering, never matched as suffixes", async () => {
  const s = setup({ filter: "^READY$", bufferChars: 1000 })
  await s.start()
  s.emit({ type: "output", data: "x".repeat(MAX_MONITOR_LINE_CHARS + 1) })
  s.emit({ type: "output", data: "READY\n" })
  await until(() => s.deliveries.length === 1)
  const text = noticeText(s.deliveries[0]!.message)
  expect(text).toContain(`exceeded ${MAX_MONITOR_LINE_CHARS} characters`)
  expect(text).toContain("omitted before filtering")
  expect(text).not.toContain("\nREADY")
  s.emit({ type: "output", data: "READY\n" })
  await until(() => s.deliveries.length === 2)
  expect(noticeText(s.deliveries[1]!.message)).toEndWith("READY")
})

test("a synchronously ended monitor with zero retention still delivers output and its final notice", async () => {
  const s = setup({
    keepEnded: 0,
    sync(emit) {
      emit({ type: "output", data: "startup failure" })
      emit({ type: "exit", code: 2, signal: null })
    },
  })
  await s.start()
  await until(() => s.deliveries.length === 1)
  expect(noticeText(s.deliveries[0]!.message)).toContain("startup failure\nexited with code 2")
  expect(s.expected()).toBe(0)
})

test("an active child retains all terminal notices even when its ended jobs are pruned", async () => {
  const s = setup({ sessionId: "child", depth: 1, keepEnded: 0 })
  await s.start()
  s.emit({ type: "exit", code: 0, signal: null })
  await until(() => s.deliveries.length === 1)
  expect(s.deliveries[0]!.wake).toBe(true)
})

test("a replacement root can stop its inherited monitor and retain the non-waking final notice", async () => {
  const s = setup()
  const oldRegistry = jobsConfig.registry
  jobsConfig.registry = s.host
  try {
    const result = await s.start()
    await s.host.handoverRoot("main", "replacement", 0)
    const next = s.host.forSession({ sessionId: "replacement", depth: 0 })
    await next.stop(idOf(result), 0)
    await Bun.sleep(0)
    expect(s.deliveries).toHaveLength(1)
    expect(s.deliveries[0]!.wake).toBe(false)
    expect(noticeText(s.deliveries[0]!.message)).toContain("was stopped")
  } finally {
    jobsConfig.registry = oldRegistry
  }
})

test("a watched monitor timeout sends only a non-waking final notice", async () => {
  const s = setup({ timeout_ms: 20 })
  const result = await s.start()
  await jobOutputTool.execute({ job_id: idOf(result), timeout: 1000 }, s.ctx)
  await Bun.sleep(0)
  expect(s.deliveries).toHaveLength(1)
  expect(s.deliveries[0]!.wake).toBe(false)
  expect(noticeText(s.deliveries[0]!.message)).toContain("Timed out")
})

test("a manual stop already in progress is not turned into a wake by the monitor deadline", async () => {
  const s = setup({ timeout_ms: 20, stopDelayMs: 80 })
  const result = await s.start()
  await jobStopTool.execute({ job_id: idOf(result) }, s.ctx)
  await Bun.sleep(0)
  expect(s.deliveries).toHaveLength(1)
  expect(s.deliveries[0]!.wake).toBe(false)
})

test("the monitor description names the shell its commands run in, following the session's mode", () => {
  let mode: "bash" | "powershell" | undefined
  const tool = createMonitorTool(undefined, {}, () => mode)
  expect(tool.description).toContain("Monitor a bash command")
  expect(tool.description).toContain("not PowerShell")
  mode = "powershell"
  expect(tool.description).toContain("Monitor a PowerShell command")
  for (const m of [undefined, "powershell"] as const) {
    mode = m
    expect(tool.description).toContain("no nested shells")
  }
})
