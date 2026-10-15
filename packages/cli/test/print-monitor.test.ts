import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep, type ModelRequest, userMessage } from "@amira/ai"
import { type BackgroundJobChange, type BackgroundJobInfo, defineTool, textResult } from "@amira/api"
import { Agent, SessionBackgroundJobHost } from "@amira/core"
import { type JobEvent, JobRegistry } from "@amira/proc"
import { createMonitorTool } from "../../../extensions/builtin-tools/src/monitor.ts"
import { type PrintIO, runPrint } from "../src/print.ts"

function capture(): PrintIO & { out: string; err: string } {
  const io = {
    out: "",
    err: "",
    stdout: (text: string) => {
      io.out += text
    },
    stderr: (text: string) => {
      io.err += text
    },
  }
  return io
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the monitor turn")
    await Bun.sleep(5)
  }
}

/** A monitor's registry and notice lifecycle without starting a shell or touching user state. */
function monitorSession(opts: { followups?: MockStep[]; noticeRetryMs?: number[] } = {}) {
  let job: BackgroundJobInfo | undefined
  let output!: (text: string) => void
  let finish!: (text: string, wake?: boolean, stopped?: boolean) => void
  const listeners = new Set<(change: BackgroundJobChange) => void>()
  const registry = {
    list: () => (job ? [job] : []),
    subscribe: (listener: (change: BackgroundJobChange) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const emit = (type: BackgroundJobChange["type"]) => {
    for (const listener of listeners) listener({ type, job: job! })
  }
  const react = (req: ModelRequest) => ({
    text: req.messages
      .at(-1)
      ?.content.map((block) => (block.type === "text" ? block.text : ""))
      .join(""),
  })
  const mock = createMockDialect([
    { toolCalls: [{ name: "monitor", args: {} }] },
    { text: "watching" },
    ...(opts.followups ?? [react, react, react]),
  ])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: import.meta.dir,
    systemPrompt: "",
    noticeRetryMs: opts.noticeRetryMs,
  })
  agent.tools.register(
    defineTool({
      name: "monitor",
      description: "",
      parameters: {},
      execute: async (_args, ctx) => {
        const session = ctx.session!
        // The monitor retains an expected notice even between output notifications.
        const lifetime = session.expectNotice!()
        job = {
          id: "monitor1",
          kind: "monitor",
          command: "watch logs",
          cwd: import.meta.dir,
          meta: {},
          startedAt: Date.now(),
          status: "running",
          contained: true,
          exitCode: null,
          signal: null,
          stopRequested: false,
          outputChars: 0,
        }
        output = (text) => {
          job = { ...job!, outputChars: job!.outputChars + text.length }
          session.expectNotice!().deliver(userMessage(text, { text, origin: "job" }), { wake: false })
          emit("output")
        }
        finish = (text, wake = false, stopped = true) => {
          if (job!.status !== "running") return
          job = stopped
            ? { ...job!, status: "stopped", stopRequested: true, endedAt: Date.now() }
            : { ...job!, stopRequested: true }
          lifetime.deliver(userMessage(text, { text, origin: "job" }), { wake })
          emit(stopped ? "end" : "output")
        }
        emit("start")
        return textResult("started")
      },
    }),
    "test",
  )
  return {
    agent,
    mock,
    registry,
    output: (text: string) => output(text),
    finish: (text: string, wake?: boolean) => finish(text, wake),
    // A stop-confirmation deadline releases the notice even if the process never emits exit.
    unconfirmedStop: () => finish("monitor timed out; stop was not confirmed", false, false),
  }
}

