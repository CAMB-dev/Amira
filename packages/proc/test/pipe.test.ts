import { afterEach, expect, spyOn, test } from "bun:test"
import {
  SPAWN_TEST_TIMEOUT_MS,
  SPAWN_WAIT_TIMEOUT_MS,
  waitForSpawnCondition,
  waitForSpawnWork,
} from "../../../scripts/spawn-test.ts"
import {
  killLivePipes,
  livePipePids,
  openPipe,
  type PipeEvent,
  type PipeProcess,
  resetCommandWorker,
} from "../src/index.ts"

import { cleanupProcWork, runCommand, stopCommands } from "./spawn-fixture.ts"

const bun = process.execPath
const cwd = process.cwd()
const env = () => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") out[k] = v
  return out
}

function killPipesBounded() {
  const original = Bun.spawnSync
  const spawn = spyOn(Bun, "spawnSync").mockImplementation(((argv: string[], opts: object = {}) =>
    original(argv, { ...opts, timeout: SPAWN_WAIT_TIMEOUT_MS })) as typeof Bun.spawnSync)
  try {
    killLivePipes()
  } finally {
    spawn.mockRestore()
  }
}

const openedPipes = new Set<ReturnType<typeof open>>()
const grandchildren = new Set<number>()
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
afterEach(async () => {
  await cleanupProcWork([
    stopCommands,
    async () => {
      for (const p of openedPipes) p.pipe.close(0)
      killPipesBounded()
      try {
        await Promise.all([...openedPipes].map((p) => p.exited))
        await waitForSpawnCondition("pipe registry cleanup", () => livePipePids().length === 0)
      } finally {
        // The launcher deliberately detaches its child; the pipe owner cannot reap it.
        for (const pid of grandchildren) {
          if (!alive(pid)) continue
          try {
            process.kill(pid, "SIGKILL")
          } catch {}
        }
        await waitForSpawnCondition("launcher grandchildren cleanup", () =>
          [...grandchildren].every((pid) => !alive(pid)),
        )
        grandchildren.clear()
      }
      openedPipes.clear()
    },
  ])
}, SPAWN_TEST_TIMEOUT_MS)

/** Opens a pipe and collects its events; `spawned` resolves with the first one. */
function open(argv: string[]) {
  const events: PipeEvent[] = []
  let stdout = ""
  const pipe: PipeProcess = openPipe({ argv, cwd, env: env() }, (e) => {
    events.push(e)
    if (e.type === "stdout") {
      stdout += e.data
      const pid = stdout.match(/grandchild:(\d+)\r?\n/)?.[1]
      if (pid) grandchildren.add(Number(pid))
    }
  })
  const until = (done: () => boolean) => waitForSpawnCondition(`pipe ${argv[0]} condition`, done)
  const opened = {
    pipe,
    events,
    stdout: () => stdout,
    get spawned() {
      return until(() => events.length > 0)
    },
    get exited() {
      return until(() => events.some((e) => e.type === "exit"))
    },
    until,
  }
  openedPipes.add(opened)
  return opened
}

const ECHO =
  "process.stdin.on('data', (d) => process.stdout.write('echo:' + d)); process.stdin.on('end', () => process.exit(4))"

