import { expect, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  SPAWN_TEST_TIMEOUT_MS,
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

test(
  "legacy lease setup survives a child startup beyond Bun's default hook timeout",
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-slow-spawn-"))
    const delay = path.join(dir, "delay.ts")
    const preload = path.join(dir, "preload.ts")
    fs.writeFileSync(delay, "await Bun.sleep(5500)\n")
    fs.writeFileSync(
      preload,
      `const spawn = Bun.spawn;
Bun.spawn = (cmd, options) => {
  if (Array.isArray(cmd) && cmd.some(value => String(value).endsWith("file-lock-worker.ts")))
    return spawn([cmd[0], "--preload", ${JSON.stringify(delay)}, ...cmd.slice(1)], options);
  return spawn(cmd, options);
};\n`,
    )
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--preload",
        preload,
        "--test-name-pattern",
        "resume recovers a stale legacy dead pid lease",
        path.join(import.meta.dir, "../packages/core/test/session-legacy-lease.test.ts"),
      ],
      {
        windowsHide: true,
        cwd: path.join(import.meta.dir, ".."),
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
        ),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    try {
      const code = await waitForSpawnExit(child, "delayed legacy lease regression")
      const output = `${await waitForSpawnWork("regression stdout", stdout)}\n${await waitForSpawnWork("regression stderr", stderr)}`
      expect(output).not.toContain("Unhandled error between tests")
      expect(output).not.toContain("hook timed out")
      expect(output).toContain("1 pass")
      expect(code).toBe(0)
    } finally {
      await stopSpawn(child, "delayed legacy lease regression cleanup")
      fs.rmSync(dir, { recursive: true, force: true })
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
