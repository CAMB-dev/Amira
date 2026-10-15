import { afterEach, expect, test } from "bun:test"
import { defineTool, type ToolContext } from "@amira/api"
import { createAi, createMockDialect, type MockStep } from "../../../packages/ai/src/index.ts"
import { type PrintIO, runPrint } from "../../../packages/cli/src/print.ts"
import { Agent, SessionBackgroundJobHost } from "../../../packages/core/src/index.ts"
import { type JobEvent, JobRegistry } from "../../../packages/proc/src/index.ts"
import { createMonitorTool } from "../src/monitor.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function setup(busy: boolean, timeout: boolean, spreadMs: number) {
  const processes: ((event: JobEvent) => void)[] = []
  const host = new SessionBackgroundJobHost(
    new JobRegistry({
      maxRunning: 64,
      start(_spec, emit) {
        processes.push(emit)
        emit({ type: "spawned", pid: processes.length, contained: true })
        return { stop: () => emit({ type: "exit", code: null, signal: null }) }
      },
    }),
  )
  const monitor = createMonitorTool(async () => ({
    kind: "bash",
    path: "fake-bash",
    command: (command, cwd) => ({ argv: [command], cwd, env: {}, gated: false }),
  }))
  const steps: MockStep[] = [
    { toolCalls: [{ name: "start_monitors", args: {} }] },
    ...(busy ? [{ toolCalls: [{ name: "work", args: {} }] }] : [{ text: "watching" }]),
    ...Array.from({ length: 20 }, () => ({ text: "handled" })),
  ]
  const mock = createMockDialect(steps)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const agent = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: process.cwd(),
    systemPrompt: "",
    backgroundJobs: host,
  })
  let ctx!: ToolContext
  agent.tools.register(
    defineTool({
      name: "start_monitors",
      description: "",
      parameters: {},
      async execute(_args, context) {
        ctx = context
        for (let i = 0; i < 16; i++) {
          if (timeout && i && spreadMs) await Bun.sleep(spreadMs / 15)
          await monitor.execute({ command: `watch-${i}`, timeout_ms: timeout ? 100 : 60_000 }, context)
        }
        return { content: [] }
      },
    }),
    "test",
  )
  let working = false
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  agent.tools.register(
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
  cleanup.push(async () => {
    release()
    await host.stopAll(undefined, 0)
    await agent.dispose()
    await Bun.sleep(120)
  })
  return { host, agent, ai, mock, processes, release, working: () => working, context: () => ctx }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for monitor completions")
    await Bun.sleep(5)
  }
}

for (const busy of [false, true]) {
  for (const timeout of [false, true]) {
    for (const spreadMs of [0, 30]) {
      test(`16 monitor ${timeout ? "timeouts" : "exits"} across ${spreadMs} ms coalesce for a ${busy ? "busy" : "fast idle"} Agent`, async () => {
        const s = setup(busy, timeout, spreadMs)
        const run = s.agent.prompt("watch")
        try {
          if (busy) await until(s.working)
          else await run
          expect(s.host.list()).toHaveLength(16)
          if (!timeout) {
            await Promise.all(
              s.processes.map(
                (emit, i) =>
                  new Promise<void>((resolve) => {
                    setTimeout(
                      () => {
                        emit({ type: "exit", code: i, signal: null })
                        resolve()
                      },
                      (i * spreadMs) / 15,
                    )
                  }),
              ),
            )
          }
          await Bun.sleep(240)
          if (busy) expect(s.agent.waitingNotices).toBe(1)
          s.release()
          await run
          await until(() => !s.agent.busy)
          expect(s.mock.requests).toHaveLength(3)
          const notices = s.agent.messages.filter((m) => m.role === "user" && m.display?.origin === "job")
          expect(notices).toHaveLength(1)
          const text = JSON.stringify(notices[0])
          for (let i = 1; i <= 16; i++) expect(text).toContain(`Monitor job${i} `)
          if (timeout) expect(text).toContain("Timed out")
          else for (let i = 0; i < 16; i++) expect(text).toContain(`exited with code ${i}`)
          expect(s.agent.expectedNotices).toBe(0)
        } finally {
          s.release()
          await run
        }
      })
    }
  }
}

