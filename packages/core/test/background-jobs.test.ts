import { expect, test } from "bun:test"
import type { BackgroundJobHost, BackgroundJobSession } from "@amira/api"
import { type JobEvent, JobRegistry } from "@amira/proc"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost, SessionBackgroundJobHost } from "../src/index.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

interface FakeProcess {
  readonly stops: number[]
  readonly emit: (event: JobEvent) => void
}

function fakeHost(maxRunning?: number): { host: BackgroundJobHost; processes: FakeProcess[] } {
  const processes: FakeProcess[] = []
  let pid = 7000
  const registry = new JobRegistry({
    ...(maxRunning !== undefined ? { maxRunning } : {}),
    start: (_spec, onEvent) => {
      const process: FakeProcess = {
        stops: [],
        emit: onEvent,
      }
      processes.push(process)
      onEvent({ type: "spawned", pid: pid++, contained: true })
      return {
        stop(graceMs) {
          process.stops.push(graceMs)
          if (graceMs === 0) onEvent({ type: "exit", code: null, signal: null })
        },
      }
    },
  })
  return { host: new SessionBackgroundJobHost(registry), processes }
}

function sessions(host: BackgroundJobHost) {
  const main = host.forSession({ sessionId: "main", depth: 0 })
  const child = host.forSession({ sessionId: "child", depth: 1, parentSessionId: "main" })
  const other = host.forSession({ sessionId: "other", depth: 1, parentSessionId: "main" })
  return { main, child, other }
}

function start(session: BackgroundJobSession, command = "server") {
  return session.start({
    command,
    argv: ["bun", "-e", "setInterval(() => {}, 1000)"],
    cwd: "/work",
    env: { TEST_JOB: "yes" },
    shell: "bash",
  })
}

test("the public job contract covers lifecycle, output cursors, waits and subscriptions", async () => {
  const { host, processes } = fakeHost()
  const { main, child, other } = sessions(host)
  const changes: string[] = []
  main.subscribe(({ type, job }) => changes.push(`${type}:${job.id}`))

  const own = start(main)
  const childJob = start(child, "child-server")
  const hidden = start(other, "other-server")
  expect(own.meta).toMatchObject({ shellKind: "bash" })
  expect(host.list().map((job) => job.id)).toEqual([own.id, childJob.id, hidden.id])
  expect(main.list().map((job) => job.id)).toEqual([own.id, childJob.id, hidden.id])
  expect(child.list().map((job) => job.id)).toEqual([childJob.id])
  expect(other.get(childJob.id)).toBeUndefined()
  expect(other.list()).toEqual([hidden])
  expect(host.running().map((job) => job.id)).toEqual([own.id, childJob.id, hidden.id])

  processes[0]!.emit({ type: "output", data: "ready\nsecond\n" })
  expect(main.readNew(own.id, "reader")).toMatchObject({ text: "ready\nsecond\n", from: 0 })
  expect(main.readNew(own.id, "reader").text).toBe("")
  expect(main.readNew(own.id, "another").text).toBe("ready\nsecond\n")
  expect(main.cursor(own.id, "reader")).toBe(13)
  expect(main.output(own.id, 0).text).toBe("ready\nsecond\n")
  expect(main.tail(own.id, 6)).toBe("econd\n")
  main.markRead(own.id, "marked")
  expect(main.cursor(own.id, "marked")).toBe(13)

  const match = main.waitFor(own.id, { pattern: /listening/, timeoutMs: 1000 })
  processes[0]!.emit({ type: "output", data: "listening\n" })
  expect(await match).toEqual({ reason: "match", line: "listening" })
  expect(await main.waitFor(own.id, { pattern: /never/, timeoutMs: 0 })).toEqual({ reason: "timeout" })
  const abort = new AbortController()
  const aborted = main.waitFor(own.id, { pattern: /never/, timeoutMs: 1000, signal: abort.signal })
  abort.abort()
  expect(await aborted).toEqual({ reason: "aborted" })

  const ending = main.waitFor(own.id, { timeoutMs: 1000 })
  processes[0]!.emit({ type: "exit", code: 0, signal: null })
  expect(await ending).toEqual({ reason: "exit" })
  expect(changes).toEqual([
    "start:job1",
    "status:job1",
    "start:job2",
    "status:job2",
    "start:job3",
    "status:job3",
    "output:job1",
    "output:job1",
    "end:job1",
  ])
})

test("stopping is graceful first and forced when requested again", async () => {
  const { host, processes } = fakeHost()
  const main = host.forSession({ sessionId: "main", depth: 0 })
  const job = start(main)
  const graceful = main.stop(job.id, 25)
  await Bun.sleep(0)
  const forced = main.stop(job.id, 0)
  expect(await forced).toMatchObject({ id: job.id, status: "stopped", stopRequested: true })
  await graceful
  expect(processes[0]!.stops).toEqual([25, 0])
})

