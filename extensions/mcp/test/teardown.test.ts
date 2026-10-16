import { afterAll, afterEach, expect, test } from "bun:test"
import {
  SPAWN_TEST_TIMEOUT_MS,
  stopSpawn,
  waitForSpawnCondition,
  waitForSpawnExit,
} from "../../../scripts/spawn-test.ts"
import "../../../packages/core/src/index.ts"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { cleanupSpawnWork, waitForSpawnWork } from "../../builtin-tools/test/util.ts"
import { McpClient } from "../src/client.ts"
import { StdioTransport } from "../src/stdio.ts"
import { launcherArgv } from "./fixtures/launcher.ts"

const FIXTURE = path.join(import.meta.dir, "fixtures", "server.ts")
const EXIT_CHILD = path.join(import.meta.dir, "fixtures", "exit-child.ts")
// Spawning can stall for seconds on machines with aggressive antivirus.
const SLOW = 90_000
const tmp = mkdtempSync(path.join(os.tmpdir(), "amira-mcp-teardown-"))
let n = 0
const pidFiles: string[] = []
const clients: McpClient[] = []
const children: Bun.Subprocess[] = []
afterEach(async () => {
  try {
    await cleanupSpawnWork("MCP teardown resources", [
      ...clients.splice(0).map((client) => () => client.close()),
      ...children.splice(0).map((child) => () => stopSpawn(child, "exit-hook fixture cleanup")),
    ])
  } finally {
    const pids = pidFiles
      .splice(0)
      .filter(existsSync)
      .map((file) => Number(readFileSync(file, "utf8")))
      .filter((pid) => pid > 0)
    for (const pid of pids) {
      if (alive(pid)) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
    }
    await waitForSpawnCondition("stubborn MCP servers cleanup", () => pids.every((pid) => !alive(pid)))
  }
}, SPAWN_TEST_TIMEOUT_MS)
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
}, SPAWN_TEST_TIMEOUT_MS)

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readPid(file: string): Promise<number> {
  await waitForSpawnCondition(
    `server PID in ${file}`,
    () => existsSync(file) && Number(readFileSync(file, "utf8")) > 0,
  )
  return Number(readFileSync(file, "utf8"))
}

/** Waits until the process is gone; false if it is still running after `ms`. */
async function gone(pid: number, ms = 15_000): Promise<boolean> {
  for (const end = performance.now() + ms; performance.now() < end; ) {
    if (!alive(pid)) return true
    await Bun.sleep(100)
  }
  return false
}

function env(pidFile: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") out[k] = v
  return { ...out, FIXTURE_PID_FILE: pidFile }
}

async function closesStubborn(argv: string[]) {
  const pidFile = path.join(tmp, `pid${n++}`)
  pidFiles.push(pidFile)
  const client = new McpClient(
    new StdioTransport({ argv, cwd: import.meta.dir, env: env(pidFile) }, { closeGraceMs: 300 }),
  )
  clients.push(client)
  await client.connect({ timeoutMs: SLOW })
  const pid = await readPid(pidFile)
  expect(alive(pid)).toBe(true)
  await waitForSpawnWork("stubborn MCP server close", client.close())
  expect(await gone(pid)).toBe(true)
}

test(
  "close() kills a server that ignores the end of stdin",
  () => closesStubborn([process.execPath, FIXTURE, "stdio-stubborn"]),
  SPAWN_TEST_TIMEOUT_MS,
)

// Killing only the launcher's pid leaves the real server running on Windows.
test.if(process.platform === "win32")(
  "close() kills a stubborn server started through a launcher, with its whole tree",
  () => closesStubborn(launcherArgv([process.execPath, FIXTURE, "stdio-stubborn"])),
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(process.platform === "win32")(
  "exiting without close() kills a stubborn server behind a launcher",
  async () => {
    const pidFile = path.join(tmp, `pid${n++}`)
    pidFiles.push(pidFile)
    const child = Bun.spawn([process.execPath, EXIT_CHILD, pidFile], {
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
    })
    children.push(child)
    const [code, stderr] = await waitForSpawnWork(
      "exit-hook fixture output",
      Promise.all([waitForSpawnExit(child, "exit-hook fixture", SLOW), new Response(child.stderr).text()]),
      SLOW,
    )
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    const pid = await readPid(pidFile)
    expect(await gone(pid)).toBe(true)
  },
  SPAWN_TEST_TIMEOUT_MS,
)