/** The real monitor tool, with process events injected through the ordinary job registry. */
function realMonitorSession(timeoutMs: number) {
  let emit!: (event: JobEvent) => void
  const registry = new JobRegistry({
    start: (_spec, onEvent) => {
      emit = onEvent
      onEvent({ type: "spawned", pid: 1234, contained: true })
      return { stop: () => onEvent({ type: "exit", code: null, signal: null }) }
    },
  })
  const host = new SessionBackgroundJobHost(registry)
  const react = (req: ModelRequest) => {
    const text = JSON.stringify(req.messages.at(-1))
    return {
      text: text.includes("Timed out after")
        ? "handled timeout"
        : text.includes(" ended.")
          ? "handled end"
          : "handled output",
    }
  }
  const mock = createMockDialect([
    { toolCalls: [{ name: "monitor", args: { command: "watch logs", timeout_ms: timeoutMs } }] },
    { text: "watching" },
    react,
    react,
    react,
  ])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: import.meta.dir,
    systemPrompt: "",
    backgroundJobs: host,
  })
  agent.tools.register(
    createMonitorTool(
      async () => ({
        kind: "bash",
        path: "fake-bash",
        command: (command, cwd) => ({ argv: ["fake-bash", "-c", command], cwd, env: {}, gated: false }),
      }),
      { batchMs: 1, intervalMs: 1 },
    ),
    "test",
  )
  return { agent, mock, host, emit: (event: JobEvent) => emit(event) }
}

