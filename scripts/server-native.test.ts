import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildServer, serverBuildOptions } from "./build-server.ts"
import { SPAWN_TEST_TIMEOUT_MS, stopSpawn, waitForSpawnWork } from "./spawn-test.ts"

const nativeWindows = process.platform === "win32" && process.arch === "x64"

test.skipIf(!nativeWindows)(
  "native Windows server probes validate embedded identity and workers without settings",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amira-server-native-"))
    const local = path.join(root, "local-home")
    const remote = path.join(root, "remote-home")
    const workspace = path.join(root, "workspace")
    const output = path.join(root, "output")
    const invalidSettings = "{ deliberately invalid settings"
    try {
      for (const home of [local, remote, workspace]) {
        await mkdir(path.join(home, ".amira"), { recursive: true })
        await writeFile(path.join(home, ".amira", "settings.json"), invalidSettings)
      }
      const argv = [
        "--native-windows-test",
        "--version",
        "1.2.3",
        "--channel",
        "next",
        "--build-id",
        "0123456789abcdef0123456789abcdef01234567",
      ]
      const options = serverBuildOptions(argv)
      await buildServer(argv, { directory: output })
      expect(await readdir(output)).toEqual(["amira-server-native-test.exe"])
      const env: Record<string, string | undefined> = { ...process.env }
      for (const key of Object.keys(env)) {
        if (
          /^(AMIRA_|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|AZURE_|AWS_|GITHUB_|GH_|XAI_|MISTRAL_|GROQ_|DEEPSEEK_|OPENROUTER_)/i.test(
            key,
          ) ||
          /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)
        )
          delete env[key]
      }
      Object.assign(env, {
        HOME: remote,
        USERPROFILE: remote,
        AMIRA_HOME: path.join(remote, ".amira"),
        HOMEDRIVE: path.parse(remote).root.replace(/[\\/]$/, ""),
        HOMEPATH: remote.slice(path.parse(remote).root.length - 1),
        XDG_CONFIG_HOME: path.join(remote, "config"),
        XDG_CACHE_HOME: path.join(remote, "cache"),
        XDG_DATA_HOME: path.join(remote, "data"),
        XDG_STATE_HOME: path.join(remote, "state"),
        XDG_RUNTIME_DIR: path.join(remote, "runtime"),
        // Compiled identity must not be replaceable by the execution environment.
        AMIRA_SERVER_BUILD_ID: "development-forged-environment",
      })
      const identity = {
        product: "amira-server",
        version: "1.2.3",
        channel: "next",
        target: "bun-windows-x64",
        buildId: options.buildId,
      }
      for (const flag of ["--version-json", "--self-check"]) {
        const child = Bun.spawn([path.join(output, "amira-server-native-test.exe"), flag], {
          cwd: workspace,
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        })
        try {
          const [stdout, stderr, code] = await waitForSpawnWork(
            flag,
            Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
          )
          expect(stderr).toBe("")
          expect(code).toBe(0)
          const result = JSON.parse(stdout)
          expect(result).toMatchObject(identity)
          if (flag === "--self-check") {
            expect(result).toMatchObject({ ok: true, worker: "worker", stdoutWorker: true, errors: [] })
          } else {
            expect(result).toEqual(identity)
          }
        } finally {
          await stopSpawn(child, `server ${flag}`)
        }
      }
      for (const home of [local, remote, workspace]) {
        expect(await readdir(path.join(home, ".amira"))).toEqual(["settings.json"])
        expect(await readFile(path.join(home, ".amira", "settings.json"), "utf8")).toBe(invalidSettings)
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
