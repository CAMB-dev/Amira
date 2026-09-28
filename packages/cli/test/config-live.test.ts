import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseCliArgs } from "../src/args.ts"
import { resolveConfig } from "../src/config.ts"
import { runPrint } from "../src/print.ts"
import { runProviderAdminCommand } from "../src/provider-cli.ts"
import { createSession } from "../src/session.ts"

// Runs a DeepSeek prompt through a provider added with amira provider add when AMIRA_LIVE_DEEPSEEK_KEY is set.
const KEY_ENV = "AMIRA_LIVE_DEEPSEEK_KEY"

test.skipIf(!process.env[KEY_ENV])(
  "a provider added with its protocol and flags reaches DeepSeek",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "amira-live-config-"))
    try {
      const home = path.join(dir, "home")
      const cwd = path.join(dir, "project")
      mkdirSync(path.join(cwd, ".amira"), { recursive: true })
      const quiet = { stdout: () => {}, stderr: () => {} }
      const added = await runProviderAdminCommand(
        [
          "add",
          "openai-chat",
          "--id",
          "deepseek",
          "--base-url",
          "https://api.deepseek.com",
          "--key-env",
          KEY_ENV,
        ],
        { io: quiet, home, cwd, env: {}, interactive: false },
      )
      expect(added).toBe(0)
      writeFileSync(
        path.join(cwd, ".amira", "settings.json"),
        JSON.stringify({ model: "deepseek/deepseek-flash" }),
      )
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
