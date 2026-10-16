import { afterEach, expect, spyOn, test } from "bun:test"
import {
  SPAWN_TEST_TIMEOUT_MS,
  waitForSpawnCondition,
  waitForSpawnExit,
  waitForSpawnWork,
} from "../../../scripts/spawn-test.ts"
import { commandWorkerStatus, resetCommandWorker } from "../src/index.ts"

import { ownSpawn, runCommand, stopCommands } from "./spawn-fixture.ts"

afterEach(stopCommands, SPAWN_TEST_TIMEOUT_MS)

const bun = process.execPath
const opts = (signal = new AbortController().signal) => ({ cwd: process.cwd(), timeoutMs: 30_000, signal })

test(
  "runs a command in the worker and streams its output in chunks",
  async () => {
    const chunks: string[] = []
    const run = await runCommand([bun, "-e", "console.log('out'); console.error('err'); process.exit(3)"], {
      ...opts(),
      onChunk: (c) => void chunks.push(c),
    })
    expect(commandWorkerStatus()).toBe("worker")
    expect(run.exitCode).toBe(3)
    expect(run.output).toContain("out")
    expect(run.output).toContain("err")
    expect(run.truncated).toBe(false)
    expect(chunks.join("")).toBe(run.output)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.each([
  [0, null, 0],
  [7, null, 7],
  [137, null, 137],
  [137, "SIGKILL", null],
] as const)(
  "collects an immediate command that exited during spawn (code %s, signal %s)",
  async (exitCode, signalCode, expectedCode) => {
    // A real completed child at the spawn boundary reproduces the fast POSIX git race without
    // relying on scheduler timing. This is not a standby waiting to execute a command.
    const proc = ownSpawn(
      Bun.spawn([bun, "-e", `console.log('fast'); process.exit(${exitCode})`], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      }),
    )
    await waitForSpawnExit(proc, "completed command fixture")
    // Exercise Bun's POSIX signal metadata on Windows too, without inferring it from 137.
    Object.defineProperty(proc, "signalCode", { value: signalCode })
    const spawn = spyOn(Bun, "spawn").mockReturnValue(proc)
    try {
      const run = await runCommand([bun, "-e", "unused"], {
        ...opts(),
        trackTree: () => ({ contained: true, kill() {}, terminate: () => false, dispose() {} }),
      })
      expect(run).toMatchObject({
        exitCode: expectedCode,
        signalCode,
        timedOut: false,
        aborted: false,
        settled: true,
      })
      expect(run.output.trim()).toBe("fast")
    } finally {
      spawn.mockRestore()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "stdoutOnly drops stderr",
  async () => {
    const run = await runCommand([bun, "-e", "console.log('out'); console.error('err')"], {
      ...opts(),
      stdoutOnly: true,
    })
    expect(run.output.trim()).toBe("out")
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "abort reaches the worker and kills the command",
  async () => {
    const abort = new AbortController()
    let ready = false
    const p = runCommand([bun, "-e", "console.log('ready'); setTimeout(() => {}, 60_000)"], {
      ...opts(abort.signal),
      onChunk: () => {
        ready = true
      },
    })
    await waitForSpawnCondition("abort fixture startup", () => ready)
    const started = performance.now()
    const timer = setTimeout(() => abort.abort(), 500)
    const run = await p.finally(() => clearTimeout(timer))
    expect(run.aborted).toBe(true)
    expect(performance.now() - started).toBeLessThan(30_000)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "the main thread keeps running while a command runs",
  async () => {
    let ticks = 0
    const id = setInterval(() => ticks++, 10)
    try {
      await runCommand([bun, "-e", "Bun.sleepSync(300)"], opts())
    } finally {
      clearInterval(id)
    }
    expect(ticks).toBeGreaterThan(10)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a worker that fails to load falls back to running on this thread",
  async () => {
    resetCommandWorker({ url: new URL("./does-not-exist.ts", import.meta.url).href })
    expect(commandWorkerStatus()).toBe("idle")
    try {
      const first = await runCommand([bun, "-e", "console.log('one')"], opts())
      const second = await runCommand([bun, "-e", "console.log('two')"], opts())
      expect(commandWorkerStatus()).toBe("inline")
      expect(first.output.trim()).toBe("one")
      expect(second.output.trim()).toBe("two")
    } finally {
      resetCommandWorker()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a process that only awaits a command stays alive until it finishes",
  async () => {
    const index = new URL("../src/index.ts", import.meta.url).href
    // Like the CLI: no top-level await (which alone keeps Bun running), so only the command can.
    const script = [
      `import(${JSON.stringify(index)}).then(async ({ runCommand }) => {`,
      `  const run = await runCommand([process.execPath, "-e", "await Bun.sleep(500); console.log('late')"], {`,
      "    cwd: process.cwd(), timeoutMs: 30_000, signal: new AbortController().signal })",
      "  console.log('result:' + run.output.trim())",
      "  console.log(JSON.stringify({ ...run, output: undefined }))",
      "})",
    ].join("\n")
    const child = ownSpawn(Bun.spawn([bun, "-e", script], { stdout: "pipe", stderr: "pipe" }))
    const [out, err, code] = await waitForSpawnWork(
      "command host output",
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        waitForSpawnExit(child, "command host"),
      ]),
    )
    // All of it on failure: whether Bun exited early (no result) or the command itself failed.
    const lines = out.trim().split(/\r?\n/)
    const ok = code === 0 && lines[0] === "result:late"
    expect({ code, result: lines[0], ...(ok ? {} : { err }) }).toEqual({ code: 0, result: "result:late" })
    expect(JSON.parse(lines[1]!)).toMatchObject({ exitCode: 0, timedOut: false, aborted: false })
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a failing chunk callback does not break the run",
  async () => {
    const run = await runCommand([bun, "-e", "console.log('x')"], {
      ...opts(),
      onChunk: () => {
        throw new Error("boom")
      },
    })
    expect(run.exitCode).toBe(0)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "without maxOutputChars the output is not capped",
  async () => {
    const run = await runCommand([bun, "-e", "process.stdout.write('x'.repeat(1_000_000) + 'END')"], opts())
    expect(run.output.length).toBe(1_000_003)
    expect(run.truncated).toBe(false)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "maxOutputChars overrides the cap; chunks still carry all output",
  async () => {
    let streamed = 0
    const run = await runCommand([bun, "-e", "process.stdout.write('x'.repeat(200_000) + 'END')"], {
      ...opts(),
      maxOutputChars: 10,
      onChunk: (c) => {
        streamed += c.length
      },
    })
    expect(run.output).toBe("xxxxxxxEND")
    expect(run.truncated).toBe(true)
    expect(streamed).toBe(200_003)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "the output cap does not split a UTF-16 surrogate pair",
  async () => {
    const run = await runCommand([bun, "-e", "process.stdout.write('a😀tail')"], {
      ...opts(),
      maxOutputChars: 5,
    })
    expect(run.output).toBe("tail")
    expect(run.truncated).toBe(true)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "maxOutputChars rejects invalid values",
  async () => {
    for (const maxOutputChars of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(runCommand([bun, "-e", ""], { ...opts(), maxOutputChars })).rejects.toThrow(
        "maxOutputChars must be a positive integer",
      )
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
