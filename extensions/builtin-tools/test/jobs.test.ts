import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  BackgroundJobDetails,
  EventEnvelope,
  ExtensionAPI,
  NoticeLevel,
  PanelDefinition,
  Settings,
  ToolSession,
  UserMessage,
} from "@amira/api"
import { backgroundJobs, JobRegistry, resetCommandWorker, startJob } from "@amira/proc"
import { bashTool, createPowershellTool } from "../src/bash.ts"
import {
  jobListTool,
  jobOutputTool,
  jobStopTool,
  jobsConfig,
  STARTUP_WAIT_MS,
  waitPattern,
} from "../src/jobs.ts"
import { jobListPresenter, jobOutputPresenter, jobStopPresenter, registerJobs } from "../src/jobs-ui.ts"
import { shellPresenter } from "../src/presenters.ts"
import { resolveShell } from "../src/shell.ts"
import { makeCtx, tempDirs, textOf } from "./util.ts"

// Spawns can stall for seconds on Windows machines with antivirus scanning.
setDefaultTimeout(60_000)

const tmp = tempDirs()
let dir: string
const hasBash = (await resolveShell()).kind === "bash"
const onWindows = process.platform === "win32"
const bun = JSON.stringify(process.execPath.replaceAll("\\", "/"))
const treeFixture = JSON.stringify(
  join(import.meta.dir, "..", "..", "..", "packages", "proc", "test", "fixtures", "tree.ts").replaceAll(
    "\\",
    "/",
  ),
)

beforeAll(async () => {
  dir = await tmp.make("amira-jobs-tools-")
  await writeFile(
    join(dir, "server.js"),
    "console.log('compiling'); setTimeout(() => console.log('ready on port 3000'), 400); setInterval(() => {}, 1000)",
  )
  await writeFile(
    join(dir, "late-fail.js"),
    "setTimeout(() => { console.error('boom'); process.exit(4) }, 2500)",
  )
}, 60_000)
afterEach(async () => {
  await jobsConfig.registry.stopAll(() => true, 0)
  jobsConfig.registry = backgroundJobs
})
afterAll(() => tmp.cleanup())

interface Delivered {
  message: UserMessage
  opts?: { wake?: boolean }
}

/** A tool session as an agent gives one: the top-level one (depth 0) or a sub-agent's. */
function session(sessionId: string, depth = 0, delivered?: Delivered[]): ToolSession {
  return {
    sessionId,
    depth,
    maxDepth: 2,
    model: { provider: "mock", model: "m" },
    dir: join(dir, sessionId),
    deferredTools: () => [],
    loadTools: () => [],
    ...(delivered
      ? {
          expectNotice: () => ({
            deliver: (message: UserMessage, opts?: { wake?: boolean }) =>
              void delivered.push({ message, ...(opts ? { opts } : {}) }),
            cancel() {},
          }),
        }
      : {}),
  }
}

const ctxIn = (s?: ToolSession, signal?: AbortSignal) => ({
  ...makeCtx(dir, signal),
  ...(s ? { session: s } : {}),
})
const detailsOf = (r: { details?: unknown }) => r.details as BackgroundJobDetails

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function waitUntil(check: () => boolean, what: string, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}