test("host and session views support subscriptions, configuration and bulk stops", async () => {
  const { host } = fakeHost()
  const changes: string[] = []
  const off = host.subscribe(({ type, job }) => changes.push(`${type}:${job.id}`))
  const main = host.forSession({ sessionId: "main", depth: 0 })
  const first = start(main)
  const second = start(main, "second")
  await main.stopAll(undefined, 0)
  expect(host.running()).toEqual([])
  expect(changes).toContain(`start:${first.id}`)
  expect(changes).toContain(`end:${second.id}`)
  off()

  const admin = host.start({ command: "admin", argv: ["admin"], cwd: "/work", shell: "bash" })
  expect(host.get(admin.id)).toMatchObject({ id: admin.id, status: "running" })
  await host.stopAll(() => true, 0)
  expect(host.get(admin.id)?.status).toBe("stopped")
  host.configure({ maxRunning: 3 })
  expect(host.maxRunning).toBe(3)
})

test("limits, ownership cleanup and root cleanup are part of the host contract", async () => {
  const limited = fakeHost(1)
  const main = limited.host.forSession({ sessionId: "main", depth: 0 })
  const first = start(main)
  expect(() => start(main, "too-many")).toThrow()
  let limit: unknown
  try {
    start(main, "too-many")
  } catch (error) {
    limit = error
  }
  expect(limited.host.isLimitError(limit)).toBe(true)
  await main.stop(first.id, 0)

  const { host, processes } = fakeHost()
  const { main: root, child } = sessions(host)
  const rootJob = start(root)
  const childJob = start(child)
  await host.closeSession("child", 0)
  expect(child.get(childJob.id)).toBeUndefined()
  expect(host.get(childJob.id)?.status).toBe("stopped")
  expect(root.get(rootJob.id)?.status).toBe("running")
  await host.closeRoot("main", 0)
  expect(host.get(rootJob.id)?.status).toBe("stopped")
  expect(() => start(root, "after-switch")).toThrow('background job session "main" has ended')
  expect(processes.map((process) => process.stops)).toEqual([[0], [0]])
})

test("root handover keeps top-level jobs visible to the replacement and stops sub-agent jobs", async () => {
  const { host, processes } = fakeHost()
  const old = host.forSession({ sessionId: "old", depth: 0 })
  const child = host.forSession({ sessionId: "child", depth: 1, parentSessionId: "old" })
  const rootJob = start(old, "root-server")
  const childJob = start(child, "child-server")
  processes[0]!.emit({ type: "output", data: "ready\n" })

  await host.handoverRoot("old", "new", 0)
  const next = host.forSession({ sessionId: "new", depth: 0 })

  expect(old.get(rootJob.id)).toBeUndefined()
  expect(next.get(rootJob.id)).toMatchObject({ status: "running" })
  expect(next.output(rootJob.id).text).toBe("ready\n")
  expect(next.get(childJob.id)).toBeUndefined()
  expect(host.get(childJob.id)).toMatchObject({ status: "stopped" })
  expect(processes[1]!.stops).toEqual([0])

  await next.stop(rootJob.id, 0)
  expect(host.get(rootJob.id)).toMatchObject({ status: "stopped" })
})

test("ExtensionAPI exposes the host; unload stops the extension's jobs, exit stops every job", async () => {
  const first = fakeHost()
  const extensionHost = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    backgroundJobs: first.host,
  })
  let api: import("@amira/api").ExtensionAPI | undefined
  await extensionHost.load((value) => {
    api = value
  }, "ext:jobs")
  await extensionHost.load(() => {}, "ext:other")
  const sessionJob = start(first.host.forSession({ sessionId: "main", depth: 0 }))
  const own = api!.backgroundJobs.start({ command: "own", argv: ["own"], cwd: "/work" })
  const changes: string[] = []
  api!.backgroundJobs.subscribe(({ type, job }) => changes.push(`${type}:${job.id}`))
  expect(api!.backgroundJobs.get(sessionJob.id)).toBeDefined()
  // Unloading another extension (or a /reload's unload) leaves every job running.
  extensionHost.unload("ext:other")
  expect(first.host.get(own.id)?.status).toBe("running")
  extensionHost.unload("ext:jobs")
  expect(first.host.get(own.id)?.status).toBe("stopped")
  // A session's jobs are the session's, not the extension's whose tool started them.
  expect(first.host.get(sessionJob.id)?.status).toBe("running")
  // Its listeners went with it.
  start(first.host.forSession({ sessionId: "later", depth: 0 }))
  expect(changes).toEqual([])
  await first.host.stopAll(() => true, 0)

  const second = fakeHost()
  const exiting = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    backgroundJobs: second.host,
  })
  const exitJob = start(second.host.forSession({ sessionId: "main", depth: 0 }))
  await exiting.runExitHandlers(10, 0)
  expect(second.host.get(exitJob.id)?.status).toBe("stopped")
})
