import { expect, setDefaultTimeout, test } from "bun:test"
import { openPipe, type PipeEvent, type PipeProcess, resetCommandWorker, runCommand } from "../src/index.ts"

// Spawns can take seconds on Windows machines with antivirus scanning.
setDefaultTimeout(60_000)

const bun = process.execPath
const cwd = process.cwd()
const env = () => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") out[k] = v
  return out
}

/** Opens a pipe and collects its events; `spawned` resolves with the first one. */
function open(argv: string[]) {
  const events: PipeEvent[] = []
  let stdout = ""
  let onEvent: (() => void) | undefined
  const pipe: PipeProcess = openPipe({ argv, cwd, env: env() }, (e) => {
    events.push(e)
    if (e.type === "stdout") stdout += e.data
    onEvent?.()
  })
  const until = (done: () => boolean) =>
    new Promise<void>((resolve) => {
      if (done()) return resolve()
      const prev = onEvent
      onEvent = () => {
        prev?.()
        if (done()) resolve()
      }
    })
  return {
    pipe,
    events,
    stdout: () => stdout,
    spawned: until(() => events.length > 0),
    exited: until(() => events.some((e) => e.type === "exit")),
    until,
  }
}

const ECHO =
  "process.stdin.on('data', (d) => process.stdout.write('echo:' + d)); process.stdin.on('end', () => process.exit(4))"

test("a piped process streams stdin and stdout and reports its exit", async () => {
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
})

test("close kills a piped process that ignores the end of stdin", async () => {
  const p = open([bun, "-e", "process.stdin.resume(); setTimeout(() => {}, 60_000)"])
  await p.spawned
  const started = performance.now()
  p.pipe.close(200)
  await p.exited
  expect(performance.now() - started).toBeLessThan(15_000)
})

test("a program that cannot start reports an exit with an error", async () => {
  const p = open([`${cwd}/definitely-missing-program-${Date.now()}`])
  await p.exited
  expect(p.events).toHaveLength(1)
  expect(p.events[0]).toMatchObject({ type: "exit", code: null })
  expect((p.events[0] as { error?: string }).error).toBeTruthy()
})

// On Windows, libuv makes a child's pipe ends inheritable during CreateProcess. When piped
// processes were spawned on another thread, a long-lived one started at that moment inherited
// a short command's stdout, so the command stayed unsettled for its drain grace. With a separate
// spawning thread this failed nearly every run.
test("long-lived piped processes never hold a short command's pipes open", async () => {
  const long = process.platform === "win32" ? ["ping", "-n", "4", "127.0.0.1"] : ["sleep", "3"]
  const short =
    process.platform === "win32" ? [`${process.env.SystemRoot}\\System32\\hostname.exe`] : ["true"]
  const opened: ReturnType<typeof open>[] = []
  let opening = true
  const opener = (async () => {
    for (let i = 0; i < 40; i++) {
      const p = open(long)
      opened.push(p)
      await p.spawned
    }
    opening = false
  })()
  const slow: { settled: boolean; ms: number }[] = []
  let runs = 0
  const commands = async () => {
    while (opening || runs < 4) {
      const started = performance.now()
      const run = await runCommand(short, { cwd, timeoutMs: 30_000, signal: new AbortController().signal })
      const ms = performance.now() - started
      runs++
      expect(run.exitCode).toBe(0)
      if (!run.settled || ms > 1500) slow.push({ settled: run.settled, ms: Math.round(ms) })
    }
  }
  try {
    await Promise.all([opener, commands(), commands()])
  } finally {
    for (const p of opened) p.pipe.close(0)
    await Promise.all(opened.map((p) => p.exited))
  }
  expect(slow).toEqual([])
})

test("piped processes run on this thread when the worker cannot load", async () => {
  resetCommandWorker({ url: new URL("./does-not-exist.ts", import.meta.url).href })
  try {
    const p = open([bun, "-e", ECHO])
    p.pipe.write("inline\n")
    await p.until(() => p.stdout().includes("echo:inline"))
    p.pipe.close(5000)
    await p.exited
    expect(p.events.at(-1)).toEqual({ type: "exit", code: 4 })
  } finally {
    resetCommandWorker()
  }
})

test("a lost worker ends its piped processes with an error", async () => {
  const p = open([bun, "-e", ECHO])
  await p.spawned
  const pid = (p.events[0] as { pid: number }).pid
  resetCommandWorker()
  await p.exited
  expect(p.events.at(-1)).toMatchObject({ type: "exit", code: null, error: expect.any(String) })
  // The error tells the caller the process may survive; it is theirs to kill by pid.
  try {
    process.kill(pid, "SIGKILL")
  } catch {}
})