test.if(hasBash)(
  "bash with background: true starts a job; job_output waits for a line; job_stop ends it",
  async () => {
    const main = session("s_main")
    const started = performance.now()
    const r = await bashTool.execute({ command: `${bun} server.js`, background: true }, ctxIn(main))
    const text = textOf(r)
    expect(r.isError).toBe(false)
    expect(text).toMatch(/^Started background job job\d+ \(pid \d+\)\./)
    expect(text).toContain("job_output")
    expect(text).toContain("job_stop")
    const d = detailsOf(r)
    expect(d).toMatchObject({ status: "running", command: `${bun} server.js` })
    // It waited a moment for an early failure, no longer.
    expect(performance.now() - started).toBeLessThan(STARTUP_WAIT_MS + 15_000)
    // The log lives in the session's directory.
    expect(d.logPath!.startsWith(join(dir, "s_main", "jobs"))).toBe(true)

    const out = await jobOutputTool.execute(
      { job_id: d.jobId, wait_for: "ready on port \\d+", timeout: 20_000 },
      ctxIn(main),
    )
    expect(textOf(out)).toContain("Matched: ready on port 3000")
    expect(textOf(out)).toMatch(new RegExp(`Job ${d.jobId} is running \\(pid \\d+, started \\d+s ago\\)\\.`))
    expect(detailsOf(out).waited).toBe("match")

    const list = await jobListTool.execute({}, ctxIn(main))
    expect(textOf(list)).toMatch(new RegExp(`^${d.jobId} · running \\d+s · pid \\d+ · nothing unread · `))

    const stop = await jobStopTool.execute({ job_id: d.jobId }, ctxIn(main))
    expect(textOf(stop)).toStartWith(`Stopped job ${d.jobId}`)
    expect(detailsOf(stop).status).toBe("stopped")
    await waitUntil(() => !alive(d.pid!), "the job's process to end")
    expect(readFileSync(d.logPath!, "utf8")).toContain("ready on port 3000")
    const again = await jobStopTool.execute({ job_id: d.jobId }, ctxIn(main))
    expect(textOf(again)).toBe(`Job ${d.jobId} had already ended: it was stopped.`)
  },
)

test.if(hasBash)("job_stop kills the whole tree a background command started", async () => {
  const pidFile = join(dir, "tree-pids").replaceAll("\\", "/")
  const r = await bashTool.execute(
    { command: `${bun} ${treeFixture} ${JSON.stringify(pidFile)}`, background: true },
    ctxIn(session("s_main")),
  )
  const read = () =>
    existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean) : []
  await waitUntil(() => read().length >= 3, "the process tree")
  const pids = read().map(Number)
  await jobStopTool.execute({ job_id: detailsOf(r).jobId }, ctxIn(session("s_main")))
  await waitUntil(() => pids.every((p) => !alive(p)), "every process of the tree to end", 10_000)
})

test.if(hasBash && onWindows)(
  "Windows: a lost command worker's Git Bash job still dies whole (its Job Object is ended from the main thread)",
  async () => {
    const pidFile = join(dir, "lost-pids").replaceAll("\\", "/")
    const r = await bashTool.execute(
      { command: `${bun} ${treeFixture} ${JSON.stringify(pidFile)}`, background: true },
      ctxIn(session("s_main")),
    )
    const read = () =>
      existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean) : []
    await waitUntil(() => read().length >= 3, "the process tree")
    const pids = read().map(Number)
    // taskkill /T cannot follow MSYS's broken parent chain; only the Job Object reaches them all.
    resetCommandWorker()
    const { jobId } = detailsOf(r)
    await waitUntil(() => backgroundJobs.get(jobId)!.status === "failed", "the job to be reported lost")
    expect(backgroundJobs.get(jobId)!.error).toBe("the command worker stopped unexpectedly")
    await waitUntil(() => pids.every((p) => !alive(p)), "every process of the tree to end", 10_000)
  },
)

test.if(hasBash)("a background command that fails at once is reported like a normal run", async () => {
  const r = await bashTool.execute(
    { command: "echo nope >&2; exit 3", background: true },
    ctxIn(session("s_main")),
  )
  expect(r.isError).toBe(true)
  expect(textOf(r)).toBe(
    `nope\n\nThe background job ${detailsOf(r).jobId} already ended: it exited with code 3.`,
  )
  expect(detailsOf(r)).toMatchObject({ status: "exited", exitCode: 3, outputLines: 1 })
})

