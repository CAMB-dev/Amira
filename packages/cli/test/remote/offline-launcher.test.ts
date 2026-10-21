import "../server/offline.ts"
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { stopSpawn, waitForSpawnWork } from "../../../../scripts/spawn-test.ts"

const root = path.resolve(import.meta.dir, "../../../..")
const probe = `import { expect, test } from "bun:test"
test("dotenv cannot re-enable live tests or reload credentials", () => {
  expect(process.env.AMIRA_LIVE_B15_SENTINEL).toBeUndefined()
  expect(process.env.OPENAI_API_KEY).toBeUndefined()
  expect(process.env.B15_DOTENV_MARKER).toBeUndefined()
  expect(process.env.HOME).not.toBe(process.env.B15_ORIGINAL_HOME)
})
`

for (const mode of ["launcher", "nested check"] as const) {
  test(`offline ${mode} prevents dotenv reload before test preloads`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amira-b15-dotenv-"))
    let child: Bun.Subprocess | undefined
    try {
      const home = path.join(directory, "home")
      await mkdir(home)
      const dotenv =
        "AMIRA_LIVE_B15_SENTINEL=1\nOPENAI_API_KEY=dummy-not-a-provider-key\nB15_DOTENV_MARKER=loaded\n"
      await writeFile(path.join(directory, ".env"), dotenv)
      await writeFile(path.join(directory, ".env.test"), dotenv)
      await writeFile(path.join(directory, "probe.test.ts"), probe)
      const env = { ...process.env }
      for (const name of Object.keys(env)) {
        if (/^AMIRA_|API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)) delete env[name]
      }
      Object.assign(env, {
        HOME: home,
        USERPROFILE: home,
        AMIRA_HOME: path.join(home, ".amira"),
        XDG_CONFIG_HOME: home,
        XDG_CACHE_HOME: home,
        XDG_DATA_HOME: home,
        XDG_STATE_HOME: home,
        XDG_RUNTIME_DIR: home,
        B15_ORIGINAL_HOME: process.env.HOME,
        HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ""),
        HOMEPATH: home.slice(path.parse(home).root.length - 1),
      })
      const args = [process.execPath, "--no-env-file", "--no-install"]
      if (mode === "launcher") {
        // The launcher must set its own restrictions, not rely on its parent's options.
        delete env.BUN_OPTIONS
        args.push(path.join(import.meta.dir, "e2e-offline.ts"), path.join(directory, "probe.test.ts"))
      } else {
        const instructions = await Bun.file(path.join(root, "scripts/TESTING.md")).text()
        env.BUN_OPTIONS = instructions.match(/\$env:BUN_OPTIONS = '([^']+)'/)?.[1]
        expect(env.BUN_OPTIONS).toBe("--no-env-file --no-install")
        await writeFile(
          path.join(directory, "package.json"),
          JSON.stringify({ scripts: { check: "bun run nested", nested: "bun test probe.test.ts" } }),
        )
        args.push("run", "check")
      }
      const spawned = Bun.spawn(args, {
        cwd: directory,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      child = spawned
      const [code, stdout, stderr] = await waitForSpawnWork(
        `offline ${mode}`,
        Promise.all([
          spawned.exited,
          new Response(spawned.stdout).text(),
          new Response(spawned.stderr).text(),
        ]),
        60_000,
      )
      expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 })
      expect(stdout + stderr).toContain("1 pass")
      expect(stdout + stderr).not.toContain("1 fail")
    } finally {
      try {
        if (child) await stopSpawn(child, `offline ${mode}`)
      } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  }, 120_000)
}
