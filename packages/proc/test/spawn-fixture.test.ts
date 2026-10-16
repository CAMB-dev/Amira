import { afterAll, afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  SPAWN_TEST_TIMEOUT_MS,
  waitForSpawnCondition,
  waitForSpawnWork,
} from "../../../scripts/spawn-test.ts"
import { prepareCommand as prepareUnowned, resetCommandWorker, trackProcessTree } from "../src/index.ts"
import { prepareCommand, prepareCommandInline, stopCommands } from "./spawn-fixture.ts"

const dir = mkdtempSync(join(tmpdir(), "amira-proc-cleanup-"))
const cwd = process.cwd()
const argv = [process.execPath, "-e", "for await (const line of console) {}"]
afterEach(async () => {
  await stopCommands()
  resetCommandWorker()
}, SPAWN_TEST_TIMEOUT_MS)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Record the native exit, not a logical standby state or a PID liveness approximation. */
function instrumentedWorker(name: string) {
  const booted = join(dir, `${name}.booted`)
  const release = join(dir, `${name}.release`)
  const pid = join(dir, `${name}.pid`)
  const exited = join(dir, `${name}.exited`)
  const file = join(dir, `${name}.ts`)
  writeFileSync(
    file,
    [
      'import { existsSync, writeFileSync } from "node:fs"',
      "const queued = []",
      "self.onmessage = (event) => queued.push(event)",
      "const spawn = Bun.spawn",
      "Bun.spawn = function (...args) {",
      "  const child = spawn.apply(Bun, args)",
      `  writeFileSync(${JSON.stringify(pid)}, String(child.pid))`,
      `  child.exited.then(() => writeFileSync(${JSON.stringify(exited)}, String(child.pid)))`,
      "  return child",
      "}",
      `writeFileSync(${JSON.stringify(booted)}, "ready")`,
      `while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10)`,
      `await import(${JSON.stringify(new URL("../src/worker.ts", import.meta.url).href)})`,
      "for (const event of queued) self.onmessage(event)",
    ].join("\n"),
  )
  resetCommandWorker({ url: pathToFileURL(file).href })
  return { booted, release, pid, exited }
}

test(
  "stopCommands waits for native exit when disposed before worker bootstrap and PID registration",
  async () => {
    const files = instrumentedWorker("queued")
    prepareCommand(argv, { cwd, gated: true })
    await waitForSpawnCondition("worker bootstrap barrier", () => existsSync(files.booted))
    expect(existsSync(files.pid)).toBe(false)
    let releaseTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const stopping = stopCommands().then(() => existsSync(files.exited))
      // The old helper resolves in microtasks while prepare is still queued behind this barrier.
      releaseTimer = setTimeout(() => writeFileSync(files.release, "go"), 0)
      expect(await waitForSpawnWork("queued standby cleanup", stopping)).toBe(true)
      expect(Number(readFileSync(files.pid, "utf8"))).toBeGreaterThan(0)
    } finally {
      clearTimeout(releaseTimer)
      writeFileSync(files.release, "go")
      // Even the red regression must let the queued prepare/dispose reach and reap the child.
      await waitForSpawnCondition("queued standby native exit", () => existsSync(files.exited))
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "stopCommands waits for native exit of an inline standby",
  async () => {
    let nativeExit = false
    const standby = prepareCommandInline(argv, {
      cwd,
      gated: true,
      trackTree(child) {
        void child.exited.then(() => {
          nativeExit = true
        })
        return trackProcessTree(child)
      },
    })
    try {
      const disposing = standby.dispose()
      expect(standby.dispose()).toBe(disposing)
      await stopCommands()
      expect(nativeExit).toBe(true)
    } finally {
      await waitForSpawnCondition("inline standby native exit", () => nativeExit)
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "losing a worker during queued disposal rejects instead of claiming native exit",
  async () => {
    const files = instrumentedWorker("lost")
    const standby = prepareUnowned(argv, { cwd, gated: true })
    await waitForSpawnCondition("lost worker bootstrap barrier", () => existsSync(files.booted))
    const disposing = standby.dispose()
    expect(standby.dispose()).toBe(disposing)
    resetCommandWorker()
    await expect(disposing).rejects.toThrow("before confirming the standby process exited")
    expect(existsSync(files.pid)).toBe(false)
    expect(existsSync(files.exited)).toBe(false)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a worker load failure settles queued disposal without an unhandled ignored promise",
  async () => {
    resetCommandWorker({ url: pathToFileURL(join(dir, "missing-worker.ts")).href })
    const ignored = prepareUnowned(argv, { cwd, gated: true })
    void ignored.dispose()
    const standby = prepareUnowned(argv, { cwd, gated: true })
    await expect(standby.dispose()).rejects.toThrow("before confirming the standby process exited")
    expect(standby.alive).toBe(false)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "an empty disposal error is not treated as a native-exit acknowledgement",
  async () => {
    const file = join(dir, "empty-disposal-error.ts")
    // No child is launched: this worker exercises the disposal protocol's error arm.
    writeFileSync(
      file,
      `self.onmessage = ({ data }) => {
  if (data.type === "dispose") self.postMessage({ type: "disposed", id: data.id, error: "" })
}
self.postMessage({ type: "ready" })\n`,
    )
    resetCommandWorker({ url: pathToFileURL(file).href })
    const standby = prepareUnowned(argv, { cwd, gated: true })
    await expect(standby.dispose()).rejects.toMatchObject({ message: "" })
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "stopCommands joins and aborts a standby that was released",
  async () => {
    const files = instrumentedWorker("released")
    writeFileSync(files.release, "go")
    const standby = prepareCommand(
      [
        process.execPath,
        "-e",
        "for await (const line of console) { break }; console.log('running'); setInterval(() => {}, 60_000)",
      ],
      { cwd, gated: true },
    )
    let running = false
    const work = standby.run({
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      onChunk: () => {
        running = true
      },
    })
    await waitForSpawnCondition("standby release", () => running)
    await stopCommands()
    expect((await work).aborted).toBe(true)
    expect(existsSync(files.exited)).toBe(true)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "stopCommands handles a prepared command that cannot spawn",
  async () => {
    const standby = prepareCommand([join(dir, "missing-command.exe")], { cwd, gated: true })
    await stopCommands()
    expect(standby.alive).toBe(false)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "stopCommands waits for native exit of a healthy worker standby",
  async () => {
    const files = instrumentedWorker("healthy")
    writeFileSync(files.release, "go")
    const standby = prepareCommand(argv, { cwd, gated: true })
    await waitForSpawnCondition("worker standby PID registration", () => existsSync(files.pid))
    try {
      const disposing = standby.dispose()
      expect(standby.dispose()).toBe(disposing)
      await stopCommands()
      expect(existsSync(files.exited)).toBe(true)
    } finally {
      await waitForSpawnCondition("worker standby native exit", () => existsSync(files.exited))
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