test.if(onWindows)("powershell runs commands in the background too", async () => {
  const ps = createPowershellTool()
  const r = await ps.execute(
    {
      command:
        "Write-Output 'warming up'; Start-Sleep -Milliseconds 300; Write-Output 'ps ready'; Start-Sleep 60",
      background: true,
    },
    ctxIn(session("s_main")),
  )
  expect(textOf(r)).toMatch(/^Started background job job\d+/)
  const d = detailsOf(r)
  const out = await jobOutputTool.execute(
    { job_id: d.jobId, wait_for: "ps ready", timeout: 30_000 },
    ctxIn(session("s_main")),
  )
  expect(textOf(out)).toContain("Matched: ps ready")
  await jobStopTool.execute({ job_id: d.jobId }, ctxIn(session("s_main")))
  await waitUntil(() => !alive(d.pid!), "PowerShell to end")
})

test.if(hasBash)("a sub-agent sees only its own jobs, which stop when it ends", async () => {
  const child = session("s_child", 1)
  const r = await bashTool.execute({ command: `${bun} server.js`, background: true }, ctxIn(child))
  const { jobId, pid } = detailsOf(r)
  expect(backgroundJobs.get(jobId)!.owner).toBe("s_child")
  // The top-level session sees it; another sub-agent does not.
  expect((await jobListTool.execute({}, ctxIn(session("s_main")))).isError).toBeUndefined()
  expect(textOf(await jobListTool.execute({}, ctxIn(session("s_main"))))).toContain(jobId)
  const other = await jobOutputTool.execute({ job_id: jobId }, ctxIn(session("s_other", 1)))
  expect(other.isError).toBe(true)
  expect(textOf(other)).toStartWith(`No background job "${jobId}".`)
  expect(textOf(await jobListTool.execute({}, ctxIn(session("s_other", 1))))).toBe("No background jobs.")

  // The extension stops a sub-agent's jobs when it ends.
  const api = fakeApi()
  registerJobs(api.api)
  await api.emit("subagent.end", { childSessionId: "s_child" })
  await waitUntil(() => backgroundJobs.get(jobId)!.status === "stopped", "the sub-agent's job to stop")
  await waitUntil(() => !alive(pid!), "its process to end")
  expect(api.notices).toEqual([])
})

test.if(hasBash)(
  "a job that ends on its own: the user gets a notice, the model a message for its next turn",
  async () => {
    const delivered: Delivered[] = []
    const api = fakeApi()
    registerJobs(api.api)
    const r = await bashTool.execute(
      { command: `${bun} late-fail.js`, background: true },
      ctxIn(session("s_main", 0, delivered)),
    )
    const { jobId } = detailsOf(r)
    await waitUntil(() => delivered.length > 0, "the notice to the model")
    expect(delivered[0]!.opts).toEqual({ wake: false })
    const text = (delivered[0]!.message.content[0] as { text: string }).text
    expect(text).toStartWith(`Background job ${jobId} (${bun} late-fail.js) exited with code 4.`)
    expect(text).toContain("boom")
    expect(delivered[0]!.message.display).toMatchObject({ origin: "job" })
    await waitUntil(() => api.notices.length > 0, "the user's notice")
    expect(api.notices[0]).toEqual({
      text: `Background job ${jobId} exited with code 4: ${bun} late-fail.js`,
      level: "warning",
    })
  },
)

test.if(hasBash)("a job ending while job_output waits on it sends no extra message", async () => {
  const delivered: Delivered[] = []
  const s = session("s_main", 0, delivered)
  const r = await bashTool.execute({ command: `${bun} late-fail.js`, background: true }, ctxIn(s))
  const out = await jobOutputTool.execute({ job_id: detailsOf(r).jobId, timeout: 20_000 }, ctxIn(s))
  expect(out.isError).toBe(true)
  expect(textOf(out)).toBe(`boom\n\nJob ${detailsOf(r).jobId} exited with code 4.`)
  await Bun.sleep(100)
  expect(delivered).toEqual([])
})

