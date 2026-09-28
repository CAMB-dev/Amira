import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseCliArgs } from "../src/args.ts"
import { resolveConfig } from "../src/config.ts"
import { runPrint } from "../src/print.ts"
import { runProviderCommand } from "../src/provider-command.ts"
import { createSession } from "../src/session.ts"

// Runs a DeepSeek prompt through a provider added from a preset when AMIRA_LIVE_DEEPSEEK_KEY is set.
const KEY_ENV = "AMIRA_LIVE_DEEPSEEK_KEY"

test.skipIf(!process.env[KEY_ENV])(
  "a preset added to settings.json reaches DeepSeek",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "amira-live-config-"))
    try {
      const home = path.join(dir, "home")
      const cwd = path.join(dir, "project")
      mkdirSync(path.join(cwd, ".amira"), { recursive: true })
      const quiet = { stdout: () => {}, stderr: () => {} }
      expect(runProviderCommand(["add", "deepseek"], quiet, home)).toBe(0)
      // The user layer points the preset at the test's key variable; a project file may not.
      const userFile = path.join(home, "settings.json")
      const user = JSON.parse(readFileSync(userFile, "utf8"))
      user.providers.deepseek.apiKeyEnv = KEY_ENV
      writeFileSync(userFile, JSON.stringify(user))
      writeFileSync(path.join(cwd, ".amira", "settings.json"), JSON.stringify({ model: "deepseek/deepseek-flash" }))
      const config = resolveConfig(parseCliArgs(["-C", cwd, "-p", "x"], dir, {}), home)
      expect(config.warnings).toEqual([])
      expect(config.providers.find((p) => p.id === "deepseek")?.apiKeyEnv).toBe(KEY_ENV)
      const { agent } = await createSession({
        model: config.settings.model!,
        cwd,
        extensions: [],
        noBuiltins: true,
        settings: config.settings,
        providers: config.providers,
        apiKeys: config.apiKeys,
      })
      let stdout = ""
      let stderr = ""
      const code = await runPrint(agent, "Reply with the word: pong", false, {
        io: {
          stdout: (s) => {
            stdout += s
          },
          stderr: (s) => {
            stderr += s
          },
        },
      })
      expect(stderr).toBe("")
      expect(code).toBe(0)
      expect(stdout.toLowerCase()).toContain("pong")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  120_000,
)