test(
  "a piped process streams stdin and stdout and reports its exit",
  async () => {
    const p = open([bun, "-e", ECHO])
    // Written before the spawn is known; it must still arrive.
    p.pipe.write("one\n")
    await p.spawned
    expect(p.events[0]).toMatchObject({ type: "spawned" })
    await p.until(() => p.stdout().includes("echo:one"))
    p.pipe.write("two\n")
    await p.until(() => p.stdout().includes("echo:two"))
    p.pipe.close(5000)
    await p.exited
    expect(p.events.at(-1)).toEqual({ type: "exit", code: 4 })
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "close kills a piped process that ignores the end of stdin",
  async () => {
    const p = open([bun, "-e", "process.stdin.resume(); setTimeout(() => {}, 60_000)"])
    await p.spawned
    const started = performance.now()
    p.pipe.close(200)
    await p.exited
    expect(performance.now() - started).toBeLessThan(15_000)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a program that cannot start reports an exit with an error",
  async () => {
    const p = open([`${cwd}/definitely-missing-program-${Date.now()}`])
    await p.exited
    expect(p.events).toHaveLength(1)
    expect(p.events[0]).toMatchObject({ type: "exit", code: null })
    expect((p.events[0] as { error?: string }).error).toBeTruthy()
  },
  SPAWN_TEST_TIMEOUT_MS,
)

// On Windows, libuv makes a child's pipe ends inheritable during CreateProcess. When piped
// processes were spawned on another thread, a long-lived one started at that moment inherited
// a short command's stdout, so the command stayed unsettled for its drain grace. With a separate
// spawning thread this failed nearly every run.
test(
  "long-lived piped processes never hold a short command's pipes open",
  async () => {
    const long = process.platform === "win32" ? ["ping", "-n", "4", "127.0.0.1"] : ["sleep", "3"]
    const short =
      process.platform === "win32" ? [`${process.env.SystemRoot}\\System32\\hostname.exe`] : ["true"]
    const opened: ReturnType<typeof open>[] = []
    let opening = true
    let stopping = false
    const opener = (async () => {
      for (let i = 0; i < 40 && !stopping; i++) {
        const p = open(long)
        opened.push(p)
        await p.spawned
      }
      opening = false
    })()
    // The symptom is settled: false after the drain grace; ms is kept for diagnostics.
    const slow: { settled: boolean; ms: number }[] = []
    let runs = 0
    const commands = async () => {
      while (!stopping && (opening || runs < 4)) {
        const started = performance.now()
        const run = await runCommand(short, { cwd, timeoutMs: 30_000, signal: new AbortController().signal })
        const ms = performance.now() - started
        runs++
        expect(run.exitCode).toBe(0)
        if (!run.settled) slow.push({ settled: run.settled, ms: Math.round(ms) })
      }
    }
    const work = Promise.all([opener, commands(), commands()])
    try {
      await work
    } finally {
      stopping = true
      opening = false
      await waitForSpawnWork("pipe opener cleanup", opener)
      for (const p of opened) p.pipe.close(0)
      await Promise.all(opened.map((p) => p.exited))
    }
    expect(slow).toEqual([])
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "piped processes run on this thread when the worker cannot load",
  async () => {
    // Intentionally missing: the worker never loads.
    resetCommandWorker({ url: new URL("./does-not-exist.ts", import.meta.url).href })
    try {
      const p = open([bun, "-e", ECHO])
      p.pipe.write("inline\n")
      await p.until(() => p.stdout().includes("echo:inline"))
      p.pipe.close(5000)
      await p.exited
      expect(p.events.at(-1)).toEqual({ type: "exit", code: 4 })
      // A close sent before the worker was known to be missing is replayed too.
      const early = open([bun, "-e", ECHO])
      early.pipe.write("x\n")
      early.pipe.close(5000)
      await early.exited
      expect(early.events.at(-1)).toEqual({ type: "exit", code: 4 })
    } finally {
      resetCommandWorker()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

// Launchers such as npx.cmd leave a grandchild holding stdout after they exit.
const LAUNCHER = [
  "const c = require('child_process').spawn(process.execPath, ['-e',",
  "  'setTimeout(() => console.log(\"late\"), 1000); setTimeout(() => {}, 3000)'],",
  "  { stdio: ['ignore', 'inherit', 'inherit'], detached: true })",
  "c.unref(); console.log('early'); console.log('grandchild:' + c.pid); setTimeout(() => process.exit(0), 100)",
].join("\n")

for (const where of ["the worker", "this thread"]) {
  test(
    `nothing follows the exit event when a grandchild holds stdout (${where})`,
    async () => {
      // Intentionally missing: the worker never loads.
      if (where === "this thread")
        resetCommandWorker({ url: new URL("./does-not-exist.ts", import.meta.url).href })
      try {
        const p = open([bun, "-e", LAUNCHER])
        await p.exited
        const exitAt = p.events.findIndex((e) => e.type === "exit")
        await Bun.sleep(2000)
        expect(p.events.length).toBe(exitAt + 1)
        expect(p.stdout()).not.toContain("late")
      } finally {
        if (where === "this thread") resetCommandWorker()
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}

test(
  "a lost worker ends its piped processes with an error",
  async () => {
    // Stay alive even if losing the worker closes stdin; cleanup still owns this process.
    const p = open([bun, "-e", "process.stdin.resume(); setTimeout(() => {}, 60_000)"])
    await p.spawned
    const pid = (p.events[0] as { pid: number }).pid
    try {
      resetCommandWorker()
      await p.exited
      expect(p.events.at(-1)).toMatchObject({ type: "exit", code: null, error: expect.any(String) })
    } finally {
      // A direct kill leaves the lost worker's PID registered: later cleanup could kill a reused PID.
      killPipesBounded()
    }
    expect(livePipePids()).not.toContain(pid)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "piped processes are tracked until they exit, so killLivePipes can end what is left at exit",
  async () => {
    const done = open([bun, "-e", ECHO])
    const left = open([bun, "-e", "process.stdin.resume(); setTimeout(() => {}, 60_000)"])
    await Promise.all([done.spawned, left.spawned])
    const pidOf = (p: ReturnType<typeof open>) => (p.events[0] as { pid: number }).pid
    expect(livePipePids()).toEqual(expect.arrayContaining([pidOf(done), pidOf(left)]))
    done.pipe.close(5000)
    await done.exited
    expect(livePipePids()).not.toContain(pidOf(done))
    // What Amira's exit hook does: the tree of every pipe still running is killed.
    killPipesBounded()
    await left.exited
    expect(livePipePids()).not.toContain(pidOf(left))
  },
  SPAWN_TEST_TIMEOUT_MS,
)
