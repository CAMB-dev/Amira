import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const launcher = await readFile(new URL("./npm/amira.js", import.meta.url), "utf8")
const node = Bun.which("node")
const runtimes = [
  { name: "Bun", executable: process.execPath },
  ...(node ? [{ name: "Node", executable: node }] : []),
]

const python = process.platform === "win32" ? null : Bun.which("python3")

for (const runtime of runtimes) {
  test.skipIf(process.platform !== "win32")(
    `${runtime.name} Windows child survives launcher console-event dispatch`,
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "amira-console-"))
      temporary.push(directory)
      const entry = path.join(directory, "launcher.cjs")
      const binary = path.join(directory, "child.cjs")
      const ready = path.join(directory, "ready")
      const bootstrap = path.join(directory, "bootstrap.cjs")
      await writeFile(entry, launcher)
      await writeFile(
        binary,
        `
process.on("SIGINT", () => console.log("child interrupt handler"))
require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready")
setTimeout(() => { console.log("child still running"); process.exit(37) }, 750)
`,
      )
      await writeFile(
        bootstrap,
        `
process.env.AMIRA_BINARY = ${JSON.stringify(runtime.executable)}
process.argv = [process.execPath, ${JSON.stringify(entry)}, ${JSON.stringify(binary)}]
require(${JSON.stringify(entry)})
const deadline = setTimeout(() => { throw new Error("Child did not become ready") }, 5000)
const poll = setInterval(() => {
  if (!require("node:fs").existsSync(${JSON.stringify(ready)})) return
  clearInterval(poll)
  clearTimeout(deadline)
  process.emit("SIGINT")
  process.emit("SIGBREAK")
}, 10)
`,
      )
      const child = Bun.spawn([runtime.executable, bootstrap], { stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(stderr).toBe("")
      expect(code).toBe(37)
      expect(stdout).toContain("child still running")
    },
    10000,
  )
  for (const signal of ["SIGINT", "SIGQUIT"]) {
    test.skipIf(!python)(
      `${runtime.name} foreground TTY delivers ${signal} once to the child`,
      async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "amira-tty-"))
        temporary.push(directory)
        const entry = path.join(directory, "launcher.cjs")
        const binary = path.join(directory, "child.cjs")
        await writeFile(entry, launcher)
        await writeFile(
          binary,
          `
let count = 0
process.on(${JSON.stringify(signal)}, () => {
  console.log("interrupt:" + ++count)
  if (count === 1) setTimeout(() => process.exit(count === 1 ? 42 : 43), 150)
})
setImmediate(() => console.log("ready"))
setInterval(() => {}, 1000)
`,
        )
        const child = Bun.spawn(
          [
            python!,
            fileURLToPath(new URL("./fixtures/launcher-tty.py", import.meta.url)),
            runtime.executable,
            entry,
            binary,
            signal,
          ],
          {
            env: { ...process.env, AMIRA_BINARY: runtime.executable },
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(stderr).toBe("")
        expect(code).toBe(0)
        expect(stdout).toContain("one console interrupt; child exit 42 preserved")
      },
      15000,
    )
  }
  test(`${runtime.name} POSIX launcher re-raises child signals after cleanup with a delayed fallback`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "amira-signal-exit-"))
    temporary.push(directory)
    const harness = path.join(directory, "signals.cjs")
    await writeFile(
      harness,
      `const { EventEmitter } = require("node:events")
const { runInNewContext } = require("node:vm")
const results = []
for (const signal of ["SIGINT", "SIGQUIT", "SIGTERM", "SIGHUP"]) {
  const child = new EventEmitter()
  const calls = []
  const timers = []
  const proc = Object.assign(new EventEmitter(), {
    platform: "linux", arch: "x64", env: { AMIRA_BINARY: "fake-binary" }, pid: 123,
    argv: ["node", "amira.js"], stdin: {}, stdout: {}, stderr: {},
    kill: (pid, received) => calls.push({ pid, signal: received, remaining: proc.eventNames() }),
    exit: code => calls.push({ code }),
  })
  runInNewContext(${JSON.stringify(launcher)}, {
    process: proc, console, setTimeout: callback => timers.push(callback),
    require: name => name === "node:child_process" ? { spawn: () => child } : require(name),
  })
  child.emit("exit", null, signal)
  const immediate = calls.slice()
  for (const callback of timers) callback()
  results.push({ signal, immediate, calls })
}
console.log(JSON.stringify(results))
`,
    )
    const child = Bun.spawn([runtime.executable, harness], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    const numbers: Record<string, number> = { SIGINT: 2, SIGQUIT: 3, SIGTERM: 15, SIGHUP: 1 }
    for (const result of JSON.parse(stdout)) {
      const reraised = { pid: 123, signal: result.signal, remaining: [] }
      expect(result.immediate).toEqual([reraised])
      expect(result.calls).toEqual([reraised, { code: 128 + numbers[result.signal]! }])
    }
  })
  for (const platform of ["win32", "linux"]) {
    for (const tty of ["none", "stdin", "stdout", "stderr"]) {
      test(`${runtime.name} launcher ${platform} tty=${tty} avoids duplicate console interrupts and waits for exit`, async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "amira-signals-"))
        temporary.push(directory)
        const harness = path.join(directory, "signals.cjs")
        // Exercise the actual launcher with console delivery simulated at process.on's seam.
        // child.kill on Windows is deliberately observable: it must never receive console interrupts.
        await writeFile(
          harness,
          `const { EventEmitter } = require("node:events")
const { runInNewContext } = require("node:vm")
const child = new EventEmitter()
const kills = []
const spawnInterrupts = {}
child.kill = signal => { kills.push(signal); return true }
const proc = Object.assign(new EventEmitter(), {
  platform: ${JSON.stringify(platform)}, arch: "x64", env: { AMIRA_BINARY: "fake-binary" },
  argv: ["node", "amira.js"], stdin: { isTTY: ${tty === "stdin"} },
  stdout: { isTTY: ${tty === "stdout"} }, stderr: { isTTY: ${tty === "stderr"} },
})
runInNewContext(${JSON.stringify(launcher)}, {
  process: proc, console, require: name => {
    if (name !== "node:child_process") throw new Error(name)
    return { spawn: () => {
      for (const signal of ${JSON.stringify(platform === "win32" ? ["SIGINT", "SIGBREAK"] : tty !== "none" ? ["SIGINT", "SIGQUIT"] : [])}) {
        spawnInterrupts[signal] = proc.emit(signal)
      }
      return child
    } }
  },
})
const received = {}
for (const signal of ["SIGINT", "SIGBREAK", "SIGQUIT", "SIGTERM", "SIGHUP"]) {
  const before = kills.length
  const handled = proc.emit(signal)
  received[signal] = { handled, forwarded: kills.slice(before), exitCode: proc.exitCode ?? null }
}
child.emit("exit", 37, null)
console.log(JSON.stringify({ received, spawnInterrupts, exitCode: proc.exitCode, remaining: proc.eventNames() }))
`,
        )
        const child = Bun.spawn([runtime.executable, harness], { stdout: "pipe", stderr: "pipe" })
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(stderr).toBe("")
        expect(code).toBe(0)
        const result = JSON.parse(stdout)
        const ignored =
          platform === "win32" ? ["SIGINT", "SIGBREAK"] : tty !== "none" ? ["SIGINT", "SIGQUIT"] : []
        const forwarded = [
          "SIGTERM",
          "SIGHUP",
          ...(platform !== "win32" && tty === "none" ? ["SIGINT", "SIGQUIT"] : []),
        ]
        for (const signal of ignored) {
          expect(result.spawnInterrupts[signal]).toBe(true)
          expect(result.received[signal]).toEqual({ handled: true, forwarded: [], exitCode: null })
        }
        for (const signal of forwarded) {
          expect(result.received[signal]).toEqual({ handled: true, forwarded: [signal], exitCode: null })
        }
        expect(result.exitCode).toBe(37)
        expect(result.remaining).toEqual([])
      })
    }
  }
}
