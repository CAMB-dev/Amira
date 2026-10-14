import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { defineTool, type OwnedConversation, type ToolTraits, textResult } from "@amira/api"
import { createSession, type SessionOptions } from "../src/session.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function fixture(deniedName: string, deniedTraits: ToolTraits, options: Partial<SessionOptions>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-owned-startup-"))
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    AMIRA_HOME: process.env.AMIRA_HOME,
  }
  process.env.HOME = dir
  process.env.USERPROFILE = dir
  process.env.AMIRA_HOME = path.join(dir, "home")
  cleanup.push(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  })
  const executions: string[] = []
  const calls = [
    { name: deniedName, args: { command: "echo fixture" } },
    { name: "permitted_read", args: {} },
  ]
  const mock = createMockDialect([
    { toolCalls: calls },
    { text: "done" },
    { toolCalls: calls },
    { text: "done again" },
  ])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const attempts: {
    error: unknown
    groupError: unknown
    requests: number
    executions: string[]
    history: ReturnType<OwnedConversation["history"]>
    busy: boolean
  }[] = []
  let handle!: OwnedConversation
  const session = await createSession({
    ai,
    model: "mock/main",
    cwd: dir,
    extensions: [],
    noBuiltins: false,
    ...options,
    builtins: async () => [
      {
        source: "test:startup-owner",
        extension: async (api) => {
          for (const [name, traits] of [
            [deniedName, deniedTraits],
            ["permitted_read", { readOnly: true }],
          ] as const) {
            api.registerTool(
              defineTool({
                name,
                description: "Startup policy fixture",
                parameters: { type: "object" },
                traits,
                execute: async () => {
                  executions.push(name)
                  return textResult(name)
                },
              }),
            )
          }
          const runtime = { askUser: async () => undefined }
          handle = await api.conversations!.openOrCreate(
            {
              key: "startup",
              name: "Startup",
              cwd: dir,
              systemPrompt: "Exercise the session's tool policy.",
              callableTools: [deniedName, "permitted_read"],
            },
            runtime,
          )
          // Both creation and reopening are allowed during initialization, but remain inert.
          expect(await api.conversations!.open(handle.id, runtime)).toBe(handle)
          expect(mock.requests).toHaveLength(0)
          let error: unknown
          let groupError: unknown
          try {
            handle.createGroup({ name: "Initializer research" }).spawn({ prompt: "startup research" })
          } catch (caught) {
            groupError = caught
          }
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              handle.send("send from awaited initializer"),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("startup send did not reject promptly")), 1000)
              }),
            ])
          } catch (caught) {
            error = caught
          } finally {
            clearTimeout(timer)
          }
          attempts.push({
            error,
            groupError,
            requests: mock.requests.length,
            executions: [...executions],
            history: handle.history(),
            busy: handle.status().busy,
          })
        },
      },
    ],
  })
  cleanup.push(async () => {
    await session.host.runExitHandlers()
    await session.agent.dispose()
  })
  return { session, mock, attempts, executions, handle: () => handle }
}

function expectRejectedStartup(attempt: Awaited<ReturnType<typeof fixture>>["attempts"][number]) {
  expect(attempt).toBeDefined()
  expect(attempt.requests).toBe(0)
  expect(attempt.error).toBeInstanceOf(Error)
  expect(attempt.groupError).toBeInstanceOf(Error)
  expect(String(attempt.groupError)).toContain("initialization")
  expect(String(attempt.error)).not.toContain("did not reject promptly")
  expect(attempt.executions).toEqual([])
  expect(attempt.history).toEqual([])
  expect(attempt.busy).toBe(false)
}

for (const policy of [
  { name: "disabled read", denied: "read", traits: { readOnly: true }, options: { disabledTools: ["read"] } },
  {
    name: "shell selection",
    denied: "windows_command",
    traits: { shell: "powershell" },
    options: { shell: "bash" },
  },
  {
    name: "non-interactive mode",
    denied: "choose_user",
    traits: { interactive: true },
    options: { nonInteractive: true },
  },
] satisfies { name: string; denied: string; traits: ToolTraits; options: Partial<SessionOptions> }[]) {
  test(`${policy.name} cannot be bypassed by an awaited owned startup send`, async () => {
    const f = await fixture(policy.denied, policy.traits, policy.options)
    expect(f.session.startupEvents.filter((event) => event.type === "extension.error")).toEqual([])
    expect(f.session.host.loaded).toContain("test:startup-owner")
    expect(f.attempts).toHaveLength(1)
    expectRejectedStartup(f.attempts[0]!)
    await f.handle().send("send after initialization")
    expect(f.mock.requests).toHaveLength(2)
    expect(f.mock.requests[0]!.tools.map((tool) => tool.name)).toContain("permitted_read")
    expect(f.mock.requests[0]!.tools.map((tool) => tool.name)).not.toContain(policy.denied)
    expect(f.executions).toEqual(["permitted_read"])
    expect(
      f
        .handle()
        .history()
        .some((message) => message.role === "toolResult" && message.isError),
    ).toBe(true)
  })
}

test("reload rejects initializer sends until newly registered shell traits are filtered", async () => {
  let shell: "bash" | "powershell" = "bash"
  const f = await fixture(
    "windows_command",
    { shell: "powershell" },
    {
      settings: { shell },
      reloadSettings: () => ({ settings: { shell }, layers: {} }),
    },
  )
  expect(f.session.startupEvents.filter((event) => event.type === "extension.error")).toEqual([])
  expectRejectedStartup(f.attempts[0]!)
  const old = f.handle()
  shell = "powershell"
  expect((await f.session.reload()).failed).toEqual([])
  expect(f.attempts).toHaveLength(2)
  expectRejectedStartup(f.attempts[1]!)
  await expect(old.send("stale handle")).rejects.toThrow("released")
  await f.handle().send("send after reload")
  expect(f.mock.requests).toHaveLength(2)
  expect(f.mock.requests[0]!.tools.map((tool) => tool.name)).toContain("windows_command")
  expect(f.executions).toEqual(["windows_command", "permitted_read"])
})
