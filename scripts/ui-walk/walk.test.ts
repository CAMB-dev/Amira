import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { trackProcessTree } from "../../packages/proc/src/index.ts"
import { address, positiveInteger, request, type SessionAddress, sessionRoot, start } from "./session.ts"

function ptyUnavailable(): boolean {
  try {
    const terminal = new Bun.Terminal({ cols: 10, rows: 3 })
    terminal.close()
    return false
  } catch (error) {
    // Restricted Linux containers without /dev/ptmx, or an OS where Bun has no PTY implementation.
    if (
      /not supported|not implemented|ENOSYS|ENODEV|ENOENT|EACCES|EPERM|operation not permitted/i.test(
        String(error),
      )
    ) {
      console.warn(`UI walk E2E: PTY genuinely unavailable: ${error}`)
      return true
    }
    throw error
  }
}

test("validates names and dimensions before using the registry", () => {
  for (const name of ["../escape", "", "a/b", "a".repeat(65)]) expect(() => sessionRoot(name)).toThrow()
  for (const value of [0, -1, "NaN", 1.5, 501]) expect(() => positiveInteger(value, "cols", 500)).toThrow()
  expect(positiveInteger("100", "cols", 500)).toBe(100)
})

test.skipIf(ptyUnavailable())(
  "real TUI sessions stream offline replies independently and clean up",
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ui-walk-e2e-"))
    const scenario = path.join(dir, "scenario.json")
    await writeFile(
      scenario,
      JSON.stringify({
        name: "e2e",
        description: "Fast real-TUI smoke test",
        prompt: "hello",
        routes: { main: [{ text: "Walkthrough E2E response arrived.", chunkSize: 8, delayMs: 2 }] },
      }),
    )
    const names = [`e2e-${randomUUID()}`, `e2e-${randomUUID()}`]
    const roots: string[] = []
    try {
      const sessions = await Promise.all(
        names.map(async (name) => {
          const launcher = Bun.spawn(
            [
              process.execPath,
              path.join(import.meta.dir, "walk.ts"),
              "start",
              name,
              "--cols",
              "100",
              "--rows",
              "32",
              "--scenario",
              scenario,
              "--idle-timeout",
              "60000",
              "--",
              "--fullscreen",
            ],
            { detached: process.platform !== "win32", windowsHide: true, stdout: "pipe", stderr: "pipe" },
          )
          // Reproduce an agent shell host: it kills its whole tree once the CLI call ends.
          const toolTree = trackProcessTree(launcher, { killOnClose: true })
          try {
            const [output, error, code] = await Promise.all([
              new Response(launcher.stdout).text(),
              new Response(launcher.stderr).text(),
              launcher.exited,
            ])
            expect(code).toBe(0)
            if (code !== 0) throw new Error(`CLI start failed: ${output}${error}`)
          } finally {
            toolTree.kill()
            toolTree.dispose()
          }
          const state = await address(name)
          roots.push(state.root)
          return state
        }),
      )
      expect(sessions[0]!.root).not.toBe(sessions[1]!.root)
      expect(sessions[0]!.port).not.toBe(sessions[1]!.port)
      expect(sessions[0]!.childPid).not.toBe(sessions[1]!.childPid)
      for (const name of names)
        await request(name, { command: "wait", text: "ui-walk/main", timeout: 10_000 })
      await request(names[0]!, { command: "keys", keys: ["text:/model", "enter"] })
      await request(names[0]!, { command: "wait", text: "Model (now", timeout: 10_000 })
      await request(names[0]!, { command: "keys", keys: ["esc", "text:hello", "enter"] })
      await request(names[0]!, {
        command: "wait",
        text: "Walkthrough E2E response arrived.",
        timeout: 10_000,
      })
      const text = await (await request(names[0]!, { command: "text" })).text()
      expect(text).toContain("hello")
      expect(text).toContain("Walkthrough E2E response arrived.")
      expect(text).toMatch(/^\s*1[ :|]/)
      expect(await (await request(names[1]!, { command: "text" })).text()).not.toContain(
        "Walkthrough E2E response arrived.",
      )
      const first = await address(names[0]!)
      const unauthorized = await fetch(`http://127.0.0.1:${first.port}/`, { method: "POST", body: "{}" })
      expect(unauthorized.status).toBe(403)
      await request(names[0]!, { command: "resize", cols: 60, rows: 24 })
      const status = (await (await request(names[0]!, { command: "status" })).json()) as {
        cols: number
        rows: number
      }
      expect(status.cols).toBe(60)
      expect(status.rows).toBe(24)
      await request(names[0]!, { command: "stop" })
      // Stopping one tree must not stop its neighbor.
      const neighbor = (await (await request(names[1]!, { command: "status" })).json()) as {
        exitCode: number | null
      }
      expect(neighbor.exitCode).toBeNull()
    } finally {
      await Promise.all(names.map((name) => request(name, { command: "stop" }).catch(() => undefined)))
      const deadline = Date.now() + 5000
      while (
        Date.now() < deadline &&
        (await Promise.all(roots.map((root) => stat(root).catch(() => undefined)))).some(Boolean)
      ) {
        await Bun.sleep(50)
      }
      for (const root of roots) expect(await stat(root).catch(() => undefined)).toBeUndefined()
      for (const name of names) await expect(address(name)).rejects.toThrow("is not running")
      await rm(dir, { recursive: true, force: true })
    }
  },
  30_000,
)

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function stopCached(session: SessionAddress | undefined): Promise<void> {
  if (!session) return
  await fetch(`http://127.0.0.1:${session.port}/`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    body: JSON.stringify({ command: "stop" }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined)
}

test.skipIf(ptyUnavailable())(
  "failed start cannot delete a replacement generation",
  async () => {
    const name = `reuse-${randomUUID()}`
    let replacement: SessionAddress | undefined
    const options = { cols: 100, rows: 32, idleTimeout: 60_000, args: ["--fullscreen"] }
    try {
      await expect(
        start(name, { ...options, scenario: path.join(os.tmpdir(), `missing-${randomUUID()}.json`) }),
      ).rejects.toThrow()
      replacement = await start(name, options)
      await request(name, { command: "wait", text: "ui-walk/main", timeout: 10_000 })
      await Bun.sleep(5500) // The failed daemon's delayed five-second cleanup must be harmless.
      expect((await address(name)).token).toBe(replacement.token)
      expect(await (await request(name, { command: "text" })).text()).toContain("ui-walk/main")
    } finally {
      await stopCached(replacement)
    }
  },
  30_000,
)

test.skipIf(ptyUnavailable())(
  "unexpected Amira exit is reported and cleans its daemon and directory",
  async () => {
    const name = `exit-${randomUUID()}`
    let session: SessionAddress | undefined
    try {
      session = await start(name, { cols: 100, rows: 32, idleTimeout: 60_000, args: ["--fullscreen"] })
      await request(name, { command: "wait", text: "ui-walk/main", timeout: 10_000 })
      const settings = JSON.parse(
        await readFile(path.join(session.root, "home/.amira/settings.json"), "utf8"),
      )
      const providerUrl = settings.providers["ui-walk"].baseUrl as string
      // This fresh PID belongs to the session created above, never a stale registry entry.
      process.kill(session.childPid, "SIGKILL")
      await Bun.sleep(200)
      await expect(request(name, { command: "text" })).rejects.toThrow("Amira exited")
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && (await stat(session.root).catch(() => undefined))) await Bun.sleep(25)
      expect(await stat(session.root).catch(() => undefined)).toBeUndefined()
      await Bun.sleep(100)
      await expect(
        fetch(`http://127.0.0.1:${session.port}/`, { signal: AbortSignal.timeout(1000) }),
      ).rejects.toThrow()
      await expect(fetch(providerUrl, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
      const daemonDeadline = Date.now() + 5000
      while (Date.now() < daemonDeadline && processIsAlive(session.pid)) await Bun.sleep(25)
      expect(processIsAlive(session.pid)).toBe(false)
    } finally {
      await stopCached(session)
    }
  },
  30_000,
)

test.skipIf(ptyUnavailable())(
  "unexpected Amira exit expires after its grace even without another CLI call",
  async () => {
    const name = `grace-${randomUUID()}`
    let session: SessionAddress | undefined
    try {
      session = await start(name, { cols: 100, rows: 32, idleTimeout: 60_000, args: ["--fullscreen"] })
      await request(name, { command: "wait", text: "ui-walk/main", timeout: 10_000 })
      process.kill(session.childPid, "SIGKILL")
      await Bun.sleep(5500)
      expect(await stat(session.root).catch(() => undefined)).toBeUndefined()
      await expect(address(name)).rejects.toThrow("is not running")
      expect(processIsAlive(session.pid)).toBe(false)
    } finally {
      await stopCached(session)
    }
  },
  30_000,
)
