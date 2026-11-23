import { expect, spyOn, test } from "bun:test"
import {
  SPAWN_TEST_TIMEOUT_MS,
  SPAWN_WAIT_TIMEOUT_MS,
  stopSpawn,
  waitForSpawnCondition,
  waitForSpawnExit,
  waitForSpawnWork,
} from "./spawn-test.ts"

test("spawn condition waits identify the missing event and bound", async () => {
  await expect(waitForSpawnCondition("child readiness", () => false, 0)).rejects.toThrow(
    "child readiness timed out after 0ms",
  )
})

test("spawn work waits bound diagnostic drains even after a child exits", async () => {
  await expect(waitForSpawnWork("child stderr drain", new Promise(() => {}), 0)).rejects.toThrow(
    "child stderr drain timed out after 0ms",
  )
})

test("spawn exit waits identify the child and phase", async () => {
  const child = { pid: 123, exitCode: null, exited: new Promise<number>(() => {}) }
  await expect(waitForSpawnExit(child, "fixture teardown", 0)).rejects.toThrow(
    "fixture teardown exit timed out after 0ms (pid 123)",
  )
})

test("stopping an owned child waits for its exit", async () => {
  let killed = false
  let exited = false
  const child = {
    pid: 123,
    exitCode: null,
    exited: Promise.resolve(143).then((code) => {
      exited = true
      return code
    }),
    kill() {
      killed = true
    },
  }
  await stopSpawn(child)
  expect(killed).toBe(true)
  expect(exited).toBe(true)
})

test("stopping a stubborn child escalates to SIGKILL and awaits its exit", async () => {
  const signals: Parameters<Bun.Subprocess["kill"]>[0][] = []
  let exitCode: number | null = null
  let forced = false
  let resolveExit!: (code: number) => void
  const child = {
    pid: 123,
    get exitCode() {
      return exitCode
    },
    exited: new Promise<number>((resolve) => {
      resolveExit = resolve
    }),
    kill(signal?: Parameters<Bun.Subprocess["kill"]>[0]) {
      signals.push(signal ?? "SIGTERM")
      if (signal === "SIGKILL" && !forced) {
        forced = true
        timeout(() => {
          exitCode = 137
          resolveExit(exitCode)
        }, 10)
      }
    },
  }
  const timeout = globalThis.setTimeout
  const clock = spyOn(globalThis, "setTimeout").mockImplementation(
    new Proxy(timeout, {
      apply(target, receiver, args) {
        // Keep a missing escalation regression fast, including the old 30s exit wait.
        if (args[1] === SPAWN_WAIT_TIMEOUT_MS && !forced) args[1] = 0
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  try {
    await stopSpawn(child, "stubborn fixture", 0)
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(child.exitCode).toBe(137)
    expect(await child.exited).toBe(137)
  } finally {
    clock.mockRestore()
    child.kill("SIGKILL")
    await child.exited
  }
})

test.skipIf(process.platform === "win32")(
  "stopping a real child that ignores SIGTERM force-kills and reaps it",
  async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
    )
    let output = ""
    const reading = (async () => {
      for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk)
    })()
    void reading.catch(() => {})
    const stderr = new Response(child.stderr).text()
    try {
      await waitForSpawnCondition("stubborn child readiness", () => output.includes("ready"))
      await stopSpawn(child, "SIGTERM-resistant child", 10)
      expect(await child.exited).toBe(137)
      expect(child.signalCode).toBe("SIGKILL")
      await waitForSpawnWork("stubborn child stdout", reading)
      expect(await waitForSpawnWork("stubborn child stderr", stderr)).toBe("")
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await waitForSpawnExit(child, "stubborn child fallback cleanup")
      await waitForSpawnWork("stubborn child reader cleanup", reading)
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
