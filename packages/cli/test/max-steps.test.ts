import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { parseCliArgs } from "../src/args.ts"
import { resolveConfig } from "../src/config.ts"
import { runPrint } from "../src/print.ts"
import { createSession } from "../src/session.ts"

const dir = mkdtempSync(join(tmpdir(), "amira-max-steps-"))
const home = join(dir, "home")
const cwd = join(dir, "project")
let savedHome: string | undefined
beforeAll(() => {
  mkdirSync(home)
  mkdirSync(cwd)
  savedHome = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = home
})
afterAll(() => {
  if (savedHome === undefined) delete process.env.AMIRA_HOME
  else process.env.AMIRA_HOME = savedHome
  rmSync(dir, { recursive: true, force: true })
})

for (const [setting, flag, calls] of [
  [undefined, undefined, 500],
  [3, undefined, 3],
  [3, 5, 5],
  [1, 0, 551],
  [0, 4, 4],
  [0, undefined, 551],
] as const) {
  test(`print mode applies setting ${setting} and flag ${flag} to the main agent`, async () => {
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify(setting === undefined ? {} : { agent: { maxSteps: setting } }),
    )
    const args = parseCliArgs(
      ["-p", ...(flag === undefined ? [] : ["--max-steps", String(flag)]), "go"],
      cwd,
      {},
    )
    const config = resolveConfig(args, home)
    const mock = createMockDialect([
      ...Array.from({ length: 550 }, () => ({ toolCalls: [{ name: "echo", args: {} }] })),
      { text: "finished" },
    ])
    const ai = createAi({
      dialects: [mock],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      retry: { retries: 0 },
    })
    const session = await createSession({
      cwd,
      ai,
      model: "mock/test",
      settings: config.settings,
      settingsLayers: config.settingsLayers,
      extensions: [],
      noBuiltins: true,
      nonInteractive: true,
      compaction: { auto: false },
    })
    session.agent.tools.register(
      defineTool({ name: "echo", description: "", parameters: {}, execute: async () => textResult("ok") }),
      "test",
    )
    let stdout = ""
    let stderr = ""
    try {
      const code = await runPrint(session.agent, args.prompt!, false, {
        io: {
          stdout: (text) => {
            stdout += text
          },
          stderr: (text) => {
            stderr += text
          },
        },
      })
      expect(mock.requests).toHaveLength(calls)
      expect(code).toBe(calls === 551 ? 0 : 1)
      if (calls === 551) expect(stdout).toBe("finished\n")
      else
        expect(stderr).toContain(
          `stopped after ${calls} model calls; raise agent.maxSteps or use --max-steps 0`,
        )
    } finally {
      session.host.unloadAll()
      await session.host.drain()
      await session.agent.dispose()
    }
  })
}
