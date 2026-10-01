import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import "../../../packages/core/src/index.ts"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { type ProcessTree, runCommand, trackProcessTree } from "../../../packages/proc/src/index.ts"
import { bashTool } from "../src/bash.ts"
import { resolveShell } from "../src/shell.ts"
import { makeCtx, tempDirs, textOf } from "./util.ts"

const tmp = tempDirs()
let dir: string
const isWindows = process.platform === "win32"
const hasBash = (await resolveShell()).kind === "bash"

// On Windows, antivirus scanning can stall a spawn for several seconds, the first one per process especially.
setDefaultTimeout(30_000)
beforeAll(async () => {
  dir = await tmp.make()
  if (hasBash) await bashTool.execute({ command: "true" }, makeCtx(dir))
}, 60_000)
afterAll(() => tmp.cleanup())

test.if(hasBash)("returns combined output and exit code, running in cwd", async () => {
  const ctx = makeCtx(dir)
  const r = await bashTool.execute({ command: "echo out; echo err >&2; echo hi > here.txt" }, ctx)
  expect(r.isError).toBe(false)
  expect(textOf(r)).toContain("out")
  expect(textOf(r)).toContain("err")
  expect(textOf(r)).toEndWith("Exit code: 0")
  expect(existsSync(join(dir, "here.txt"))).toBe(true)
  expect(ctx.updates.length).toBeGreaterThan(0)
})

test.if(hasBash)("finds coreutils and other tools on PATH", async () => {
  const r = await bashTool.execute(
    { command: "which ls grep sed && ls >/dev/null && echo abc | grep -c b" },
    makeCtx(dir),
  )
  expect(textOf(r)).toEndWith("1\n\nExit code: 0")
})

test("the shell description says commands already start in the working directory", () => {
  expect(bashTool.description).toContain("Commands already start in the working directory")
  expect(bashTool.description).not.toContain("Prefer absolute paths")
  expect(bashTool.description).toContain("SIGPIPE (141)")
  expect(bashTool.description).toContain("treated as successful")
  expect(bashTool.description).not.toContain("exit 141 (SIGPIPE)")
})

test.if(hasBash)("a failed command before a pipeline keeps the bash error status", async () => {
  const r = await bashTool.execute({ command: "false | tail -n 1" }, makeCtx(dir))
  expect(r.isError).toBe(true)
  expect(textOf(r)).toEndWith("Exit code: 1")
})

test.if(hasBash)("SIGPIPE-only pipelines succeed but real pipeline failures do not", async () => {
  const sigpipe = await bashTool.execute({ command: "yes | head -n 1" }, makeCtx(dir))
  expect(sigpipe.isError).toBe(false)
  expect(textOf(sigpipe)).toEndWith("Exit code: 0")

  const gitLog = await bashTool.execute({ command: "git log --oneline | head -n 1" }, makeCtx(process.cwd()))
  expect(gitLog.isError).toBe(false)

  for (const command of ["false | cat", "cat missing | wc -l", "true | false"]) {
    const failed = await bashTool.execute({ command }, makeCtx(dir))
    expect(failed.isError).toBe(true)
    expect(textOf(failed)).toEndWith("Exit code: 1")
  }
})

test.if(hasBash)("non-zero exit is reported as an error", async () => {
  const r = await bashTool.execute({ command: "echo failing; exit 3" }, makeCtx(dir))
  expect(r.isError).toBe(true)
  expect(textOf(r)).toBe("failing\n\nExit code: 3")
  expect(r.details).toMatchObject({ exitCode: 3, outputLines: 1, durationMs: expect.any(Number) })
})

test.if(hasBash)("times out and kills the command", async () => {
  const start = Date.now()
  const r = await bashTool.execute({ command: "echo before; sleep 30", timeout: 1000 }, makeCtx(dir))
  expect(Date.now() - start).toBeLessThan(25_000)
  expect(r.isError).toBe(true)
  expect(textOf(r)).toContain("before")
  expect(textOf(r)).toContain("timed out after 1000 ms")
})

