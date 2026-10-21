import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import {
  SPAWN_TEST_TIMEOUT_MS,
  SPAWN_WAIT_TIMEOUT_MS,
  stopSpawn,
  waitForSpawnCondition,
  waitForSpawnExit,
} from "../../../scripts/spawn-test.ts"
import "../../../packages/core/src/index.ts"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { type ProcessTree, runCommand, trackProcessTree } from "../../../packages/proc/src/index.ts"
import { bashTool } from "../src/bash.ts"
import { resolveShell } from "../src/shell.ts"
import { cleanupSpawnWork, makeCtx, spawnWorkScope, tempDirs, textOf, waitForSpawnWork } from "./util.ts"

const work = spawnWorkScope("bash tool cleanup")
const execute = (...[params, ctx]: Parameters<typeof bashTool.execute>) =>
  work.run((signal) => bashTool.execute(params, { ...ctx, signal }), ctx.signal)
afterEach(() => work.cleanup(), SPAWN_TEST_TIMEOUT_MS)
const tmp = tempDirs()
let dir: string
const isWindows = process.platform === "win32"
const hasBash = (await resolveShell()).kind === "bash"

// On Windows, antivirus scanning can stall a spawn for several seconds, the first one per process especially.
beforeAll(async () => {
  dir = await tmp.make()
  if (hasBash) await execute({ command: "true" }, makeCtx(dir))
}, SPAWN_TEST_TIMEOUT_MS)
afterAll(async () => {
  await work.cleanup()
  await tmp.cleanup()
}, SPAWN_TEST_TIMEOUT_MS)

