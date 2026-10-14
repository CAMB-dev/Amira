import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { defineTool, type ExtensionAPI, textResult } from "@amira/api"
import commandsExtension from "../../../extensions/commands/src/index.ts"
import { createCommandHost } from "../src/control.ts"
import { createSession } from "../src/session.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(denied: "write" | "powershell") {
  const home = await mkdtemp(path.join(tmpdir(), "amira-live-tool-choices-"))
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    AMIRA_HOME: process.env.AMIRA_HOME,
  }
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.AMIRA_HOME = path.join(home, ".amira")
  cleanup.push(async () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(home, { recursive: true, force: true })
  })
  const executed: string[] = []
  const calls = [
    { name: denied, args: { command: "echo fixture", path: "fixture.txt", content: "fixture" } },
    { name: "read", args: {} },
  ]
  const mock = createMockDialect([
    { toolCalls: calls },
    { text: "ordinary done" },
    { toolCalls: calls },
    { text: "owned done" },
  ])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  let generation = 0
  let loading = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let api!: ExtensionAPI
  const session = await createSession({
    ai,
    model: "mock/test",
    cwd: home,
    extensions: [],
    noBuiltins: false,
    shell: "auto",
    disabledTools: [],
    builtins: async () => [
      { source: "builtin:commands", extension: commandsExtension },
      {
        source: "test:tools",
        extension: async (value) => {
          api = value
          for (const name of ["read", "write", "bash", "powershell"] as const)
            api.registerTool(
              defineTool({
                name,
                description: name,
                parameters: { type: "object" },
                traits:
                  name === "read"
                    ? { readOnly: true }
                    : name === "write"
                      ? { writesFiles: "paths" }
                      : { shell: name },
                getWrittenPaths: () => [],
                execute: async () => {
                  executed.push(name)
                  return textResult(name)
                },
              }),
            )
          if (++generation > 1) {
            loading = true
            await gate
          }
        },
      },
    ],
  })
  const commands = createCommandHost({ session, cwd: home, shell: "auto", disabled: [], platform: "win32" })
  cleanup.push(async () => {
    release()
    await session.host.runExitHandlers()
    await commands.agent.dispose()
    await session.traceRecorder?.close()
  })
  const run = (line: string) => commands.run(line, { frontend: "print" })
  return { home, mock, session, commands, run, executed, api: () => api, loading: () => loading, release }
}

for (const denied of ["write", "powershell"] as const) {
  test(`${denied === "write" ? "/tools disable write" : "/shell bash"} remains enforced through /reload before queued prompts leave the hold`, async () => {
    const f = await fixture(denied)
    expect(f.commands.control.tools().find((tool) => tool.name === denied)?.enabled).toBe(true)
    await f.run(denied === "write" ? "/tools disable write" : "/shell bash")
    expect(f.commands.control.tools().find((tool) => tool.name === denied)?.enabled).toBe(false)
    if (denied === "powershell") expect(f.commands.control.info().shell).toBe("bash")
    const reloading = f.run("/reload")
    try {
      const deadline = Date.now() + 3000
      while (!f.loading()) {
        if (Date.now() > deadline) throw new Error("reload did not reach its hold")
        await Bun.sleep(2)
      }
      expect(f.commands.agent.holdingFor).toBe("reload")
      const queued = f.commands.control.send("queued ordinary prompt")
      expect(f.mock.requests).toHaveLength(0)
      f.release()
      await reloading
      await queued
      const turn = f.commands.agent.currentTurn
      expect(turn).toBeDefined()
      await turn
      expect(f.mock.requests).toHaveLength(2)
      expect(f.commands.control.tools().find((tool) => tool.name === denied)?.enabled).toBe(false)
      if (denied === "powershell") expect(f.commands.control.info().shell).toBe("bash")
      expect(f.mock.requests[0]!.tools.map((tool) => tool.name)).not.toContain(denied)
      expect(f.executed).toEqual(["read"])
      // The reconciled policy must also filter a newly opened private definition.
      const privateDenied = defineTool({
        name: denied,
        description: "Private definition",
        parameters: { type: "object" },
        traits: denied === "write" ? { writesFiles: "paths" } : { shell: "powershell" },
        getWrittenPaths: () => [],
        execute: async () => {
          f.executed.push("private forbidden")
          return textResult("must not execute")
        },
      })
      const owned = await f.api().conversations!.openOrCreate(
        {
          key: "research",
          name: "Research",
          cwd: f.home,
          systemPrompt: "Research",
          callableTools: [denied, "read"],
        },
        { askUser: async () => undefined, extraTools: [privateDenied] },
      )
      await owned.send("try private tool")
      expect(f.mock.requests[2]!.tools.map((tool) => tool.name)).not.toContain(denied)
      expect(f.executed).toEqual(["read", "read"])
    } finally {
      f.release()
      await reloading
    }
  })
}