for (const json of [false, true]) {
  for (const retries of [0, 3]) {
    test(`${json ? "JSON" : "plain"} print preserves a live monitor's terminal failure after ${retries} retries`, async () => {
      const failure: MockStep = { error: { message: "provider down" } }
      const session = monitorSession({
        followups: [...Array.from({ length: retries + 1 }, () => failure), { text: "overwrote failure" }],
        noticeRetryMs: Array.from({ length: retries }, () => 5),
      })
      const { agent, mock, registry } = session
      const io = capture()
      let settled = false
      const run = runPrint(agent, "watch", json, {
        io,
        backgroundJobs: registry,
        backgroundJobTimeoutMs: 1,
      }).then((code) => {
        settled = true
        return code
      })
      try {
        await until(() => mock.requests.length >= 2 && !agent.busy)
        session.output("new log line")
        await until(() => mock.requests.length === retries + 3 && !agent.busy && !agent.noticeRetry)
        await until(() => settled)
        expect(await run).toBe(1)
        expect(registry.list()[0]?.status).toBe("running")
        expect(agent.expectedNotices).toBe(1)
        expect(mock.requests).toHaveLength(retries + 3)
        expect(io.out).not.toContain("overwrote failure")
        expect(io.err).not.toContain("top-level background jobs were still running")
      } finally {
        session.finish("monitor stopped", true)
        await run
        await agent.dispose("exit")
      }
    })
  }

  test(`${json ? "JSON" : "plain"} print keeps waiting for a monitor after a successful notice retry`, async () => {
    const session = monitorSession({
      followups: [{ error: { message: "provider down" } }, { text: "recovered" }, { text: "handled end" }],
      noticeRetryMs: [5],
    })
    const { agent, mock, registry } = session
    const io = capture()
    let settled = false
    const run = runPrint(agent, "watch", json, {
      io,
      backgroundJobs: registry,
      backgroundJobTimeoutMs: 1,
    }).then((code) => {
      settled = true
      return code
    })
    try {
      await until(() => mock.requests.length >= 2 && !agent.busy)
      session.output("new log line")
      await until(() => mock.requests.length === 4 && !agent.busy && !agent.noticeRetry)
      expect(settled).toBe(false)
      expect(agent.expectedNotices).toBe(1)
      session.finish("monitor ended")
      expect(await run).toBe(0)
      expect(mock.requests).toHaveLength(5)
      expect(io.out).toContain("recovered")
      expect(io.err).not.toContain("top-level background jobs were still running")
    } finally {
      session.finish("monitor stopped", true)
      await run
      await agent.dispose("exit")
    }
  })

  test(`${json ? "JSON" : "plain"} print applies the ordinary deadline after an unconfirmed monitor stop`, async () => {
    const session = monitorSession()
    const { agent, mock, registry } = session
    const io = capture()
    let settled = false
    const run = runPrint(agent, "watch", json, {
      io,
      backgroundJobs: registry,
      backgroundJobTimeoutMs: 1,
    }).then((code) => {
      settled = true
      return code
    })
    try {
      await until(() => mock.requests.length >= 2 && !agent.busy)
      await Bun.sleep(30)
      expect(settled).toBe(false)
      session.unconfirmedStop()
      await until(() => settled)
      expect(await run).toBe(0)
      expect(agent.expectedNotices).toBe(0)
      expect(registry.list()[0]?.status).toBe("running")
      expect(registry.list()[0]?.stopRequested).toBe(true)
      expect(mock.requests).toHaveLength(4)
      expect(io.err).toContain("top-level background jobs were still running")
    } finally {
      session.finish("monitor stopped", true)
      await run
      await agent.dispose("exit")
    }
  })

  for (const end of ["timeout", "exit", "stop"] as const) {
    test(`${json ? "JSON" : "plain"} print consumes real monitor output and final ${end} notices`, async () => {
      const { agent, mock, host, emit } = realMonitorSession(end === "timeout" ? 300 : 2000)
      const io = capture()
      const run = runPrint(agent, "watch", json, { io, backgroundJobs: host, backgroundJobTimeoutMs: 1 })
      try {
        await until(() => mock.requests.length >= 2 && !agent.busy)
        await Bun.sleep(30)
        expect(mock.requests).toHaveLength(2)
        expect(agent.expectedNotices).toBe(1)
        expect(host.list()[0]?.kind).toBe("monitor")
        emit({ type: "output", data: "new log line\n" })
        await until(() => mock.requests.length >= 3 && !agent.busy)
        expect(agent.expectedNotices).toBe(1)
        if (end === "exit") emit({ type: "exit", code: 0, signal: null })
        if (end === "stop") await host.stop(host.list()[0]!.id, 0)
        expect(await run).toBe(0)
        expect(mock.requests).toHaveLength(4)
        expect(agent.expectedNotices).toBe(0)
        expect(host.running()).toHaveLength(0)
        expect(io.err).not.toContain("top-level background jobs were still running")
        if (!json) {
          expect(io.out).toBe(`watching\nhandled output\nhandled ${end === "timeout" ? "timeout" : "end"}\n`)
        } else {
          expect(io.out).toContain("handled ")
          expect(io.out).toContain(end === "timeout" ? "timeout" : "end")
        }
      } finally {
        await host.stopAll(() => true, 0)
        await until(() => agent.expectedNotices === 0)
        agent.wake()
        await run
        await agent.dispose("exit")
      }
    })
  }

  test(`${json ? "JSON" : "plain"} print keeps a monitor alive beyond the ordinary job deadline, wakes on output and handles its timeout`, async () => {
    const session = monitorSession()
    const { agent, mock, registry } = session
    const io = capture()
    let settled = false
    const run = runPrint(agent, "watch", json, {
      io,
      backgroundJobs: registry,
      backgroundJobTimeoutMs: 1,
    }).then((code) => {
      settled = true
      return code
    })
    try {
      await until(() => mock.requests.length >= 2 && !agent.busy)
      await Bun.sleep(40)
      expect(settled).toBe(false)
      expect(mock.requests).toHaveLength(2)
      expect(agent.expectedNotices).toBe(1)

      session.output("new log line")
      await until(() => mock.requests.length >= 3 && !agent.busy)
      expect(agent.expectedNotices).toBe(1)
      expect(settled).toBe(false)

      session.finish("monitor timed out")
      expect(await run).toBe(0)
      expect(agent.expectedNotices).toBe(0)
      expect(mock.requests).toHaveLength(4)
      expect(io.err).not.toContain("top-level background jobs were still running")
      if (json) {
        const events = io.out
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(events.filter((event) => event.type === "turn.end")).toHaveLength(3)
        expect(io.out).toContain("new log ")
        expect(io.out).toContain("timed out")
      } else expect(io.out).toBe("watching\nnew log line\nmonitor timed out\n")
    } finally {
      session.finish("monitor stopped", true)
      agent.wake()
      await run
      await agent.dispose("exit")
    }
  })
}