test.if(hasBash)("job_output says so when it is polled without waiting", async () => {
  const s = session("s_main")
  const r = await bashTool.execute(
    { command: `${bun} -e "setInterval(() => {}, 1000)"`, background: true },
    ctxIn(s),
  )
  const { jobId } = detailsOf(r)
  const first = await jobOutputTool.execute({ job_id: jobId }, ctxIn(s))
  expect(textOf(first)).toStartWith("(no new output)")
  expect(textOf(first)).not.toContain("Do not poll")
  const second = await jobOutputTool.execute({ job_id: jobId }, ctxIn(s))
  expect(textOf(second)).toContain("Do not poll: pass wait_for")
  const timed = await jobOutputTool.execute({ job_id: jobId, wait_for: "never", timeout: 300 }, ctxIn(s))
  expect(textOf(timed)).toContain("No line matched /never/ within 300 ms.")
  expect(detailsOf(timed).waited).toBe("timeout")
})

test.if(hasBash)("the number of running jobs is capped", async () => {
  jobsConfig.registry = new JobRegistry({ start: startJob, maxRunning: 1 })
  const s = session("s_main")
  const first = await bashTool.execute({ command: `${bun} server.js`, background: true }, ctxIn(s))
  expect(first.isError).toBe(false)
  const second = await bashTool.execute({ command: `${bun} server.js`, background: true }, ctxIn(s))
  expect(second.isError).toBe(true)
  expect(textOf(second)).toContain(
    "1 background jobs are running, the most allowed (backgroundJobs.maxRunning)",
  )
  expect(textOf(second)).toContain(`Running: ${detailsOf(first).jobId}: ${bun} server.js`)
})

test.if(hasBash)("an interrupted start stops the job", async () => {
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 200)
  const r = await bashTool.execute(
    { command: `${bun} server.js`, background: true },
    ctxIn(session("s_main"), abort.signal),
  )
  expect(r.isError).toBe(true)
  expect(textOf(r)).toBe("Aborted while the background job was starting; it was stopped.")
  expect(backgroundJobs.running()).toEqual([])
})

test("unknown jobs and bad patterns", async () => {
  const r = await jobOutputTool.execute({ job_id: "job999" }, ctxIn(session("s_main")))
  expect(r.isError).toBe(true)
  expect(textOf(r)).toStartWith('No background job "job999".')
  expect((await jobStopTool.execute({ job_id: "" }, ctxIn())).isError).toBe(true)
  // Not a valid regular expression: looked for literally.
  expect(waitPattern("port (3000").test("listening on PORT (3000)")).toBe(true)
  expect(waitPattern("ready|listening").test("Listening on 5173")).toBe(true)
})

test("settings set the limits of the registry the extension serves; removed ones go back to the defaults", () => {
  const registry = new JobRegistry({ start: startJob })
  registerJobs(fakeApi({ backgroundJobs: { maxRunning: 3, maxLogBytes: 1000 } }).api, registry)
  expect(registry.maxRunning).toBe(3)
  expect(jobsConfig.maxLogBytes).toBe(1000)
  registerJobs(fakeApi().api, registry)
  expect(registry.maxRunning).toBe(8)
  expect(jobsConfig.maxLogBytes).toBeUndefined()
  // The tools' registry is not swapped by registering the UI for another.
  expect(jobsConfig.registry).toBe(backgroundJobs)
})

test("Amira's exit stops every job; the exit handler kills them when it cannot wait", async () => {
  const procs: { stops: number[]; emit: (e: Parameters<Parameters<typeof startJob>[1]>[0]) => void }[] = []
  const registry = new JobRegistry({
    start: (_spec, onEvent) => {
      const p = { stops: [] as number[], emit: onEvent }
      procs.push(p)
      return { stop: (g: number) => void p.stops.push(g) }
    },
  })
  const api = fakeApi()
  registerJobs(api.api, registry)
  registry.start({ command: "a", argv: ["a"], cwd: dir })
  procs[0]!.emit({ type: "spawned", pid: 1, contained: true })
  const abort = new AbortController()
  const exiting = api.exit(abort.signal)
  expect(procs[0]!.stops).toEqual([2000])
  abort.abort()
  expect(procs[0]!.stops).toEqual([2000, 0])
  procs[0]!.emit({ type: "exit", code: null, signal: null })
  await exiting
  expect(registry.running()).toEqual([])
  // Stopped by Amira: no notice.
  expect(api.notices).toEqual([])
})

