import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareCommand, prepareCommandInline, StandbyGoneError } from "../src/index.ts"

// Spawns can take seconds on Windows machines with antivirus scanning.
setDefaultTimeout(60_000)

const bun = process.execPath
const cwd = process.cwd()
const dir = mkdtempSync(join(tmpdir(), "amira-standby-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A gated program: prints `early`, optionally records its pid, then waits for the gate line. */
function gated(after = "", pidFile?: string): string[] {
  const script = [
    pidFile ? `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))` : "",
    "console.log('early')",
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

async function until(check: () => boolean, ms = 30_000) {
  const end = performance.now() + ms
  while (!check()) {
    if (performance.now() > end) throw new Error("timed out waiting")
    await Bun.sleep(20)
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function pidFrom(file: string): Promise<number> {
  let pid = 0
  await until(() => {
    try {
      pid = Number(readFileSync(file, "utf8"))
    } catch {}
    return pid > 0
  })
  return pid
}

test("a prepared command runs when released, keeping output from before the release", async () => {
  const standby = prepareCommand(gated(), { cwd, gated: true })
  await Bun.sleep(300)
  expect(standby.alive).toBe(true)
  const chunks: string[] = []
  const run = await standby.run({ ...release("hello"), onChunk: (c) => void chunks.push(c) })
  expect(run.exitCode).toBe(0)
  expect(run.output.replaceAll("\r", "")).toBe("early\ngot:hello\n")
  expect(chunks.join("")).toBe(run.output)
  expect(standby.alive).toBe(false)
  await expect(standby.run(release("again"))).rejects.toBeInstanceOf(StandbyGoneError)
})

test("the timeout counts from the release, not from the spawn", async () => {
  const pidFile = join(dir, "timeout.pid")
  const standby = prepareCommand(gated("await Bun.sleep(200)", pidFile), { cwd, gated: true })
  await pidFrom(pidFile)
  await Bun.sleep(1500)
  const run = await standby.run(release("x", 1200))
  expect(run.timedOut).toBe(false)
  expect(run.exitCode).toBe(0)

  const slow = prepareCommand(gated("await Bun.sleep(60_000)"), { cwd, gated: true })
  const started = performance.now()
  const timedOut = await slow.run(release("x", 1000))
  expect(timedOut.timedOut).toBe(true)
  expect(performance.now() - started).toBeLessThan(30_000)
})

test("a standby that exited while idle is reported gone", async () => {
  const standby = prepareCommand([bun, "-e", "process.exit(0)"], { cwd, gated: true })
  await until(() => !standby.alive)
  await expect(standby.run(release("x"))).rejects.toBeInstanceOf(StandbyGoneError)
})

test("a command that cannot start gives a standby that is gone", async () => {
  const standby = prepareCommand([join(dir, "does-not-exist.exe")], { cwd, gated: true })
  await until(() => !standby.alive)
  await expect(standby.run(release("x"))).rejects.toBeInstanceOf(StandbyGoneError)
})

test("an exit the main thread has not heard of yet still fails as gone", async () => {
  const standby = prepareCommandInline([bun, "-e", "process.exit(0)"], { cwd, gated: true })
  await Bun.sleep(1000)
  await expect(standby.run(release("x"))).rejects.toBeInstanceOf(StandbyGoneError)
})

test("dispose kills the waiting process", async () => {
  const pidFile = join(dir, "dispose.pid")
  const standby = prepareCommand(gated("", pidFile), { cwd, gated: true })
  const pid = await pidFrom(pidFile)
  expect(isRunning(pid)).toBe(true)
  standby.dispose()
  expect(standby.alive).toBe(false)
  await until(() => !isRunning(pid))
  await expect(standby.run(release("x"))).rejects.toBeInstanceOf(StandbyGoneError)
})

test("abort during a released standby kills it", async () => {
  const standby = prepareCommand(gated("await Bun.sleep(60_000)"), { cwd, gated: true })
  const abort = new AbortController()
  const p = standby.run({ gateLine: "x", timeoutMs: 60_000, signal: abort.signal })
  setTimeout(() => abort.abort(), 500)
  expect((await p).aborted).toBe(true)
})

test("an idle standby does not keep the process alive, and dies with it", async () => {
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
  const child = Bun.spawn([bun, "-e", script], { stdout: "pipe", stderr: "pipe" })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  expect(code).toBe(0)
  expect(out.trim()).toBe("prepared")
  // Its stdin closed with the child, so it exits without being released.
  await until(() => !isRunning(Number(readFileSync(pidFile, "utf8"))))
})
