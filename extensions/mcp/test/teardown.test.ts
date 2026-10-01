import { afterAll, expect, test } from "bun:test"
import "../../../packages/core/src/index.ts"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { McpClient } from "../src/client.ts"
import { StdioTransport } from "../src/stdio.ts"
import { launcherArgv } from "./fixtures/launcher.ts"

const FIXTURE = path.join(import.meta.dir, "fixtures", "server.ts")
const EXIT_CHILD = path.join(import.meta.dir, "fixtures", "exit-child.ts")
// Spawning can stall for seconds on machines with aggressive antivirus.
const SLOW = 90_000
const tmp = mkdtempSync(path.join(os.tmpdir(), "amira-mcp-teardown-"))
let n = 0
const survivors: number[] = []
afterAll(() => {
  for (const pid of survivors) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  rmSync(tmp, { recursive: true, force: true })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 600 && !existsSync(file); i++) await Bun.sleep(50)
  for (let i = 0; i < 100; i++) {
    const pid = Number(readFileSync(file, "utf8"))
    if (pid > 0) return pid
    await Bun.sleep(20)
  }
  throw new Error(`no pid in ${file}`)
}

/** Waits until the process is gone; false if it is still running after `ms`. */
async function gone(pid: number, ms = 15_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (!alive(pid)) return true
    await Bun.sleep(100)
  }
  survivors.push(pid)
  return false
}

function env(pidFile: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") out[k] = v
  return { ...out, FIXTURE_PID_FILE: pidFile }
}

async function closesStubborn(argv: string[]) {
  const pidFile = path.join(tmp, `pid${n++}`)
  const client = new McpClient(
    new StdioTransport({ argv, cwd: import.meta.dir, env: env(pidFile) }, { closeGraceMs: 300 }),
  )
  await client.connect({ timeoutMs: SLOW })
  const pid = await readPid(pidFile)
  expect(alive(pid)).toBe(true)
  await client.close()
  expect(await gone(pid)).toBe(true)
}

test(
  "close() kills a server that ignores the end of stdin",
  () => closesStubborn([process.execPath, FIXTURE, "stdio-stubborn"]),
  SLOW,
)

// Killing only the launcher's pid leaves the real server running on Windows.
test.if(process.platform === "win32")(
  "close() kills a stubborn server started through a launcher, with its whole tree",
  () => closesStubborn(launcherArgv([process.execPath, FIXTURE, "stdio-stubborn"])),
  SLOW,
)

test.if(process.platform === "win32")(
  "exiting without close() kills a stubborn server behind a launcher",
  async () => {
    const pidFile = path.join(tmp, `pid${n++}`)
    const child = Bun.spawn([process.execPath, EXIT_CHILD, pidFile], {
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
    })
    const code = await child.exited
    expect({ code, stderr: await new Response(child.stderr).text() }).toEqual({ code: 0, stderr: "" })
    const pid = await readPid(pidFile)
    expect(await gone(pid)).toBe(true)
  },
  SLOW,
)
