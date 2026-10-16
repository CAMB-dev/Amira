import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SPAWN_TEST_TIMEOUT_MS,
  waitForSpawnCondition,
  waitForSpawnExit,
  waitForSpawnWork,
} from "../../../scripts/spawn-test.ts"
import { resetCommandWorker, StandbyGoneError } from "../src/index.ts"

import { ownSpawn, prepareCommand, prepareCommandInline, stopCommands } from "./spawn-fixture.ts"

const bun = process.execPath
const cwd = process.cwd()
const dir = mkdtempSync(join(tmpdir(), "amira-standby-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }), SPAWN_TEST_TIMEOUT_MS)

/** A gated program: prints `early`, optionally records its pid, then waits for the gate line. */
function gated(after = "", pidFile?: string): string[] {
  const script = [
    "console.log('early')",
    pidFile ? `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))` : "",
    "let line",
    "for await (const l of console) { line = l; break }",
    "if (line === undefined) process.exit(125)",
    "console.log('got:' + line)",
    after,
  ].join("\n")
  return [bun, "-e", script]
}

const release = (gateLine: string, timeoutMs = 30_000) => ({
  gateLine,
  timeoutMs,
  signal: new AbortController().signal,
})

const until = (check: () => boolean, ms?: number) => waitForSpawnCondition("standby condition", check, ms)

function isRunning(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      // A lost worker can leave an exited child awaiting Bun's native reaper.
      // kill(pid, 0) still succeeds for zombies, but they are no longer running.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return false
    } catch {}
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const pids = new Set<number>()
afterEach(async () => {
  try {
    await stopCommands()
  } finally {
    // A lost worker cannot dispose its already-released standby; keep its PID owned.
    for (const pid of pids) {
      if (!isRunning(pid)) continue
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
    await waitForSpawnCondition("standby processes cleanup", () => [...pids].every((pid) => !isRunning(pid)))
    pids.clear()
  }
}, SPAWN_TEST_TIMEOUT_MS)

async function pidFrom(file: string): Promise<number> {
  let pid = 0
  await until(() => {
    try {
      pid = Number(readFileSync(file, "utf8"))
    } catch {}
    return pid > 0
  })
  pids.add(pid)
  return pid
}

test(
  "a prepared command runs when released, keeping output from before the release",
  async () => {
    const pidFile = join(dir, "prepared.pid")
    const standby = prepareCommand(gated("", pidFile), { cwd, gated: true })
    await pidFrom(pidFile)
    expect(standby.alive).toBe(true)
    const chunks: string[] = []
    const run = await standby.run({ ...release("hello"), onChunk: (c) => void chunks.push(c) })
    expect(run.exitCode).toBe(0)
    expect(run.output.replaceAll("\r", "")).toBe("early\ngot:hello\n")
    expect(chunks.join("")).toBe(run.output)
    expect(standby.alive).toBe(false)
    await expect(standby.run(release("again"))).rejects.toBeInstanceOf(StandbyGoneError)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "the timeout counts from the release, not from the spawn",
  async () => {
    const pidFile = join(dir, "timeout.pid")
    const standby = prepareCommand(gated("await Bun.sleep(200)", pidFile), { cwd, gated: true })
    await pidFrom(pidFile)
    await Bun.sleep(1500)
    const run = await standby.run(release("x", 1200))
    expect(run.timedOut).toBe(false)
    expect(run.exitCode).toBe(0)

    const slowPid = join(dir, "slow.pid")
    const slow = prepareCommand(gated("await Bun.sleep(60_000)", slowPid), { cwd, gated: true })
    await pidFrom(slowPid)
    const started = performance.now()
    const timedOut = await slow.run(release("x", 1000))
    expect(timedOut.timedOut).toBe(true)
    expect(performance.now() - started).toBeLessThan(30_000)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a standby that exited while idle is reported gone",
  async () => {
    const standby = prepareCommand([bun, "-e", "process.exit(0)"], { cwd, gated: true })
    await until(() => !standby.alive)
    await expect(standby.run(release("x"))).rejects.toBeInstanceOf(StandbyGoneError)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a command that cannot start gives a standby that is gone",
  async () => {
    const standby = prepareCommand([join(dir, "does-not-exist.exe")], { cwd, gated: true })
    await until(() => !standby.alive)
    await expect(standby.run(release("x"))).rejects.toBeInstanceOf(StandbyGoneError)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "an exit the main thread has not heard of yet still fails as gone",
  async () => {
    const standby = prepareCommandInline([bun, "-e", "process.exit(0)"], { cwd, gated: true })
    await until(() => !standby.alive)
    await expect(standby.run(release("x"))).rejects.toBeInstanceOf(StandbyGoneError)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "dispose kills the waiting process",
  async () => {
    const pidFile = join(dir, "dispose.pid")
    const standby = prepareCommand(gated("", pidFile), { cwd, gated: true })
    const pid = await pidFrom(pidFile)
    expect(isRunning(pid)).toBe(true)
    standby.dispose()
    expect(standby.alive).toBe(false)
    await until(() => !isRunning(pid))
    await expect(standby.run(release("x"))).rejects.toBeInstanceOf(StandbyGoneError)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "abort during a released standby kills it",
  async () => {
    const standby = prepareCommand(gated("await Bun.sleep(60_000)"), { cwd, gated: true })
    const abort = new AbortController()
    let output = ""
    const p = standby.run({
      gateLine: "x",
      timeoutMs: 60_000,
      signal: abort.signal,
      onChunk: (chunk) => {
        output += chunk
        if (output.includes("got:x")) abort.abort()
      },
    })
    expect((await p).aborted).toBe(true)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "losing the worker after a release is a failure, not a gone standby that may be rerun",
  async () => {
    // Its tree is no longer contained once the worker is gone, so it must end on its own.
    const releasedPid = join(dir, "lost-released.pid")
    const idlePid = join(dir, "lost-idle.pid")
    const standby = prepareCommand(gated("await Bun.sleep(3000)", releasedPid), { cwd, gated: true })
    const idle = prepareCommand(gated("", idlePid), { cwd, gated: true })
    await Promise.all([pidFrom(releasedPid), pidFrom(idlePid)])
    let output = ""
    const run = standby.run({
      ...release("x"),
      onChunk: (chunk) => {
        output += chunk
      },
    })
    await until(() => output.includes("got:x"))
    resetCommandWorker()
    const err = await run.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(StandbyGoneError)
    expect(idle.alive).toBe(false)
    await expect(idle.run(release("x"))).rejects.toBeInstanceOf(StandbyGoneError)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "an idle standby does not keep the process alive, and dies with it",
  async () => {
    const pidFile = join(dir, "idle.pid")
    const index = new URL("../src/index.ts", import.meta.url).href
    const script = [
      `import(${JSON.stringify(index)}).then(({ prepareCommand }) => {`,
      `  prepareCommand(${JSON.stringify(gated("", pidFile))}, { cwd: process.cwd(), gated: true })`,
      // Wait until the standby is up; after that, only the standby could keep this process alive.
      "  const poll = setInterval(() => {",
      `    if (!require("fs").existsSync(${JSON.stringify(pidFile)})) return`,
      "    clearInterval(poll)",
      "    console.log('prepared')",
      "  }, 20)",
      "})",
    ].join("\n")
    const child = ownSpawn(Bun.spawn([bun, "-e", script], { stdout: "pipe", stderr: "pipe" }))
    const [out, code] = await waitForSpawnWork(
      "idle standby host output",
      Promise.all([
        new Response(child.stdout).text(),
        waitForSpawnExit(child, "idle standby host"),
        new Response(child.stderr).text(),
      ]),
    )
    expect(code).toBe(0)
    expect(out.trim()).toBe("prepared")
    // Its stdin closed with the child, so it exits without being released.
    await until(() => !isRunning(Number(readFileSync(pidFile, "utf8"))))
  },
  SPAWN_TEST_TIMEOUT_MS,
)
