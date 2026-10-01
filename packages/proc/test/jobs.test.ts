import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  backgroundJobs,
  type JobEvent,
  JobLimitError,
  JobRegistry,
  liveJobPids,
  PASSIVE_SIGNAL_LISTENER,
  resetCommandWorker,
  startJob,
} from "../src/index.ts"

// Spawns can take seconds on Windows machines with antivirus scanning.
setDefaultTimeout(60_000)

const bun = process.execPath
const cwd = process.cwd()
const tree = join(import.meta.dir, "fixtures", "tree.ts")
const host = join(import.meta.dir, "fixtures", "host.ts")

const dirs: string[] = []
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "amira-jobs-"))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await backgroundJobs.stopAll(() => true, 0)
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

async function waitUntil(check: () => boolean, what: string, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The pids a tree.ts run wrote, once all three are up. */
async function treePids(file: string): Promise<number[]> {
  const read = () => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [])
  await waitUntil(() => read().length >= 3, "the process tree to start")
  return read().map(Number)
}

/** Windows: whether tasklist still lists any of the pids (the process-tree check). */
function listedByTasklist(pids: number[]): number[] {
  if (process.platform !== "win32") return []
  const out = Bun.spawnSync(["tasklist", "/FO", "CSV", "/NH"], { stdout: "pipe", windowsHide: true })
  const listed = new Set(
    out.stdout
      .toString()
      .split(/\r?\n/)
      .map((l) => Number(l.split('","')[1]))
      .filter((n) => Number.isInteger(n)),
  )
  return pids.filter((p) => listed.has(p))
}

async function expectAllGone(pids: number[]) {
  await waitUntil(() => pids.every((p) => !alive(p)), `processes ${pids.join(", ")} to end`, 10_000)
  expect(listedByTasklist(pids)).toEqual([])
}

const script = (code: string) => [bun, "-e", code]

test("a job runs detached from its caller; its output is read incrementally", async () => {
  const job = backgroundJobs.start({
    command: "count",
    argv: script(
      "let i = 0; const t = setInterval(() => { console.log('line ' + ++i); if (i === 6) { clearInterval(t) } }, 50)",
    ),
    cwd,
  })
  expect(job.id).toMatch(/^job\d+$/)
  expect(["starting", "running"]).toContain(job.status)
  await backgroundJobs.waitFor(job.id, { pattern: /line 3/, timeoutMs: 20_000 })
  const first = backgroundJobs.readNew(job.id, "model")
  expect(first.text).toContain("line 1")
  expect(first.from).toBe(0)
  await backgroundJobs.waitFor(job.id, { timeoutMs: 20_000 })
  const second = backgroundJobs.readNew(job.id, "model")
  expect(second.from).toBe(first.to)
  expect(second.text).toContain("line 6")
  expect(second.text).not.toContain("line 1\n")
  // Another reader has its own place.
  expect(backgroundJobs.readNew(job.id, "other").text).toContain("line 1")
  const info = backgroundJobs.get(job.id)!
  expect(info).toMatchObject({ status: "exited", exitCode: 0, stopRequested: false })
  expect(info.pid).toBeGreaterThan(0)
  expect(info.contained).toBe(true)
})

test("waitFor resolves on a matching line, on the job's exit, or on the timeout", async () => {
  const job = backgroundJobs.start({
    command: "server",
    argv: script(
      "console.log('compiling'); setTimeout(() => console.log('Ready on http://localhost:3000'), 300); setInterval(() => {}, 1000)",
    ),
    cwd,
  })
  const ready = await backgroundJobs.waitFor(job.id, {
    pattern: /ready on .*:(\d+)/i,
    timeoutMs: 20_000,
  })
  expect(ready).toEqual({ reason: "match", line: "Ready on http://localhost:3000" })
  // The same line is not matched again from where the reader is now.
  const again = await backgroundJobs.waitFor(job.id, {
    pattern: /ready/i,
    from: backgroundJobs.output(job.id).to,
    timeoutMs: 200,
  })
  expect(again.reason).toBe("timeout")
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 100)
  expect(
    (await backgroundJobs.waitFor(job.id, { pattern: /never/, timeoutMs: 20_000, signal: abort.signal }))
      .reason,
  ).toBe("aborted")
  const ending = backgroundJobs.waitFor(job.id, { pattern: /never/, timeoutMs: 20_000 })
  await backgroundJobs.stop(job.id, 0)
  expect((await ending).reason).toBe("exit")
})