test("presenters: a background start, a read, a stop and the list", () => {
  const job = (status: string, extra: Partial<BackgroundJobDetails> = {}) => ({
    jobId: "job2",
    command: "npm run dev",
    status,
    exitCode: null,
    outputLines: 2,
    ...extra,
  })
  const call = <A>(args: A, text: string, details: any, isError = false) => ({
    args,
    result: { content: [{ type: "text" as const, text }], details, ...(isError ? { isError } : {}) },
    text,
  })
  const opts = { detail: "summary" as const, width: 80 }
  const started = call(
    { command: "npm run dev", background: true },
    "Started background job job2 (pid 7).\n\nOutput so far:\n> vite\nready in 300 ms\n\nIt keeps running after this call.",
    job("running", { pid: 7 }),
  )
  expect(shellPresenter.summary!(started.args)).toBe("npm run dev · background")
  expect(shellPresenter.result!(started)).toBe("started job2")
  expect(shellPresenter.body!(started, opts)).toEqual([
    { kind: "code", text: "> vite" },
    { kind: "code", text: "ready in 300 ms" },
  ])
  const ended = call(
    { command: "x", background: true },
    "nope\n\nThe background job job2 already ended: it exited with code 3.",
    job("exited", { exitCode: 3, outputLines: 1 }),
    true,
  )
  expect(shellPresenter.result!(ended)).toBe("job2 ended at once · exit 3")
  expect(shellPresenter.body!(ended, opts)).toEqual([{ kind: "code", text: "nope" }])

  const read = call(
    { job_id: "job2", wait_for: "ready" },
    "a\nb\nready\n\nMatched: ready\n\nJob job2 is running (pid 7, started 3s ago).",
    job("running", { outputLines: 3, waited: "match" }),
  )
  expect(jobOutputPresenter.summary!(read.args)).toBe("job2 · wait for /ready/")
  expect(jobOutputPresenter.result!(read)).toBe("matched · 3 new lines · running")
  expect(jobOutputPresenter.body!(read, opts).map((l) => l.text)).toEqual(["a", "b", "ready"])
  const stopped = call({ job_id: "job2" }, "Stopped job job2 (npm run dev).", job("stopped"))
  expect(jobStopPresenter.result!(stopped)).toBe("stopped")
  const list = call({}, "job2 · …", {
    jobs: [{ jobId: "job2", command: "x", status: "running", exitCode: null }],
  })
  expect(jobListPresenter.result!(list)).toBe("1 job · 1 running")
})

/** The parts of ExtensionAPI registerJobs uses, recording what it registers. */
function fakeApi(settings: Settings = {}) {
  const handlers = new Map<string, ((e: EventEnvelope<never>) => void)[]>()
  const exits: ((s: AbortSignal) => void | Promise<void>)[] = []
  const notices: { text: string; level: NoticeLevel | undefined }[] = []
  const panels: PanelDefinition[] = []
  const api = {
    settings,
    notify: (text: string, level?: NoticeLevel) => void notices.push({ text, level }),
    requestRender: () => {},
    registerPanel: (p: PanelDefinition) => {
      panels.push(p)
      return () => {}
    },
    registerCommand: () => () => {},
    registerView: () => () => {},
    on: (type: string, h: (e: EventEnvelope<never>) => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), h])
      return () => {}
    },
    onExit: (h: (s: AbortSignal) => void | Promise<void>) => {
      exits.push(h)
      return () => {}
    },
  } as unknown as ExtensionAPI
  return {
    api,
    notices,
    panels,
    async emit(type: string, data: unknown) {
      for (const h of handlers.get(type) ?? [])
        await h({ type, data, sessionId: "s_main", seq: 1, ts: 0 } as never)
    },
    exit: (signal: AbortSignal) => Promise.all(exits.map((h) => h(signal))),
  }
}