test("monitor completion batches retain reservations, every terminal ID/outcome, and a UTF-8 byte cap", async () => {
  const s = setup(false, false, 0)
  await s.agent.prompt("watch")
  for (const [i, emit] of s.processes.entries()) {
    emit({ type: "output", data: Array.from({ length: 5 }, () => "界".repeat(100)).join("\n") })
    emit({ type: "exit", code: null, signal: null, error: `failure-${i} ${"失敗".repeat(2000)}` })
  }
  expect(s.agent.expectedNotices).toBe(16)
  expect(s.mock.requests).toHaveLength(2)
  await until(() => s.mock.requests.length === 3 && !s.agent.busy)
  const notice = s.agent.messages.find((m) => m.role === "user" && m.display?.origin === "job")!
  const text = notice.content.map((b) => (b.type === "text" ? b.text : "")).join("")
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096)
  expect(text).not.toContain("\uFFFD")
  expect(text).toMatch(/\+\d+ more lines/)
  for (let i = 0; i < 16; i++) {
    expect(text).toContain(`Monitor job${i + 1} `)
    expect(text).toContain(`failure-${i} `)
  }
  expect(s.agent.expectedNotices).toBe(0)
})

test("queued monitor completions follow an owner handover without releasing their leases early", async () => {
  const s = setup(false, false, 0)
  await s.agent.prompt("watch")
  for (const emit of s.processes) emit({ type: "exit", code: 0, signal: null })
  const next = new Agent({
    ai: s.ai,
    model: s.agent.model,
    cwd: process.cwd(),
    systemPrompt: "",
    backgroundJobs: s.host,
  })
  cleanup.push(() => next.dispose())
  s.agent.handoverBackgroundNotices(next)
  await s.host.handoverRoot(s.agent.sessionId, next.sessionId, 0)
  await s.agent.dispose("switch")
  expect(next.expectedNotices).toBe(16)
  await until(() => s.mock.requests.length === 3 && !next.busy)
  expect(next.expectedNotices).toBe(0)
  expect(s.mock.requests).toHaveLength(3)
  const text = JSON.stringify(s.mock.requests[2]!.messages.at(-1))
  for (let i = 1; i <= 16; i++) expect(text).toContain(`Monitor job${i} `)
})

for (const json of [false, true]) {
  test(`${json ? "JSON" : "plain"} print drains a terminal monitor batch after all processes have exited`, async () => {
    const s = setup(false, false, 0)
    const io: PrintIO & { out: string; err: string } = {
      out: "",
      err: "",
      stdout(text) {
        this.out += text
      },
      stderr(text) {
        this.err += text
      },
    }
    let settled = false
    const run = runPrint(s.agent, "watch", json, {
      io,
      backgroundJobs: s.host,
      backgroundJobTimeoutMs: 1,
    }).then((code) => {
      settled = true
      return code
    })
    await until(() => s.mock.requests.length === 2 && !s.agent.busy)
    for (const emit of s.processes) emit({ type: "exit", code: 0, signal: null })
    expect(s.agent.expectedNotices).toBe(16)
    await Bun.sleep(30)
    expect(settled).toBe(false)
    expect(await run).toBe(0)
    expect(s.mock.requests).toHaveLength(3)
    expect(s.agent.expectedNotices).toBe(0)
    if (!json) expect(io.out).toBe("watching\nhandled\n")
    expect(io.err).not.toContain("still running")
  })
}

test("one host keeps terminal monitor batches isolated by owning Agent", async () => {
  const s = setup(false, false, 0)
  const otherMock = createMockDialect([
    { toolCalls: [{ name: "start_monitors", args: {} }] },
    { text: "watching" },
    { text: "handled" },
  ])
  const ai = createAi({ dialects: [otherMock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const other = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: process.cwd(),
    systemPrompt: "",
    backgroundJobs: s.host,
  })
  other.tools.register(s.agent.tools.get("start_monitors")!, "test")
  cleanup.push(() => other.dispose())
  await s.agent.prompt("watch")
  await other.prompt("watch")
  for (const emit of s.processes) emit({ type: "exit", code: 0, signal: null })
  await until(
    () => s.mock.requests.length === 3 && otherMock.requests.length === 3 && !s.agent.busy && !other.busy,
  )
  for (const [owner, first, absent] of [
    [s.agent, 1, 17],
    [other, 17, 1],
  ] as const) {
    const notices = owner.messages.filter((m) => m.role === "user" && m.display?.origin === "job")
    expect(notices).toHaveLength(1)
    const text = JSON.stringify(notices[0])
    for (let i = first; i < first + 16; i++) expect(text).toContain(`Monitor job${i} `)
    expect(text).not.toContain(`Monitor job${absent} `)
    expect(owner.expectedNotices).toBe(0)
  }
})