test("stop kills the whole tree, grandchildren included", async () => {
  const dir = tempDir()
  const pidFile = join(dir, "pids")
  const job = backgroundJobs.start({ command: "tree", argv: [bun, tree, pidFile], cwd })
  const pids = await treePids(pidFile)
  expect(pids.every(alive)).toBe(true)
  expect(liveJobPids()).toContain(backgroundJobs.get(job.id)!.pid!)
  // While jobs run, a passive listener kills them on SIGTERM and SIGHUP, leaving the rest to others.
  const passive = (signal: NodeJS.Signals) =>
    process.listeners(signal).filter((l) => (l as never)[PASSIVE_SIGNAL_LISTENER])
  expect(passive("SIGTERM")).toHaveLength(1)
  expect(passive("SIGHUP")).toHaveLength(1)
  const ended = await backgroundJobs.stop(job.id)
  expect(ended.status).toBe("stopped")
  expect(ended.stopRequested).toBe(true)
  await expectAllGone(pids)
  expect(liveJobPids()).not.toContain(ended.pid!)
  // None run: the listeners are gone again.
  expect(passive("SIGTERM")).toHaveLength(0)
})

test("a job whose main process exits takes what it left running with it", async () => {
  const dir = tempDir()
  const pidFile = join(dir, "pids")
  // The main process starts the tree's root and exits once it is up: the tree must not stay.
  const code = `
    const { spawn } = Bun
    spawn([process.execPath, ${JSON.stringify(tree)}, ${JSON.stringify(pidFile)}], { stdio: ["ignore", "inherit", "inherit"] })
    const fs = require("node:fs")
    const t = setInterval(() => {
      const n = fs.existsSync(${JSON.stringify(pidFile)}) ? fs.readFileSync(${JSON.stringify(pidFile)}, "utf8").trim().split("\\n").length : 0
      if (n >= 3) { clearInterval(t); process.exit(7) }
    }, 20)`
  const job = backgroundJobs.start({ command: "crash", argv: script(code), cwd })
  const done = await backgroundJobs.waitFor(job.id, { timeoutMs: 30_000 })
  expect(done.reason).toBe("exit")
  expect(backgroundJobs.get(job.id)).toMatchObject({ status: "exited", exitCode: 7 })
  await expectAllGone(await treePids(pidFile))
})

test("output also goes to the log file; a job that cannot start fails", async () => {
  const dir = tempDir()
  const logPath = join(dir, "logs", "job.log")
  const job = backgroundJobs.start({
    command: "hello",
    argv: script("console.log('to the log'); console.error('and stderr')"),
    cwd,
    logPath,
  })
  await backgroundJobs.waitFor(job.id, { timeoutMs: 20_000 })
  const log = readFileSync(logPath, "utf8")
  expect(log).toContain("to the log")
  expect(log).toContain("and stderr")
  expect(backgroundJobs.get(job.id)!.logPath).toBe(logPath)

  const bad = backgroundJobs.start({ command: "nope", argv: script("1"), cwd: join(dir, "missing") })
  await backgroundJobs.waitFor(bad.id, { timeoutMs: 20_000 })
  expect(backgroundJobs.get(bad.id)).toMatchObject({ status: "failed" })
  expect(backgroundJobs.get(bad.id)!.error).toBeTruthy()
})

test("the log stops at its size limit", async () => {
  const dir = tempDir()
  const logPath = join(dir, "job.log")
  const job = backgroundJobs.start({
    command: "loud",
    argv: script("for (let i = 0; i < 200; i++) console.log('x'.repeat(99))"),
    cwd,
    logPath,
    maxLogBytes: 1000,
  })
  await backgroundJobs.waitFor(job.id, { timeoutMs: 20_000 })
  const log = readFileSync(logPath, "utf8")
  expect(log.length).toBeLessThan(1200)
  expect(log).toContain("[log stopped here: it reached 1000 bytes]")
  // Memory still has all of it.
  expect(backgroundJobs.get(job.id)!.outputChars).toBeGreaterThan(19_000)
})

test.skipIf(process.platform === "win32")(
  "POSIX: stop asks the process group to stop before killing it",
  async () => {
    const dir = tempDir()
    const pidFile = join(dir, "pids")
    const termLog = join(dir, "term")
    const job = backgroundJobs.start({
      command: "tree",
      argv: [bun, tree, pidFile, "0", "--term-log", termLog],
      cwd,
    })
    const pids = await treePids(pidFile)
    await backgroundJobs.stop(job.id, 3000)
    await expectAllGone(pids)
    // Every process of the group got the SIGTERM.
    expect(readFileSync(termLog, "utf8").trim().split("\n")).toHaveLength(3)
  },
)

