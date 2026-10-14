import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { defineTool, type ExtensionAPI, type ToolDefinition, type ToolTraits, textResult } from "@amira/api"
import { createCommandHost } from "../src/control.ts"
import { createSession, type SessionOptions } from "../src/session.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(
  steps: MockStep[],
  options: Partial<SessionOptions>,
  globalTools: ToolDefinition[] = [],
) {
  const home = await mkdtemp(path.join(tmpdir(), "amira-private-policy-"))
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
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  let api!: ExtensionAPI
  const session = await createSession({
    ai,
    model: "mock/test",
    cwd: home,
    extensions: [],
    noBuiltins: false,
    ...options,
    builtins: async () => [
      {
        source: "test:private-policy",
        extension: (value) => {
          api = value
          for (const tool of globalTools) api.registerTool(tool)
        },
      },
    ],
  })
  // Exercise the frontend's second mask application as well as createSession initialization.
  const commands = createCommandHost({
    session,
    cwd: home,
    shell: options.shell ?? options.settings?.shell,
    disabled: options.disabledTools ?? [],
  })
  cleanup.push(async () => {
    await session.host.runExitHandlers()
    await commands.agent.dispose()
    await session.traceRecorder?.close()
  })
  return { home, mock, session, commands, api: () => api }
}

function privateTools(name: string, traits: ToolTraits, deferred: boolean, executed: string[]) {
  const forbidden = defineTool({
    name,
    description: "Private capability",
    parameters: { type: "object" },
    traits,
    ...(deferred ? { exposure: "deferred" } : {}),
    execute: async () => {
      executed.push(name)
      return textResult("must not execute")
    },
  })
  const read = defineTool({
    name: "private_read",
    description: "Allowed private read",
    parameters: { type: "object" },
    traits: { readOnly: true },
    execute: async () => {
      executed.push("private_read")
      return textResult("read")
    },
  })
  const load = defineTool({
    name: "load_private",
    description: "Load private research tools",
    parameters: { type: "object" },
    traits: { readOnly: true },
    execute: async (_args, context) => {
      context.session!.loadTools([name])
      executed.push("load_private")
      return textResult("loaded available tools")
    },
  })
  return [forbidden, read, load]
}

function steps(name: string, deferred: boolean): MockStep[] {
  return [
    ...(deferred ? [{ toolCalls: [{ name: "load_private", args: {} }] }] : []),
    {
      toolCalls: [
        { name, args: { command: "echo fixture" } },
        { name: "private_read", args: {} },
      ],
    },
    { text: "done" },
  ]
}

const policies = [
  {
    label: "shell selection",
    name: "windows_command",
    traits: { shell: "powershell" },
    options: { shell: "bash" },
  },
  {
    label: "noninteractive",
    name: "private_question",
    traits: { interactive: true },
    options: { nonInteractive: true },
  },
  {
    label: "builtin interactive floor",
    name: "ask_user",
    traits: { interactive: false },
    options: { nonInteractive: true },
  },
] satisfies { label: string; name: string; traits: ToolTraits; options: Partial<SessionOptions> }[]

for (const policy of policies) {
  for (const deferred of [false, true]) {
    test(`private ${deferred ? "deferred" : "active"} root tools obey ${policy.label} after initialization and reopen`, async () => {
      const oneTurn = steps(policy.name, deferred)
      const f = await fixture([...oneTurn, ...oneTurn], policy.options)
      const executed: string[] = []
      const extraTools = privateTools(policy.name, policy.traits, deferred, executed)
      expect(f.session.agent.tools.list().some(({ tool }) => tool.name === policy.name)).toBe(false)
      const spec = {
        key: "research",
        name: "Research",
        cwd: f.home,
        systemPrompt: "Research",
        callableTools: extraTools.map((tool) => tool.name),
      }
      const runtime = { askUser: async () => undefined, extraTools }
      const first = await f.api().conversations!.openOrCreate(spec, runtime)
      expect(f.mock.requests).toHaveLength(0)
      await first.send("try private tools")
      await first.release()
      const reopened = await f.api().conversations!.open(first.id, runtime)
      expect(f.mock.requests).toHaveLength(oneTurn.length)
      await reopened.send("try again")
      expect(executed).toEqual(
        deferred
          ? ["load_private", "private_read", "load_private", "private_read"]
          : ["private_read", "private_read"],
      )
      for (const request of f.mock.requests) {
        expect(request.tools.map((tool) => tool.name)).not.toContain(policy.name)
        expect(request.systemPrompt).not.toContain(`- ${policy.name}:`)
      }
      const denied = reopened
        .history()
        .filter((message) => message.role === "toolResult" && message.toolName === policy.name)
      expect(denied).toHaveLength(2)
      expect(denied.every((message) => message.role === "toolResult" && message.isError)).toBe(true)
    })
  }
}

for (const deferred of [false, true]) {
  test(`descendant private ${deferred ? "deferred" : "active"} interactive extras remain excluded after parent reopen`, async () => {
    const name = "private_question"
    const oneTurn = steps(name, deferred)
    const f = await fixture([...oneTurn, ...oneTurn], { nonInteractive: true })
    const executed: string[] = []
    const extraTools = privateTools(name, { interactive: true }, deferred, executed)
    const spec = {
      key: "research",
      name: "Research",
      cwd: f.home,
      systemPrompt: "Research",
      callableTools: extraTools.map((tool) => tool.name),
    }
    const runtime = { askUser: async () => undefined, extraTools }
    const first = await f.api().conversations!.openOrCreate(spec, runtime)
    const child = first
      .createGroup({ name: "First research" })
      .spawn({ prompt: "try private tools", extraTools })
    expect((await child.result()).status).toBe("done")
    await first.release()
    const reopened = await f.api().conversations!.open(first.id, runtime)
    const next = reopened
      .createGroup({ name: "Reopened research" })
      .spawn({ prompt: "try again", extraTools })
    expect((await next.result()).status).toBe("done")
    expect(executed).toEqual(
      deferred
        ? ["load_private", "private_read", "load_private", "private_read"]
        : ["private_read", "private_read"],
    )
    expect(f.mock.requests).toHaveLength(oneTurn.length * 2)
    for (const request of f.mock.requests) {
      expect(request.tools.map((tool) => tool.name)).not.toContain(name)
      expect(request.systemPrompt).not.toContain(`- ${name}:`)
    }
  })
}

