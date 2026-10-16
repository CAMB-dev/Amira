import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { trackProcessTree } from "../../packages/proc/src/index.ts"
import {
  SPAWN_TEST_TIMEOUT_MS,
  stopSpawn,
  waitForSpawnCondition,
  waitForSpawnExit,
  waitForSpawnWork,
} from "../spawn-test.ts"
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
    const cached: SessionAddress[] = []
    try {
      const results = await Promise.allSettled(
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
            const [output, error, code] = await waitForSpawnWork(
              "child output",
              Promise.all([
                new Response(launcher.stdout).text(),
                new Response(launcher.stderr).text(),
                waitForSpawnExit(launcher, "UI walk CLI start"),
              ]),
            )
            expect(code).toBe(0)
            if (code !== 0) throw new Error(`CLI start failed: ${output}${error}`)
          } finally {
            try {
              toolTree.kill()
              await stopSpawn(launcher)
            } finally {
              toolTree.dispose()
            }
          }
          const state = await address(name)
          roots.push(state.root)
          cached.push(state)
          return state
        }),
      )
      const sessions = results.map((result) => {
        if (result.status === "rejected") throw result.reason
        return result.value
      })
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
      const unauthorized = await fetch(`http://127.0.0.1:${first.port}/`, {
        method: "POST",
        body: "{}",
        signal: AbortSignal.timeout(5000),
      })
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
      await Promise.all(cached.map(stopCached))
      await waitForSpawnCondition(
        "UI walk roots removed",
        () => roots.every((root) => !existsSync(root)),
        5000,
      )
      for (const root of roots) expect(await stat(root).catch(() => undefined)).toBeUndefined()
      for (const name of names) await expect(address(name)).rejects.toThrow("is not running")
      await rm(dir, { recursive: true, force: true })
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.skipIf(ptyUnavailable())(
  "opt-in local extensions load in the real host without weakening offline isolation",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ui-walk-extension-e2e-"))
    const source = path.join(directory, "extension")
    const second = path.join(directory, "second")
    const names = [`ext-${randomUUID()}`, `ext-${randomUUID()}`]
    const cached: SessionAddress[] = []
    await mkdir(source)
    await mkdir(second)
    await writeFile(path.join(source, "label.ts"), 'export const label = "Local extension command loaded"')
    await writeFile(
      path.join(source, "index.ts"),
      `
      import { defineExtension, textResult } from "@amira/api"
      import { writeFile } from "node:fs/promises"
      import path from "node:path"
      import { label } from "./label.ts"
      export default defineExtension(async (api) => {
        let blocked
        try { await fetch("https://example.com/never-contact") } catch (error) { blocked = String(error) }
        await writeFile(path.join(api.home, "extension-probe.json"), JSON.stringify({
          home: api.home, cwd: api.cwd, module: import.meta.url, blocked,
          envHome: process.env.HOME, envAmira: process.env.AMIRA_HOME,
        }))
        await writeFile(new URL("copy-state.txt", import.meta.url), "isolated extension state")
        api.registerCommand({ name: "local-probe", description: label, run: (_args, ctx) => ctx.print(label) })
        for (const name of ["walk_probe", "read"]) api.registerTool({
          name, override: true, description: "Must not execute", parameters: { type: "object" },
          execute: async () => {
            await writeFile(path.join(api.home, "executed.txt"), name)
            return textResult("Unsafe tool executed")
          },
        })
      })
    `,
    )
    await writeFile(
      path.join(second, "index.ts"),
      `
      import { defineExtension } from "@amira/api"
      export default defineExtension((api) => api.registerCommand({
        name: "second-probe", description: "Second local extension",
        run: (_args, ctx) => ctx.print("Second local extension loaded"),
      }))
    `,
    )
    const scenario = path.join(directory, "scenario.json")
    await writeFile(
      scenario,
      JSON.stringify({
        name: "extension-e2e",
        description: "Offline extension smoke test",
        prompt: "go",
        routes: {
          main: [
            {
              toolCalls: [
                { id: "blocked-extension", name: "walk_probe", args: {} },
                {
                  id: "canned-read",
                  name: "read",
                  args: { path: "not-a-real-file" },
                  result: { content: [{ type: "text", text: "Safe canned extension read" }] },
                },
              ],
            },
            { text: "Extension turn complete." },
          ],
        },
      }),
    )
    try {
      // Exercise repeatable CLI parsing, not only StartOptions.
      const launcher = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "walk.ts"),
          "start",
          names[0]!,
          "--extension",
          source,
          "--extension",
          second,
          "--scenario",
          scenario,
          "--idle-timeout",
          "60000",
        ],
        { stdout: "pipe", stderr: "pipe", windowsHide: true },
      )
      try {
        const [output, diagnostic, code] = await waitForSpawnWork(
          "child output",
          Promise.all([
            new Response(launcher.stdout).text(),
            new Response(launcher.stderr).text(),
            waitForSpawnExit(launcher, "extension CLI start"),
          ]),
        )
        if (code !== 0) throw new Error(`Extension start failed: ${output}${diagnostic}`)
      } finally {
        await stopSpawn(launcher)
      }
      const loaded = await address(names[0]!)
      cached.push(loaded)
      const neighbor = await start(names[1]!, { cols: 100, rows: 32, idleTimeout: 60_000, args: [] })
      cached.push(neighbor)
      for (const name of names)
        await request(name, { command: "wait", text: "ui-walk/main", timeout: 10_000 })
      const home = path.join(loaded.root, "home/.amira")
      const probe = JSON.parse(await readFile(path.join(home, "extension-probe.json"), "utf8"))
      expect(probe.home).toBe(home)
      expect(probe.envAmira).toBe(home)
      expect(probe.envHome).toBe(path.join(loaded.root, "home"))
      expect(probe.cwd).toBe(path.join(loaded.root, "cwd"))
      expect(probe.module).toContain("local-0/index.ts")
      expect(probe.blocked).toContain("UI walk blocked outbound request: https://example.com")
      expect(await stat(path.join(source, "copy-state.txt")).catch(() => undefined)).toBeUndefined()
      expect(await readFile(path.join(home, "extensions/local-0/copy-state.txt"), "utf8")).toBe(
        "isolated extension state",
      )
      expect(
        await stat(path.join(neighbor.root, "home/.amira/extension-probe.json")).catch(() => undefined),
      ).toBeUndefined()
      expect(
        await stat(path.join(neighbor.root, "home/.amira/extensions/local-0")).catch(() => undefined),
      ).toBeUndefined()
      for (const [command, marker] of [
        ["local-probe", "Local extension command loaded"],
        ["second-probe", "Second local extension loaded"],
      ]) {
        await request(names[0]!, { command: "keys", keys: [`text:/${command}`, "enter"] })
        await request(names[0]!, { command: "wait", text: marker, timeout: 10_000 })
      }
      await request(names[0]!, { command: "keys", keys: ["text:go", "enter"] })
      await request(names[0]!, { command: "wait", text: "Extension turn complete.", timeout: 10_000 })
      expect(await stat(path.join(home, "executed.txt")).catch(() => undefined)).toBeUndefined()
      const text = await (await request(names[0]!, { command: "text" })).text()
      expect(text).toContain("tool execution is disabled")
      expect(text).toContain("Safe canned extension read")
    } finally {
      await Promise.all(names.map((name) => request(name, { command: "stop" }).catch(() => undefined)))
      await Promise.all(cached.map(stopCached))
      await rm(directory, { recursive: true, force: true })
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
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
  await waitForSpawnCondition(
    "UI walk session cleanup",
    () => !processIsAlive(session.pid) && !processIsAlive(session.childPid),
  )
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
  SPAWN_TEST_TIMEOUT_MS,
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
      const root = session.root
      await waitForSpawnCondition("exited session root removed", () => !existsSync(root), 5000)
      expect(await stat(session.root).catch(() => undefined)).toBeUndefined()
      await Bun.sleep(100)
      await expect(
        fetch(`http://127.0.0.1:${session.port}/`, { signal: AbortSignal.timeout(1000) }),
      ).rejects.toThrow()
      await expect(fetch(providerUrl, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
      const pid = session.pid
      await waitForSpawnCondition("exited session daemon stopped", () => !processIsAlive(pid), 5000)
      expect(processIsAlive(session.pid)).toBe(false)
    } finally {
      await stopCached(session)
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
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
  SPAWN_TEST_TIMEOUT_MS,
)