/** Runs fixtures/host.ts, which ends as `how` says once its job's tree is up. */
async function runHost(how: string) {
  const dir = tempDir()
  const pidFile = join(dir, "pids")
  const child = Bun.spawn([bun, host, pidFile, how], { stdout: "pipe", stderr: "pipe", cwd })
  return { child, pidFile }
}

for (const how of ["exit", "crash", ...(process.platform === "win32" ? [] : ["sigterm"])]) {
  test(`Amira ending (${how}) leaves no process of a job behind`, async () => {
    const { child, pidFile } = await runHost(how)
    await child.exited
    const pids = await treePids(pidFile)
    await expectAllGone(pids)
  })
}

test("Amira killed outright leaves no process of a job behind on Windows (the Job Object)", async () => {
  const { child, pidFile } = await runHost("wait")
  const pids = await treePids(pidFile)
  const reader = child.stdout.getReader()
  await reader.read()
  // TerminateProcess on Windows, SIGKILL elsewhere: no exit hook runs.
  child.kill("SIGKILL")
  await child.exited
  if (process.platform === "win32") return expectAllGone(pids)
  // POSIX has no equivalent of kill-on-close: the jobs outlive a SIGKILL. Clean up here.
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
})

test("a job keeps running on this thread when the worker cannot load", async () => {
  resetCommandWorker({ url: new URL("./does-not-exist.ts", import.meta.url).href })
  try {
    const events: JobEvent[] = []
    let resolveExit = () => {}
    const exited = new Promise<void>((r) => {
      resolveExit = r
    })
    startJob({ argv: script("console.log('inline')"), cwd }, (e) => {
      events.push(e)
      if (e.type === "exit") resolveExit()
    })
    await exited
    expect(events[0]).toMatchObject({ type: "spawned" })
    expect(
      events
        .filter((e) => e.type === "output")
        .map((e) => (e as { data: string }).data)
        .join(""),
    ).toContain("inline")
    expect(events.at(-1)).toMatchObject({ type: "exit", code: 0 })
  } finally {
    resetCommandWorker()
  }
})

// The registry's own bookkeeping, over a fake process.
function fakeRegistry(opts: { maxRunning?: number; bufferChars?: number } = {}) {
  const procs: { emit: (e: JobEvent) => void; stops: number[] }[] = []
  const registry = new JobRegistry({
    ...opts,
    start: (_spec, onEvent) => {
      const p = { emit: onEvent, stops: [] as number[] }
      procs.push(p)
      return { stop: (g: number) => void p.stops.push(g) }
    },
  })
  return { registry, procs }
}

test("limits: running jobs are capped and the buffer keeps only the latest output", async () => {
  const { registry, procs } = fakeRegistry({ maxRunning: 2, bufferChars: 1000 })
  const a = registry.start({ command: "a", argv: ["a"], cwd })
  registry.start({ command: "b", argv: ["b"], cwd })
  expect(() => registry.start({ command: "c", argv: ["c"], cwd })).toThrow(JobLimitError)
  procs[0]!.emit({ type: "spawned", pid: 1, contained: true })
  for (let i = 0; i < 30; i++) procs[0]!.emit({ type: "output", data: `${String(i).padStart(99, ".")}\n` })
  const out = registry.readNew(a.id, "model")
  expect(out.dropped).toBeGreaterThan(0)
  expect(out.text.length).toBeLessThanOrEqual(1250)
  expect(out.text.endsWith(`${"29".padStart(99, ".")}\n`)).toBe(true)
  expect(registry.get(a.id)!.outputChars).toBe(3000)
  // A read capped by maxChars keeps the end.
  procs[0]!.emit({ type: "output", data: "abcdefghij" })
  expect(registry.readNew(a.id, "model", 4)).toMatchObject({ text: "ghij", dropped: 6 })
  expect(registry.tail(a.id, 150)).toBe(`${"29".padStart(99, ".")}\nabcdefghij`)
  // A stopped job frees its place.
  const stopping = registry.stop(a.id, 500)
  expect(procs[0]!.stops).toEqual([500])
  procs[0]!.emit({ type: "exit", code: null, signal: "SIGTERM" })
  expect(await stopping).toMatchObject({ status: "stopped", signal: "SIGTERM" })
  expect(registry.start({ command: "c", argv: ["c"], cwd }).id).toBe("job3")
})