test.if(hasBash)(
  "a command that exits while a pipe holder survives is not a timeout, and output stops at return",
  async () => {
    const shell = await resolveShell()
    let real: ProcessTree | undefined
    let calls = 0
    try {
      const { argv, ...spawn } = shell.command(
        "(sleep 0.3; while true; do echo tick; sleep 0.1; done) & echo done",
        dir,
      )
      const run = await runCommand(argv, {
        ...spawn,
        timeoutMs: 1000,
        signal: new AbortController().signal,
        onChunk: () => void calls++,
        // Contain the tree but leave it running, as if a pipe holder had escaped.
        trackTree(proc) {
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
      real?.dispose()
    }
  },
  30_000,
)

test("a missing working directory is reported clearly", async () => {
  const r = await bashTool.execute({ command: "echo x" }, makeCtx(join(dir, "does-not-exist")))
  expect(r.isError).toBe(true)
  expect(textOf(r)).toStartWith("Working directory does not exist:")
})

test.if(hasBash && !isWindows)("a command killed by a signal says so", async () => {
  expect(textOf(await bashTool.execute({ command: "kill -9 $$" }, makeCtx(dir)))).toContain(
    "killed by signal",
  )
})

test("errors when already aborted or when command is missing", async () => {
  const ac = new AbortController()
  ac.abort()
  expect((await bashTool.execute({ command: "echo x" }, makeCtx(dir, ac.signal))).isError).toBe(true)
  expect((await bashTool.execute({ command: "" }, makeCtx(dir))).isError).toBe(true)
})

test("a command containing NUL is rejected clearly", async () => {
  const r = await bashTool.execute({ command: "echo a\0b" }, makeCtx(dir))
  expect(r.isError).toBe(true)
  expect(textOf(r)).toBe("command must not contain NUL characters")
})

test.if(hasBash)("large output is saved whole as an artifact and previewed", async () => {
  const r = await bashTool.execute({ command: "seq 1 20000" }, makeCtx(dir))
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
})

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
        `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${marker}%'" | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`,
      ]
    : ["ps", "-eo", "pid=,args="]
  const out = await new Response(Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" }).stdout).text()
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2]! }))
    .filter((p) => p.cmd.includes(marker))
}

/** The marked processes left once they are all gone or `ms` passed: killing and listing take time. */
async function survivors(marker: string, ms = 10_000): Promise<{ pid: number; cmd: string }[]> {
  const deadline = Date.now() + ms
  let left = await marked(marker)
  while (left.length && Date.now() < deadline) {
    await Bun.sleep(200)
    left = await marked(marker)
  }
  return left
}

function killMarked(procs: { pid: number }[]) {
  for (const p of procs) {
    try {
      process.kill(p.pid, "SIGKILL")
    } catch {}
  }
}

test.if(hasBash)(
  "abort kills background grandchildren with no survivors",
  async () => {
    const marker = newMarker(97)
    // The sleep processes themselves: the shells running the command have `sleep <marker>` in
    // their command lines too, and the one that checks the pipeline status stays alive.
    const isSleep = new RegExp(`(^|[\\\\/"])sleep(\\.exe)?"?\\s+${marker.replace(".", "\\.")}$`)
    const sleeps = async () => (await marked(marker)).filter((p) => isSleep.test(p.cmd.trim()))
    const ac = new AbortController()
    const run = bashTool.execute(
      { command: `(sleep ${marker} &); sleep ${marker} & echo started; sleep ${marker}` },
      makeCtx(dir, ac.signal),
    )
    try {
      const deadline = Date.now() + 15_000
      while ((await sleeps()).length < 3 && Date.now() < deadline) await Bun.sleep(200)
      expect((await sleeps()).length).toBe(3)

      ac.abort()
      const r = await run
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain("aborted")

      // No sleep, and no shell that ran one, is left.
      expect(await survivors(marker)).toEqual([])
    } finally {
      ac.abort()
      await run.catch(() => {})
      killMarked(await marked(marker))
    }
  },
  60_000,
)

test.if(hasBash)(
  "the first call in a fresh process times out with no surviving grandchildren",
  async () => {
    const marker = newMarker(96)
    const fixture = join(import.meta.dir, "fixtures", "first-bash-call.ts")
    const child = Bun.spawn([process.execPath, fixture, marker, dir], { stdout: "pipe", stderr: "pipe" })
    try {
      const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
      expect(code).toBe(0)
      const r = JSON.parse(out.trim().split("\n").at(-1)!)
      expect(r.text).toContain("timed out after 2000 ms")
      expect(await survivors(marker)).toEqual([])
    } finally {
      child.kill()
      killMarked(await marked(marker))
    }
  },
  60_000,
)
