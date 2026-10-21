import "../server/offline.ts"
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { stopSpawn, waitForSpawnWork } from "../../../../scripts/spawn-test.ts"

const nativeWindows = process.platform === "win32" && process.arch === "x64"

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (
      /^(AMIRA_|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|AZURE_|AWS_|GITHUB_|GH_|XAI_|MISTRAL_|GROQ_|DEEPSEEK_|OPENROUTER_)/i.test(
        key,
      ) ||
      /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)
    )
      delete env[key]
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    AMIRA_HOME: path.join(home, ".amira"),
    HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ""),
    HOMEPATH: home.slice(path.parse(home).root.length - 1),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_RUNTIME_DIR: path.join(home, "runtime"),
  }
}

async function relay(input: ReadableStream<Uint8Array>, output: Bun.FileSink) {
  try {
    for await (const bytes of input) {
      output.write(bytes)
      await output.flush()
    }
  } finally {
    await output.end()
  }
}

test.skipIf(!nativeWindows)(
  "B14 native compiled client/server fake-SSH frontend-only smoke",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amira-b14-native-"))
    const local = path.join(root, "local-home")
    const remote = path.join(root, "remote-home")
    const localCwd = path.join(root, "local-workspace")
    const workspace = path.join(root, "remote-workspace")
    const children: Bun.Subprocess<"pipe", "pipe", "pipe">[] = []
    try {
      for (const directory of [local, remote, localCwd, workspace]) {
        await mkdir(path.join(directory, ".amira"), { recursive: true })
      }
      await writeFile(path.join(local, ".amira", "settings.json"), "{}")
      // Remote attachment must never load local project settings or instantiate its local session.
      const sentinel = "{ invalid local project settings: do not read"
      await writeFile(path.join(localCwd, ".amira", "settings.json"), sentinel)
      for (const side of ["server", "client"]) {
        const result = await Bun.build({
          entrypoints: [path.join(import.meta.dir, `native-smoke-${side}.ts`)],
          // No target selection: use the installed native Bun, never download cross-target runtimes.
          compile: { outfile: path.join(root, `${side}.exe`), autoloadDotenv: false, autoloadBunfig: false },
          format: "esm",
        })
        expect(result.logs).toEqual([])
        expect(result.success).toBe(true)
      }
      const serverReport = path.join(root, "server.json")
      const clientReport = path.join(root, "client.json")
      const server = Bun.spawn([path.join(root, "server.exe"), workspace, serverReport], {
        cwd: workspace,
        env: isolatedEnv(remote),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      children.push(server)
      const client = Bun.spawn([path.join(root, "client.exe"), workspace, clientReport], {
        cwd: localCwd,
        env: isolatedEnv(local),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      children.push(client)
      // Fake SSH is only local process pipes. The test owns both PIDs even if either fixture hangs.
      const pipes = Promise.allSettled([
        relay(server.stdout, client.stdin),
        relay(client.stdout, server.stdin),
      ])
      const [serverError, clientError, serverCode, clientCode] = await waitForSpawnWork(
        "native fake SSH",
        Promise.all([
          new Response(server.stderr).text(),
          new Response(client.stderr).text(),
          server.exited,
          client.exited,
        ]),
        120_000,
      )
      expect({ serverError, clientError, serverCode, clientCode }).toEqual({
        serverError: "",
        clientError: "",
        serverCode: 0,
        clientCode: 0,
      })
      // Detach can close the opposite stdin before its final EOF; no pipe promise is left unobserved.
      await waitForSpawnWork("native fake SSH pipe cleanup", pipes)
      expect(JSON.parse(await readFile(serverReport, "utf8"))).toEqual({
        mockRequests: 1,
        detachedWithoutStopping: true,
      })
      expect(JSON.parse(await readFile(clientReport, "utf8"))).toEqual({
        code: 0,
        opened: 1,
        validated: 1,
        frontendOnly: true,
        renderedAnswer: true,
      })
      expect(await readdir(path.join(local, ".amira"))).toEqual(["settings.json"])
      expect(await readdir(path.join(localCwd, ".amira"))).toEqual(["settings.json"])
      expect(await readFile(path.join(localCwd, ".amira", "settings.json"), "utf8")).toBe(sentinel)
    } finally {
      try {
        await Promise.all(children.map((child) => stopSpawn(child, "native fake SSH child")))
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  },
  600_000,
)