for (const privateInteractive of [false, true]) {
  test(`policy evaluates the selected same-name private override (${privateInteractive}) without fallback`, async () => {
    const name = "same_name"
    const executed: string[] = []
    const base = defineTool({
      name,
      description: "Global definition",
      parameters: { type: "object" },
      traits: { interactive: !privateInteractive },
      execute: async () => {
        executed.push("global")
        return textResult("global")
      },
    })
    const f = await fixture(
      [{ toolCalls: [{ name, args: {} }] }, { text: "done" }],
      { nonInteractive: true },
      [base],
    )
    const selected = defineTool({
      name,
      description: "Selected private definition",
      parameters: { type: "object" },
      traits: { interactive: privateInteractive, readOnly: true },
      execute: async () => {
        executed.push("private")
        return textResult("private")
      },
    })
    const conversation = await f
      .api()
      .conversations!.openOrCreate(
        { key: "override", name: "Override", cwd: f.home, systemPrompt: "Research", callableTools: [name] },
        { askUser: async () => undefined, extraTools: [selected] },
      )
    await conversation.send("use selected definition")
    expect(executed).toEqual(privateInteractive ? [] : ["private"])
    expect(f.mock.requests[0]!.tools.map((tool) => tool.name)).toEqual(privateInteractive ? [] : [name])
  })
}

test("host reload re-evaluates private tool traits instead of freezing a global-name mask", async () => {
  let shell: "bash" | "powershell" = "bash"
  const name = "windows_command"
  const f = await fixture([...steps(name, false), ...steps(name, false)], {
    settings: { shell },
    reloadSettings: () => ({ settings: { shell }, layers: {} }),
  })
  const executed: string[] = []
  const extraTools = privateTools(name, { shell: "powershell" }, false, executed)
  const spec = {
    key: "reload",
    name: "Reload",
    cwd: f.home,
    systemPrompt: "Research",
    callableTools: extraTools.map((tool) => tool.name),
  }
  const runtime = { askUser: async () => undefined, extraTools }
  const first = await f.api().conversations!.openOrCreate(spec, runtime)
  await first.send("before reload")
  expect(executed).toEqual(["private_read"])
  shell = "powershell"
  expect((await f.session.reload()).failed).toEqual([])
  const reopened = await f.api().conversations!.open(first.id, runtime)
  await reopened.send("after reload")
  expect(executed).toEqual(["private_read", name, "private_read"])
  expect(f.mock.requests[0]!.tools.map((tool) => tool.name)).not.toContain(name)
  expect(f.mock.requests[2]!.tools.map((tool) => tool.name)).toContain(name)
})

test("execution rechecks the captured private definition after host policy changes during interception", async () => {
  const name = "private_question"
  const f = await fixture(steps(name, false), { nonInteractive: false })
  const executed: string[] = []
  const extraTools = privateTools(name, { interactive: true }, false, executed)
  let entered = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.session.agent.interceptors.add("tool.call.before", async (call) => {
    if (call.name === name) {
      entered = true
      await gate
    }
    return { action: "pass" }
  })
  const conversation = await f.api().conversations!.openOrCreate(
    {
      key: "live-policy",
      name: "Live policy",
      cwd: f.home,
      systemPrompt: "Research",
      callableTools: extraTools.map((tool) => tool.name),
    },
    { askUser: async () => undefined, extraTools },
  )
  const sending = conversation.send("try private question")
  try {
    const deadline = Date.now() + 3000
    while (!entered) {
      if (Date.now() > deadline) throw new Error("interception did not reach its gate")
      await Bun.sleep(2)
    }
    expect(f.mock.requests[0]!.tools.map((tool) => tool.name)).toContain(name)
    f.session.agent.tools.setPolicy({ nonInteractive: true })
  } finally {
    release()
  }
  await sending
  expect(executed).toEqual(["private_read"])
  expect(f.mock.requests[1]!.tools.map((tool) => tool.name)).not.toContain(name)
  const rejected = conversation
    .history()
    .find((message) => message.role === "toolResult" && message.toolName === name)
  expect(rejected?.role === "toolResult" ? rejected.isError : false).toBe(true)
})

test("a headless frontend's noninteractive policy survives extension reload for private tools", async () => {
  const name = "private_question"
  const f = await fixture(steps(name, false), {})
  // The same preparation used by print/RPC after session creation.
  f.session.agent.setNonInteractive()
  f.session.agent.tools.setPolicy({ nonInteractive: true })
  expect((await f.session.reload()).failed).toEqual([])
  const executed: string[] = []
  const extraTools = privateTools(name, { interactive: true }, false, executed)
  const conversation = await f.api().conversations!.openOrCreate(
    {
      key: "headless",
      name: "Headless",
      cwd: f.home,
      systemPrompt: "Research",
      callableTools: extraTools.map((tool) => tool.name),
    },
    { askUser: async () => undefined, extraTools },
  )
  await conversation.send("try private question")
  expect(executed).toEqual(["private_read"])
  expect(f.mock.requests[0]!.tools.map((tool) => tool.name)).not.toContain(name)
})
