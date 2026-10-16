import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SPAWN_TEST_TIMEOUT_MS,
  waitForSpawnCondition,
  waitForSpawnExit,
} from "../../../scripts/spawn-test.ts"
import { trackProcessTree } from "../../proc/src/process-tree.ts"
import { boundSpawnSync } from "./spawn-fixture.ts"
import { type ShellGuardRequest, type ShellGuardResult, shellGuardWorker } from "./spawn-shell-guard.ts"

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

function killOwned(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new Error(`Invalid owned probe pid: ${pid}`)
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

test(
  "shell guard kills the ready editor and its child after an operation timeout",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "amira-shell-containment-"))
    const script = join(dir, "fake editor.ts")
    const readyFile = join(dir, "leaf.pid")
    const resultFile = join(dir, "result.json")
    writeFileSync(
      script,
      `import { spawn } from "node:child_process"
import { renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const role = process.argv[2]
const dir = process.argv[3]
const pidFile = join(dir, role + ".pid")
writeFileSync(pidFile + ".tmp", String(process.pid))
renameSync(pidFile + ".tmp", pidFile)
if (role === "editor") spawn(process.execPath, [import.meta.path, "leaf", dir], { stdio: "ignore", windowsHide: true })
setInterval(() => {}, 1000)
`,
    )
    const worker = Bun.spawn([process.execPath, shellGuardWorker], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      detached: process.platform !== "win32",
      windowsHide: true,
    })
    const tree = trackProcessTree(worker, { killOnClose: true })
    const pids = () =>
      ["editor.pid", "leaf.pid"]
        .map((name) => join(dir, name))
        .filter(existsSync)
        .map((file) => Number(readFileSync(file, "utf8")))
    try {
      // The worker cannot launch the shell before this gate, even on assertion failure.
      expect(tree.contained).toBe(true)
      const request: ShellGuardRequest = {
        command: `"${process.execPath}"`,
        args: [`"${script}"`, "editor", `"${dir}"`],
        options: { shell: true, stdio: "ignore", windowsHide: true, timeout: 100 },
        resultFile,
        readyFile,
      }
      worker.stdin.write(JSON.stringify(request))
      worker.stdin.end()
      // Startup/antivirus time is not charged against the tight operation budget.
      await waitForSpawnCondition("fake editor readiness", () => existsSync(readyFile))
      expect(pids()).toHaveLength(2)
      expect(await waitForSpawnExit(worker, "timed out shell guard")).toBe(0)
      const result = JSON.parse(readFileSync(resultFile, "utf8")) as ShellGuardResult
      expect(result.status).toBeNull()
      expect(result.error?.code).toBe("ETIMEDOUT")
      await waitForSpawnCondition("owned editor descendants killed", () => pids().every((pid) => !alive(pid)))
    } finally {
      try {
        if (worker.exitCode === null) worker.kill("SIGTERM")
        await waitForSpawnExit(worker, "shell guard regression cleanup")
      } finally {
        try {
          tree.kill()
        } finally {
          tree.dispose()
          // Never leave probe orphans when a readiness or result assertion fails.
          try {
            for (const pid of pids()) killOwned(pid)
            await waitForSpawnCondition("probe cleanup", () => pids().every((pid) => !alive(pid)))
          } finally {
            rmSync(dir, { recursive: true, force: true })
          }
        }
      }
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "bounded shell spawn preserves quoting, arguments, cwd, env and captured output",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "amira-shell-options-"))
    const script = join(dir, "fake editor.ts")
    writeFileSync(
      script,
      "console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), value: process.env.AMIRA_SHELL_PROBE }))\n",
    )
    const bounded = boundSpawnSync()
    try {
      const result = spawnSync(`"${process.execPath}"`, [`"${script}"`, '"argument with spaces"', "--wait"], {
        shell: true,
        windowsHide: true,
        cwd: dir,
        env: { ...process.env, AMIRA_SHELL_PROBE: "original environment" },
        encoding: "utf8",
      })
      expect(result.status).toBe(0)
      expect(result.error).toBeUndefined()
      const output = JSON.parse(result.stdout)
      expect({ ...output, cwd: realpathSync(output.cwd) }).toEqual({
        args: ["argument with spaces", "--wait"],
        cwd: realpathSync(dir),
        value: "original environment",
      })
    } finally {
      bounded.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