test("a pattern is matched line by line, also across output chunks", async () => {
  const { registry, procs } = fakeRegistry()
  const job = registry.start({ command: "a", argv: ["a"], cwd })
  procs[0]!.emit({ type: "spawned", pid: 1, contained: true })
  const waiting = registry.waitFor(job.id, { pattern: /listening on port \d+/, from: 0, timeoutMs: 5000 })
  procs[0]!.emit({ type: "output", data: "starting\nlisten" })
  procs[0]!.emit({ type: "output", data: "ing on port 30" })
  procs[0]!.emit({ type: "output", data: "00 (pid 1)\r\nmore\n" })
  expect(await waiting).toEqual({ reason: "match", line: "listening on port 3000 (pid 1)" })
})

test("an unfinished last line matches once output pauses, as a prompt without a line break would", async () => {
  const { registry, procs } = fakeRegistry()
  const job = registry.start({ command: "a", argv: ["a"], cwd })
  procs[0]!.emit({ type: "spawned", pid: 1, contained: true })
  const waiting = registry.waitFor(job.id, { pattern: /press q to quit/i, timeoutMs: 5000 })
  procs[0]!.emit({ type: "output", data: "built\nPress q to quit" })
  expect(await waiting).toEqual({ reason: "match", line: "Press q to quit" })
})

test("listeners hear starts, status changes, output and ends; a failing one does not matter", () => {
  const { registry, procs } = fakeRegistry()
  const seen: string[] = []
  registry.subscribe(() => {
    throw new Error("bad listener")
  })
  const off = registry.subscribe((c) => seen.push(`${c.type}:${c.job.status}`))
  registry.start({ command: "a", argv: ["a"], cwd, owner: "s_child", meta: { shell: "bash" } })
  procs[0]!.emit({ type: "spawned", pid: 1, contained: false })
  procs[0]!.emit({ type: "output", data: "x" })
  procs[0]!.emit({ type: "exit", code: 2, signal: null })
  off()
  expect(seen).toEqual(["start:starting", "status:running", "output:running", "end:exited"])
  expect(registry.list()[0]).toMatchObject({
    owner: "s_child",
    meta: { shell: "bash" },
    contained: false,
    exitCode: 2,
  })
})

test("a pattern only ever sees whole lines: not a line's end read on its own, nor two lines together", async () => {
  const { registry, procs } = fakeRegistry()
  const job = registry.start({ command: "a", argv: ["a"], cwd })
  const p = procs[0]!
  p.emit({ type: "spawned", pid: 1, contained: true })
  p.emit({ type: "output", data: "Not " })
  const read = registry.readNew(job.id, "model")
  const anchored = registry.waitFor(job.id, { pattern: /^ready$/, from: read.to, timeoutMs: 300 })
  const spanning = registry.waitFor(job.id, { pattern: /ready\s+on/, from: read.to, timeoutMs: 300 })
  p.emit({ type: "output", data: "ready\non\n" })
  expect((await anchored).reason).toBe("timeout")
  expect((await spanning).reason).toBe("timeout")
})

test("a matching line is seen even when the same chunk floods the buffer past it", async () => {
  const { registry, procs } = fakeRegistry({ bufferChars: 1000 })
  const job = registry.start({ command: "a", argv: ["a"], cwd })
  procs[0]!.emit({ type: "spawned", pid: 1, contained: true })
  const waiting = registry.waitFor(job.id, { pattern: /listening/, from: 0, timeoutMs: 2000 })
  procs[0]!.emit({
    type: "output",
    data: `listening on 3000\n${"x".repeat(99)}\n${`${"y".repeat(99)}\n`.repeat(30)}`,
  })
  expect(await waiting).toEqual({ reason: "match", line: "listening on 3000" })
  // The buffer was cut at a line start.
  expect(registry.output(job.id).text.startsWith("y")).toBe(true)
})

test("ended jobs are forgotten oldest end first; one that just ended is kept for its waiters", async () => {
  const { registry, procs } = fakeRegistry({ maxRunning: 100 })
  const first = registry.start({ command: "long", argv: ["a"], cwd })
  procs[0]!.emit({ type: "spawned", pid: 1, contained: true })
  for (let i = 1; i <= 50; i++) {
    registry.start({ command: `short ${i}`, argv: ["a"], cwd })
    procs[i]!.emit({ type: "exit", code: 0, signal: null })
  }
  const waiting = registry.waitFor(first.id, { timeoutMs: 2000 })
  procs[0]!.emit({ type: "exit", code: 0, signal: null })
  expect((await waiting).reason).toBe("exit")
  expect(registry.get(first.id)?.status).toBe("exited")
  expect(registry.get("job2")).toBeUndefined()
  expect(registry.list()).toHaveLength(50)
})