test.if(hasBash)(
  "returns combined output and exit code, running in cwd",
  async () => {
    const ctx = makeCtx(dir)
    const r = await execute({ command: "echo out; echo err >&2; echo hi > here.txt" }, ctx)
    expect(r.isError).toBe(false)
    expect(textOf(r)).toContain("out")
    expect(textOf(r)).toContain("err")
    expect(textOf(r)).toEndWith("Exit code: 0")
    expect(existsSync(join(dir, "here.txt"))).toBe(true)
    expect(ctx.updates.length).toBeGreaterThan(0)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(hasBash)(
  "finds coreutils and other tools on PATH",
  async () => {
    const r = await execute(
      { command: "which ls grep sed && ls >/dev/null && echo abc | grep -c b" },
      makeCtx(dir),
    )
    expect(textOf(r)).toEndWith("1\n\nExit code: 0")
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test("the shell description says commands already start in the working directory", () => {
  expect(bashTool.description).toContain("Fresh shell in cwd")
  expect(bashTool.description).not.toContain("Prefer absolute paths")
  expect(bashTool.description).toContain("0/141 (SIGPIPE)")
  expect(bashTool.description).toContain("except a successful final pipeline command")
  expect(bashTool.description).not.toContain("exit 141 (SIGPIPE)")
  expect(bashTool.description).toContain("still blocks && inside the shell")
  expect(bashTool.description).toContain("completion kills leftovers")
})

test.if(hasBash)(
  "a failed command before a pipeline keeps the bash error status",
  async () => {
    const r = await execute({ command: "false | tail -n 1" }, makeCtx(dir))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toEndWith("Exit code: 1")
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(hasBash)(
  "SIGPIPE-only pipelines succeed but real pipeline failures do not",
  async () => {
    const sigpipe = await execute({ command: "yes | head -n 1" }, makeCtx(dir))
    expect(sigpipe.isError).toBe(false)
    expect(textOf(sigpipe)).toEndWith("Exit code: 0")

    const gitLog = await execute({ command: "git log --oneline | head -n 1" }, makeCtx(process.cwd()))
    expect(gitLog.isError).toBe(false)

    // Only the final status changes: inside the command the pipeline still stops `&&`.
    const chained = await execute({ command: "yes | head -n 1 && echo after" }, makeCtx(dir))
    expect(chained.isError).toBe(false)
    expect(textOf(chained)).not.toContain("after")

    for (const command of ["false | cat", "cat missing | wc -l", "true | false"]) {
      const failed = await execute({ command }, makeCtx(dir))
      expect(failed.isError).toBe(true)
      expect(textOf(failed)).toEndWith("Exit code: 1")
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(hasBash)(
  "non-zero exit is reported as an error",
  async () => {
    const r = await execute({ command: "echo failing; exit 3" }, makeCtx(dir))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe("failing\n\nExit code: 3")
    expect(r.details).toMatchObject({ exitCode: 3, outputLines: 1, durationMs: expect.any(Number) })
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(hasBash)(
  "times out and kills the command",
  async () => {
    const start = Date.now()
    // Leave room for shell startup on loaded runners; still kill well before sleep completes.
    const r = await execute({ command: "echo before; sleep 30", timeout: 5000 }, makeCtx(dir))
    expect(Date.now() - start).toBeLessThan(25_000)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain("before")
    expect(textOf(r)).toContain("timed out after 5000 ms")
    expect(textOf(r)).toContain("longer `timeout`")
    expect(textOf(r)).toContain("`background: true`")
    expect(textOf(r)).toContain("job_output")
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(hasBash)(
  "a command that exits while a pipe holder survives is not a timeout, and output stops at return",
  async () => {
    const shell = await resolveShell()
    let real: ProcessTree | undefined
    let child: Bun.Subprocess | undefined
    let calls = 0
    try {
      const { argv, ...spawn } = shell.command(
        "(sleep 0.3; while true; do echo tick; sleep 0.1; done) & echo done",
        dir,
      )
      const run = await runCommand(argv, {
        ...spawn,
        // Test pipe-holder cleanup, not whether a loaded runner starts/reaps Bash within 1s.
        timeoutMs: 5000,
        signal: new AbortController().signal,
        onChunk: () => void calls++,
        // Contain the tree but leave it running, as if a pipe holder had escaped.
        trackTree(proc) {
          child = proc
          real = trackProcessTree(proc)
          return { contained: true, kill() {}, terminate: () => false, dispose() {} }
        },
      })
      expect(run).toMatchObject({ exitCode: 0, timedOut: false, aborted: false, settled: false })
      expect(run.output).toContain("done")
      expect(run.output).toContain("tick")
      const seen = calls
      await Bun.sleep(600)
      expect(calls).toBe(seen)
    } finally {
      real?.kill()
      try {
        if (child) await stopSpawn(child, "pipe-holder command cleanup")
      } finally {
        real?.dispose()
      }
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a missing working directory is reported clearly",
  async () => {
    const r = await execute({ command: "echo x" }, makeCtx(join(dir, "does-not-exist")))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toStartWith("Working directory does not exist:")
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(hasBash && !isWindows)(
  "a command killed by a signal says so",
  async () => {
    expect(textOf(await execute({ command: "kill -9 $$" }, makeCtx(dir)))).toContain("killed by signal")
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(hasBash)(
  "a normal exit 137 is not reported as a signal",
  async () => {
    const result = await execute({ command: "exit 137" }, makeCtx(dir))
    expect(result.isError).toBe(true)
    expect(textOf(result)).toEndWith("Exit code: 137")
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "errors when already aborted or when command is missing",
  async () => {
    const ac = new AbortController()
    ac.abort()
    expect((await execute({ command: "echo x" }, makeCtx(dir, ac.signal))).isError).toBe(true)
    expect((await execute({ command: "" }, makeCtx(dir))).isError).toBe(true)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a command containing NUL is rejected clearly",
  async () => {
    const r = await execute({ command: "echo a\0b" }, makeCtx(dir))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe("command must not contain NUL characters")
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(hasBash)(
  "large output is saved whole as an artifact and previewed",
  async () => {
    const r = await execute({ command: "seq 1 20000" }, makeCtx(dir))
    const text = textOf(r)
    const d = r.details as { fullOutputPath?: string; artifact?: string; outputLines: number }
    expect(d.artifact).toMatch(/^a_[0-9a-f]+$/)
    expect(text).toStartWith(`[Output saved as artifact ${d.artifact}: `)
    expect(text.split("\n")[1]).toBe("1")
    expect(text).toContain("20000\n\nExit code: 0")
    expect(text.length).toBeLessThan(9000)
    expect(d.outputLines).toBe(20000)
    expect(text).toContain(d.fullOutputPath!)
    const saved = await Bun.file(d.fullOutputPath!).text()
    expect(saved.split("\n")).toHaveLength(20000)
    expect(saved.endsWith("19999\n20000")).toBe(true)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

/**
 * A `sleep` duration that marks the processes a test creates: its own random digits, all of one
 * length, so no other run's marker (other suites may run on the machine too) contains it.
 */
function newMarker(whole: number): string {
  return `${whole}.${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}1`
}

/** The processes whose command line has `marker` (sleeps, and the shells that started them). */
async function marked(marker: string): Promise<{ pid: number; cmd: string }[]> {
  const argv = isWindows
    ? [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${marker}%'" | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`,
      ]
    : ["ps", "-eo", "pid=,args="]
  const proc = work.own(Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" }))
  let out: string
  let err: string
  let code: number
  try {
    ;[out, err, code] = await waitForSpawnWork(
      "process listing output",
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        waitForSpawnExit(proc, "process listing"),
      ]),
    )
  } finally {
    await stopSpawn(proc, "process listing cleanup")
  }
  if (code !== 0) throw new Error(`Process listing exited ${code}: ${err}`)
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2]! }))
    .filter((p) => p.cmd.includes(marker))
}

/** The marked processes left once they are all gone or `ms` passed: killing and listing take time. */
async function survivors(marker: string, ms = 10_000): Promise<{ pid: number; cmd: string }[]> {
  const deadline = performance.now() + ms
  let left = await marked(marker)
  while (left.length && performance.now() < deadline) {
    await Bun.sleep(200)
    left = await marked(marker)
  }
  return left
}

async function killMarked(procs: { pid: number }[]) {
  for (const p of procs) {
    try {
      process.kill(p.pid, "SIGKILL")
    } catch {}
  }
  await waitForSpawnCondition("marked process cleanup", () =>
    procs.every((p) => {
      try {
        process.kill(p.pid, 0)
        return false
      } catch (err) {
        return (err as NodeJS.ErrnoException).code !== "EPERM"
      }
    }),
  )
}

test.if(hasBash)(
  "abort kills background grandchildren with no survivors",
  async () => {
    const marker = newMarker(97)
    const ac = new AbortController()
    const ready = Promise.withResolvers<void>()
    const ctx = makeCtx(dir, ac.signal)
    ctx.update = (r) => {
      if (/^three sleeps started$/m.test(textOf(r))) ready.resolve()
    }
    // MSYS's /proc reports exec, not just fork. Confirm each sleep locally before signalling:
    // spawning PowerShell/CIM for every readiness poll competes with shell startup under load.
    // MSYS can expose an empty cmdline before exec; retry that read while the child is alive.
    const check = isWindows
      ? `while kill -0 "$pid" 2>/dev/null; do name=; IFS= read -r -d '' name < /proc/$pid/cmdline; [[ $name == sleep ]] && return; sleep 0.05; done`
      : `while kill -0 "$pid" 2>/dev/null; do [[ $(ps -p "$pid" -o comm=) == *sleep ]] && return; sleep 0.05; done`
    const command = [
      `start_sleep() { sleep ${marker} & local pid=$! name; ${check}; return 1; }`,
      // The first sleep is orphaned by its subshell, just as in the original abort scenario.
      "(start_sleep) && start_sleep && start_sleep && echo 'three sleeps started'; wait",
    ].join("\n")
    const run = execute({ command }, ctx)
    try {
      await waitForSpawnWork(
        "three sleeps to start",
        Promise.race([
          ready.promise,
          run.then((r) => {
            throw new Error(`Command ended before the sleeps were ready: ${textOf(r)}`)
          }),
        ]),
        SPAWN_WAIT_TIMEOUT_MS,
      )
      ac.abort()
      const r = await run
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain("aborted")

      // No sleep, and no shell that ran one, is left.
      expect(await survivors(marker)).toEqual([])
    } finally {
      ac.abort()
      await cleanupSpawnWork("background-grandchild cleanup", [
        () => run,
        async () => killMarked(await marked(marker)),
      ])
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(hasBash)(
  "the first call in a fresh process times out with no surviving grandchildren",
  async () => {
    const marker = newMarker(96)
    const fixture = join(import.meta.dir, "fixtures", "first-bash-call.ts")
    const child = work.own(
      Bun.spawn([process.execPath, fixture, marker, dir], { stdout: "pipe", stderr: "pipe" }),
    )
    try {
      const [out, err, code] = await waitForSpawnWork(
        "fresh bash fixture output",
        Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          waitForSpawnExit(child, "fresh bash fixture"),
        ]),
      )
      expect(err).toBe("")
      expect(code).toBe(0)
      const r = JSON.parse(out.trim().split("\n").at(-1)!)
      expect(r.text).toContain("timed out after 2000 ms")
      expect(await survivors(marker)).toEqual([])
    } finally {
      await cleanupSpawnWork("fresh bash fixture cleanup", [
        () => stopSpawn(child, "fresh bash fixture cleanup"),
        async () => killMarked(await marked(marker)),
      ])
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
