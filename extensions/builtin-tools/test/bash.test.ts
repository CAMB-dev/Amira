import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { bashTool, runCommand } from "../src/bash.ts"
import { type ProcessTree, trackProcessTree } from "../src/process-tree.ts"
import { resolveShell } from "../src/shell.ts"
import { makeCtx, tempDirs, textOf } from "./util.ts"

const tmp = tempDirs()
let dir: string
beforeAll(async () => {
  dir = await tmp.make()
})
afterAll(() => tmp.cleanup())

const isWindows = process.platform === "win32"
const hasBash = (await resolveShell()).kind === "bash"

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

test.if(hasBash)("non-zero exit is reported as an error", async () => {
  const r = await bashTool.execute({ command: "echo failing; exit 3" }, makeCtx(dir))
  expect(r.isError).toBe(true)
  expect(textOf(r)).toBe("failing\n\nExit code: 3")
  expect(r.details).toMatchObject({ exitCode: 3 })
})

test.if(hasBash)("times out and kills the command", async () => {
  const start = Date.now()
  const r = await bashTool.execute({ command: "echo before; sleep 30", timeout: 1000 }, makeCtx(dir))
  expect(Date.now() - start).toBeLessThan(10_000)
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
      const run = await runCommand(
        shell.args("(sleep 0.3; while true; do echo tick; sleep 0.1; done) & echo done"),
        {
          cwd: dir,
          env: shell.env,
          gated: shell.gated,
          timeoutMs: 1000,
          signal: new AbortController().signal,
          onOutput: () => void calls++,
          // Contain the tree but leave it running, as if a pipe holder had escaped.
          trackTree(proc) {
            real = trackProcessTree(proc)
            return { contained: true, kill() {}, dispose() {} }
          },
        },
      )
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

test.if(hasBash)("large output is truncated with the full text saved to a file", async () => {
  const r = await bashTool.execute({ command: "seq 1 20000" }, makeCtx(dir))
  const text = textOf(r)
  expect(text).toStartWith("1\n2\n")
  expect(text).toContain("20000\n\nExit code: 0")
  const path = (r.details as { fullOutputPath?: string }).fullOutputPath
  expect(path).toBeDefined()
  expect(text).toContain(path!)
})

/** Lists running `sleep` processes as pid + command line. */
async function listSleeps(): Promise<{ pid: number; cmd: string }[]> {
  const argv = isWindows
    ? [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='sleep.exe'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`,
      ]
    : ["ps", "-eo", "pid=,args="]
  const out = await new Response(Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" }).stdout).text()
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2]! }))
    .filter((p) => isWindows || /\bsleep\b/.test(p.cmd))
}

test.if(hasBash)(
  "abort kills background grandchildren with no survivors",
  async () => {
    // A unique duration marks the sleeps this test creates, so cleanup never touches anyone else's.
    const marker = `97.${Date.now() % 100000}`
    const ours = async () => (await listSleeps()).filter((p) => p.cmd.includes(marker))
    const before = await listSleeps()
    const ac = new AbortController()
    const run = bashTool.execute(
      { command: `(sleep ${marker} &); sleep ${marker} & echo started; sleep ${marker}` },
      makeCtx(dir, ac.signal),
    )
    try {
      const deadline = Date.now() + 15_000
      while ((await ours()).length < 3 && Date.now() < deadline) await Bun.sleep(200)
      expect((await ours()).length).toBe(3)

      ac.abort()
      const r = await run
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain("aborted")

      await Bun.sleep(500)
      const after = await listSleeps()
      expect(await ours()).toEqual([])
      if (isWindows) expect(after.length).toBeLessThanOrEqual(before.length)
    } finally {
      ac.abort()
      await run.catch(() => {})
      for (const p of await ours()) {
        try {
          process.kill(p.pid, "SIGKILL")
        } catch {}
      }
    }
  },
  60_000,
)

test.if(hasBash)(
  "the first call in a fresh process times out with no surviving grandchildren",
  async () => {
    const marker = `96.${Date.now() % 100000}`
    const ours = async () => (await listSleeps()).filter((p) => p.cmd.includes(marker))
    const fixture = join(import.meta.dir, "fixtures", "first-bash-call.ts")
    const child = Bun.spawn([process.execPath, fixture, marker, dir], { stdout: "pipe", stderr: "pipe" })
    try {
      const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
      expect(code).toBe(0)
      const r = JSON.parse(out.trim().split("\n").at(-1)!)
      expect(r.text).toContain("timed out after 2000 ms")
      await Bun.sleep(500)
      expect(await ours()).toEqual([])
    } finally {
      child.kill()
      for (const p of await ours()) {
        try {
          process.kill(p.pid, "SIGKILL")
        } catch {}
      }
    }
  },
  60_000,
)
