import { afterEach, expect, spyOn, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { commandWorkerStatus, resetCommandWorker } from "@amira/proc"
import {
  SPAWN_TEST_TIMEOUT_MS,
  stopSpawn,
  waitForSpawnExit,
  waitForSpawnWork,
} from "../../../scripts/spawn-test.ts"
import { selfCheck } from "../src/self-check.ts"
import { channel, target, version, versionLine } from "../src/version.ts"

afterEach(() => resetCommandWorker(), SPAWN_TEST_TIMEOUT_MS)

async function checkedSelfCheck() {
  const children: Bun.Subprocess[] = []
  const spawn = Bun.spawn
  const observer = spyOn(Bun, "spawn").mockImplementation((...args: unknown[]) => {
    const child = Reflect.apply(spawn, Bun, args)
    children.push(child)
    return child
  })
  try {
    return await waitForSpawnWork("self-check", selfCheck())
  } finally {
    observer.mockRestore()
    await Promise.all(children.map((child) => stopSpawn(child, "self-check cleanup")))
  }
}

test(
  "self-check verifies the Worker handshake, theme and platform containment",
  async () => {
    resetCommandWorker()
    expect(commandWorkerStatus()).toBe("idle")
    const report = await checkedSelfCheck()
    expect(report).toEqual({
      ok: true,
      version,
      channel,
      target,
      worker: "worker",
      assets: true,
      jobObject: process.platform === "win32" ? true : null,
      errors: [],
    })
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "self-check fails rather than accepting inline fallback",
  async () => {
    resetCommandWorker({ url: new URL("./missing-worker.ts", import.meta.url).href })
    const report = await checkedSelfCheck()
    expect(report.ok).toBe(false)
    expect(report.worker).toBe("inline")
    expect(report.errors).toContain("Command Worker did not send ready: inline")
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "CLI diagnostics print metadata and JSON without needing configuration",
  async () => {
    const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url))
    for (const flag of ["--version", "--self-check"]) {
      const child = Bun.spawn([process.execPath, entry, flag], { stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, code] = await (async () => {
        try {
          return await waitForSpawnWork(
            "CLI output",
            Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
              waitForSpawnExit(child, "CLI"),
            ]),
          )
        } finally {
          await stopSpawn(child, "CLI cleanup")
        }
      })()
      expect(code).toBe(0)
      expect(stderr).toBe("")
      if (flag === "--version") expect(stdout.trim()).toBe(versionLine)
      else expect(JSON.parse(stdout).ok).toBe(true)
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
