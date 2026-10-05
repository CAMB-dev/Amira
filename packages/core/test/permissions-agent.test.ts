import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type MockStep, type ModelRequest } from "@amira/ai"
import {
  type AnyEvent,
  type ApprovalRequest,
  defineTool,
  type ExtensionAPI,
  type ShellKind,
  textResult,
} from "@amira/api"
import { Agent, type ApprovalDecision, type Approver } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { amiraHome } from "../src/home.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { type PermissionRule, Permissions } from "../src/permissions/policy.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

/** Tools named like the built-ins, which record what they were asked to do instead of doing it. */
function fakeTools(ran: string[]) {
  const tools = new ToolRegistry()
  tools.register(
    defineTool<{ command: string }>({
      name: "bash",
      description: "",
      parameters: { type: "object" },
      concurrency: "parallel",
      traits: { shell: "bash" },
      shellKind: (): ShellKind => "bash",
      execute: async ({ command }) => {
        ran.push(`bash: ${command}`)
        return textResult(`ran ${command}`)
      },
    }),
    "test",
  )
  for (const name of ["write", "mcp__srv__do"]) {
    tools.register(
      defineTool<{ path?: string }>({
        name,
        description: "",
        parameters: { type: "object" },
        ...(name === "write"
          ? {
              traits: { writesFiles: "paths" as const },
              getWrittenPaths: (p: { path?: string }) => (typeof p.path === "string" ? [p.path] : []),
            }
          : {}),
        execute: async (p) => {
          ran.push(`${name}: ${p.path ?? ""}`)
          return textResult("done")
        },
      }),
      "test",
    )
  }
  return tools
}

function setup(
  steps: MockStep[],
  opts: {
    permissions?: Permissions
    approve?: Approver
    cwd?: string
    tools?: ToolRegistry
  } = {},
) {
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "", defaultModel: { contextWindow: 128_000 } }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const ran: string[] = []
  const interceptors = new InterceptorRegistry()
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: opts.cwd ?? mkdtempSync(path.join(os.tmpdir(), "amira-perm-agent-")),
    systemPrompt: "sys",
    bus,
    interceptors,
    tools: opts.tools ?? fakeTools(ran),
    ...(opts.permissions ? { permissions: opts.permissions } : {}),
    ...(opts.approve ? { approve: opts.approve } : {}),
  })
  return { agent, bus, events, ran, interceptors }
}

function extensionSetup(steps: MockStep[], opts: Parameters<typeof setup>[1] = {}) {
  const tools = new ToolRegistry()
  const session = setup(steps, { ...opts, tools })
  const host = new ExtensionHost({
    bus: session.bus,
    interceptors: session.interceptors,
    tools,
    cwd: session.agent.cwd,
  })
  return { ...session, host }
}

function extensionWriter(ran: string[], opts: { override?: boolean; shell?: boolean } = {}) {
  return defineTool<{ path: string; command?: string }>({
    name: "extension_write",
    description: "",
    parameters: { type: "object" },
    ...(opts.override ? { override: true } : {}),
    traits: { writesFiles: "paths", ...(opts.shell ? { shell: "bash" as const } : {}) },
    getWrittenPaths: (p) => [p.path],
    execute: async (p) => {
      ran.push(`extension_write: ${p.path}`)
      return textResult("done")
    },
  })
}

async function loadWriter(
  host: ExtensionHost,
  source: string,
  ran: string[],
  opts: { override?: boolean; shell?: boolean } = {},
) {
  let api!: ExtensionAPI
  expect(
    await host.load((a) => {
      api = a
      expect(statSync(api.dataDir).isDirectory()).toBe(true)
      api.registerTool(extensionWriter(ran, opts))
    }, source),
  ).toBe(true)
  return api
}

const rule = (command: string[], decision: PermissionRule["decision"]): PermissionRule => ({
  command,
  decision,
  source: { scope: "user", file: "settings.json" },
})

const resultText = (agent: Agent, i = 0) => {
  const r = agent.messages.filter((m) => m.role === "toolResult")[i]
  return r?.content[0]?.type === "text" ? r.content[0].text : ""
}

test("the policy decides on the arguments interceptors rewrote, not the ones the model sent", async () => {
  const permissions = new Permissions({ rules: [rule(["git", "push"], "deny")] })
  const { agent, ran, interceptors } = setup(
    [
      {
        toolCalls: [
          { name: "bash", args: { command: "git status" }, id: "c1" },
          { name: "bash", args: { command: "git push --force" }, id: "c2" },
        ],
      },
      { text: "ok" },
    ],
    { permissions },
  )
  // One interceptor turns a harmless command into a denied one, another the reverse.
  interceptors.add("tool.call.before", (v) =>
    v.args.command === "git status"
      ? { action: "modify", value: { ...v, args: { command: "git push origin" } } }
      : { action: "modify", value: { ...v, args: { command: "git log" } } },
  )
  await agent.prompt("go")
  expect(ran).toEqual(["bash: git log"])
  expect(resultText(agent, 0)).toContain("Tool call blocked by the permission policy")
  expect(resultText(agent, 0)).toContain('rule ["git","push"]')
  expect(resultText(agent, 0)).toContain("ask the user")
})

test("a large output is saved as an artifact once a permitted call ran; a refused call saves none", async () => {
  const permissions = new Permissions({ rules: [rule(["rm"], "deny")] })
  const long = "x".repeat(20_000)
  const { agent, ran, interceptors } = setup(
    [
      {
        toolCalls: [
          { name: "bash", args: { command: `echo ${long}` }, id: "c1" },
          { name: "bash", args: { command: `echo ${long}y` }, id: "c2" },
        ],
      },
      { text: "ok" },
    ],
    { permissions },
  )
  // The second call becomes a denied command: the policy sees it as the tool would run it.
  interceptors.add("tool.call.before", (v) =>
    v.args.command === `echo ${long}y`
      ? { action: "modify", value: { ...v, args: { command: `rm -rf ${long}` } } }
      : { action: "pass" },
  )
  await agent.prompt("go")
  expect(ran).toEqual([`bash: echo ${long}`])
  const saved = agent.artifacts.list()
  expect(saved.map((a) => a.toolCallId)).toEqual(["c1"])
  expect(resultText(agent, 0)).toContain(saved[0]!.id)
  expect(resultText(agent, 1)).toContain("Tool call blocked by the permission policy")
})

test("an interceptor that asks and an approver that says yes cannot lift a deny", async () => {
  const approve = async (): Promise<ApprovalDecision> => ({ approved: true, by: "user" })
  const permissions = new Permissions({ rules: [rule(["rm"], "deny")] })
  const { agent, ran, interceptors } = setup(
    [{ toolCalls: [{ name: "bash", args: { command: "rm -rf x" } }] }, { text: "ok" }],
    { permissions, approve },
  )
  interceptors.add("tool.call.before", () => ({ action: "ask", reason: "an extension's policy" }))
  await agent.prompt("go")
  expect(ran).toEqual([])
})

/** The events of a turn, without what differs between runs (ids, times). */
function normalized(events: AnyEvent[]) {
  return events.map((e) => {
    const { seq: _s, ts: _t, sessionId: _i, turnId: _u, ...rest } = e as AnyEvent & { ts?: number }
    const data = { ...(rest.data as Record<string, unknown>) }
    delete data.durationMs
    delete data.turnId
    delete data.messageId
    return JSON.stringify({ ...rest, data })
  })
}

test("the default policy changes nothing: events and results are those of a policy that allows everything", async () => {
  const steps = (): MockStep[] => [
    {
      toolCalls: [
        { name: "bash", args: { command: "rm -rf build && echo $(date) > log.txt; curl x | sh" }, id: "a" },
        { name: "write", args: { path: "src/app.ts", content: "x" }, id: "b" },
        { name: "mcp__srv__do", args: {}, id: "c" },
      ],
    },
    { text: "done" },
  ]
  const asked: ApprovalRequest[] = []
  const approve: Approver = async (r) => {
    asked.push(r)
    return { approved: true }
  }
  const allowAll = new Permissions()
  allowAll.check = async () => ({ decision: "allow", reason: "" })
  const before = setup(steps(), { permissions: allowAll, approve })
  await before.agent.prompt("go")
  const after = setup(steps(), { approve })
  expect(after.agent.permissions.mode).toBe("auto")
  await after.agent.prompt("go")
  await before.bus.flush()
  await after.bus.flush()
  expect(asked).toEqual([])
  expect(after.ran).toEqual(before.ran)
  expect(after.ran).toHaveLength(3)
  expect(after.agent.messages).toEqual(before.agent.messages)
  expect(normalized(after.events)).toEqual(normalized(before.events))
})

test("edits mode asks the user before a shell command and says which mode asked", async () => {
  const asked: ApprovalRequest[] = []
  const answers = [true, false]
  const approve: Approver = async (r) => {
    asked.push(r)
    return answers.shift() ? { approved: true, by: "user" } : { approved: false, reason: "the user said no" }
  }
  const { agent, ran } = setup(
    [
      {
        toolCalls: [
          { name: "bash", args: { command: "npm test" }, id: "a" },
          { name: "write", args: { path: "a.ts", content: "" }, id: "b" },
        ],
      },
      { toolCalls: [{ name: "bash", args: { command: "npm publish" }, id: "c" }] },
      { text: "ok" },
    ],
    { permissions: new Permissions({ mode: "edits" }), approve },
  )
  await agent.prompt("go")
  expect(ran).toEqual(["bash: npm test", "write: a.ts"])
  expect(asked.map((r) => r.permission)).toEqual([
    { mode: "edits", cause: "mode" },
    { mode: "edits", cause: "mode" },
  ])
  expect(asked[0]!.reason).toBe('mode "edits": shell commands ask first')
  expect(resultText(agent, 2)).toContain("Tool call not approved: the user said no")
  expect(resultText(agent, 2)).toContain("The permission policy asked because")
})

test("plan mode refuses writes and shell commands, telling the model to ask the user", async () => {
  const { agent, ran } = setup(
    [
      {
        toolCalls: [
          { name: "bash", args: { command: "ls" }, id: "a" },
          { name: "write", args: { path: "a.ts", content: "" }, id: "b" },
        ],
      },
      { text: "ok" },
    ],
    { permissions: new Permissions({ mode: "plan" }) },
  )
  await agent.prompt("go")
  expect(ran).toEqual([])
  expect(resultText(agent, 0)).toContain('mode "plan" is read-only')
  expect(resultText(agent, 1)).toContain("ask the user")
})

test("headless: what would ask is refused with the reason, unless the mode is auto", async () => {
  const headless: Approver = async () => ({ approved: false, reason: "nobody can approve it (print mode)" })
  const edits = setup([{ toolCalls: [{ name: "bash", args: { command: "ls" } }] }, { text: "ok" }], {
    permissions: new Permissions({ mode: "edits", approver: headless }),
  })
  await edits.agent.prompt("go")
  expect(edits.ran).toEqual([])
  expect(resultText(edits.agent)).toContain("Tool call not approved: nobody can approve it (print mode)")
  const auto = setup([{ toolCalls: [{ name: "bash", args: { command: "ls" } }] }, { text: "ok" }], {
    permissions: new Permissions({ approver: headless }),
  })
  await auto.agent.prompt("go")
  expect(auto.ran).toEqual(["bash: ls"])
})

test("auto mode still asks before a protected file changes", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-perm-agent-"))
  mkdirSync(path.join(cwd, ".git"))
  const asked: ApprovalRequest[] = []
  const approve: Approver = async (r) => {
    asked.push(r)
    return { approved: false, reason: "the user said no" }
  }
  const { agent, ran } = setup(
    [
      { toolCalls: [{ name: "write", args: { path: ".git/hooks/pre-commit", content: "x" } }] },
      { text: "ok" },
    ],
    { cwd, approve },
  )
  await agent.prompt("go")
  expect(ran).toEqual([])
  expect(asked[0]!.permission).toEqual({ mode: "auto", cause: "protected" })
  expect(asked[0]!.reason).toContain("Git hooks")
})

for (const mode of ["default", "auto"] as const) {
  test(`an extension's own data directory writes run without an approver (${mode})`, async () => {
    const call = { name: "extension_write", args: { path: "" } }
    const { agent, host, ran } = extensionSetup(
      [{ toolCalls: [call] }, { text: "ok" }],
      mode === "auto" ? { permissions: new Permissions({ mode }) } : {},
    )
    const api = await loadWriter(host, path.join(agent.cwd, "writer.ts"), ran)
    call.args.path = path.join(api.dataDir, "state.json")
    await agent.prompt("go")
    expect(ran).toEqual([`extension_write: ${call.args.path}`])
    expect(resultText(agent)).toBe("done")
  })
}

test("an extension's own data writes are still denied in plan mode", async () => {
  const call = { name: "extension_write", args: { path: "" } }
  const { agent, host, ran } = extensionSetup([{ toolCalls: [call] }, { text: "ok" }], {
    permissions: new Permissions({ mode: "plan" }),
  })
  const api = await loadWriter(host, path.join(agent.cwd, "writer.ts"), ran)
  call.args.path = path.join(api.dataDir, "state.json")
  await agent.prompt("go")
  expect(ran).toEqual([])
  expect(resultText(agent)).toContain('mode "plan" is read-only')
})

test("rewriting an extension's own write to user settings still asks about the final path", async () => {
  const asked: ApprovalRequest[] = []
  const approve: Approver = async (r) => {
    asked.push(r)
    return { approved: false, reason: "the user said no" }
  }
  const call = { name: "extension_write", args: { path: "" } }
  const { agent, host, ran, interceptors } = extensionSetup([{ toolCalls: [call] }, { text: "ok" }], {
    approve,
  })
  const api = await loadWriter(host, path.join(agent.cwd, "writer.ts"), ran)
  call.args.path = path.join(api.dataDir, "state.json")
  const settings = path.join(amiraHome(), "settings.json")
  interceptors.add("tool.call.before", (v) => ({
    action: "modify",
    value: { ...v, args: { path: settings } },
  }))
  await agent.prompt("go")
  expect(ran).toEqual([])
  expect(asked).toHaveLength(1)
  expect(asked[0]!.args).toEqual({ path: settings })
  expect(asked[0]!.permission).toEqual({ mode: "auto", cause: "protected" })
  expect(resultText(agent)).toContain("Tool call not approved: the user said no")
})

test("an independent interceptor's question survives an extension's own data write allowance", async () => {
  const asked: ApprovalRequest[] = []
  const approve: Approver = async (r) => {
    asked.push(r)
    return { approved: false, reason: "the user said no" }
  }
  const call = { name: "extension_write", args: { path: "" } }
  const { agent, host, ran, interceptors } = extensionSetup([{ toolCalls: [call] }, { text: "ok" }], {
    approve,
  })
  const api = await loadWriter(host, path.join(agent.cwd, "writer.ts"), ran)
  call.args.path = path.join(api.dataDir, "state.json")
  interceptors.add("tool.call.before", () => ({ action: "ask", reason: "extension policy" }))
  await agent.prompt("go")
  expect(ran).toEqual([])
  expect(asked).toHaveLength(1)
  expect(asked[0]!.reason).toBe("extension policy")
  expect(asked[0]!.permission).toBeUndefined()
})

test("a tool that writes its extension's data and runs a shell command still asks in edits mode", async () => {
  const asked: ApprovalRequest[] = []
  const approve: Approver = async (r) => {
    asked.push(r)
    return { approved: false, reason: "the user said no" }
  }
  const call = { name: "extension_write", args: { path: "", command: "npm test" } }
  const { agent, host, ran } = extensionSetup([{ toolCalls: [call] }, { text: "ok" }], {
    permissions: new Permissions({ mode: "edits" }),
    approve,
  })
  const api = await loadWriter(host, path.join(agent.cwd, "writer.ts"), ran, { shell: true })
  call.args.path = path.join(api.dataDir, "state.json")
  await agent.prompt("go")
  expect(ran).toEqual([])
  expect(asked).toHaveLength(1)
  expect(asked[0]!.reason).toBe('mode "edits": shell commands ask first')
  expect(asked[0]!.permission).toEqual({ mode: "edits", cause: "mode" })
})

test("unloading an extension during an awaited interceptor retains the selected tool's data allowance", async () => {
  const call = { name: "extension_write", args: { path: "" } }
  const { agent, host, ran, interceptors } = extensionSetup([{ toolCalls: [call] }, { text: "ok" }])
  const source = path.join(agent.cwd, "writer.ts")
  const api = await loadWriter(host, source, ran)
  call.args.path = path.join(api.dataDir, "state.json")
  interceptors.add("tool.call.before", async () => {
    await Promise.resolve()
    expect(host.unload(source)).toBe(true)
    return { action: "pass" }
  })
  await agent.prompt("go")
  expect(ran).toEqual([`extension_write: ${call.args.path}`])
  expect(resultText(agent)).toBe("done")
})

for (const replacement of ["override", "unload"] as const) {
  test(`an awaited interceptor cannot substitute a replacement's ownership (${replacement})`, async () => {
    const asked: ApprovalRequest[] = []
    const approve: Approver = async (r) => {
      asked.push(r)
      return { approved: true, by: "user" }
    }
    const args = { path: "" }
    const { agent, host, ran, interceptors } = extensionSetup(
      [
        { toolCalls: [{ name: "extension_write", args, id: "old" }] },
        { toolCalls: [{ name: "extension_write", args, id: "new" }] },
        { text: "ok" },
      ],
      { approve },
    )
    const oldSource = path.join(agent.cwd, "old.ts")
    const oldApi = await loadWriter(host, oldSource, ran)
    let newApi!: ExtensionAPI
    expect(
      await host.load(
        (a) => {
          newApi = a
        },
        path.join(agent.cwd, "new.ts"),
      ),
    ).toBe(true)
    expect(newApi.dataDir).not.toBe(oldApi.dataDir)
    // The selected old tool targets the new owner's directory, never its own.
    args.path = path.join(newApi.dataDir, "state.json")
    const replacementRan: string[] = []
    interceptors.add("tool.call.before", async (v) => {
      if (v.toolCallId !== "old") return { action: "pass" }
      await Promise.resolve()
      if (replacement === "unload") expect(host.unload(oldSource)).toBe(true)
      newApi.registerTool(extensionWriter(replacementRan, { override: true }))
      return { action: "pass" }
    })
    await agent.prompt("go")
    expect(asked).toHaveLength(1)
    expect(asked[0]!.toolCallId).toBe("old")
    expect(asked[0]!.args).toEqual({ path: args.path })
    expect(asked[0]!.permission).toEqual({ mode: "auto", cause: "protected" })
    // Approval runs the captured old tool; the following call uses the new owner's allowance.
    expect(ran).toEqual([`extension_write: ${args.path}`])
    expect(replacementRan).toEqual([`extension_write: ${args.path}`])
    expect(resultText(agent, 0)).toBe("done")
    expect(resultText(agent, 1)).toBe("done")
  })
}

/** A tree whose root's model answers approval questions APPROVE; children run `command` or `call`. */
function treeSetup(
  permissions: Permissions,
  command: string,
  opts: { tools?: ToolRegistry; call?: { name: string; args: Record<string, unknown> } } = {},
) {
  const mock = createMockDialect()
  const parentAsked: string[] = []
  const reply = (req: ModelRequest): MockReply => {
    const last = req.messages.at(-1)
    const text = last?.content[0]?.type === "text" ? last.content[0].text : ""
    if (text.includes("needs your approval")) {
      parentAsked.push(text)
      return { text: "APPROVE\nsure" }
    }
    if (last?.role === "toolResult") return { text: "finished" }
    return { toolCalls: [opts.call ?? { name: "bash", args: { command } }] }
  }
  for (let i = 0; i < 50; i++) mock.push(reply)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const ran: string[] = []
  const tree = new AgentTree({ ai, sections: () => [{ name: "identity", text: "child" }] })
  const interceptors = new InterceptorRegistry()
  const root = new Agent({
    ai,
    model: ai.model("mock/big"),
    cwd: mkdtempSync(path.join(os.tmpdir(), "amira-perm-tree-")),
    systemPrompt: "commander",
    tree,
    interceptors,
    tools: opts.tools ?? fakeTools(ran),
    permissions,
  })
  return { tree, root, ran, parentAsked, interceptors }
}

test("nested registry views retain an extension's data allowance in a child with a different cwd", async () => {
  const tools = new ToolRegistry()
  const call = { name: "extension_write", args: { path: "" } }
  const { tree, root, parentAsked, interceptors } = treeSetup(new Permissions(), "", {
    tools: ToolRegistry.view(tools, (name) => name === call.name),
    call,
  })
  const host = new ExtensionHost({ bus: root.bus, interceptors, tools, cwd: root.cwd })
  const ran: string[] = []
  const api = await loadWriter(host, path.join(root.cwd, "writer.ts"), ran)
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-perm-child-"))
  expect(cwd).not.toBe(root.cwd)
  call.args.path = path.relative(cwd, path.join(api.dataDir, "state.json"))
  // AgentTree adds another live registry view and resolves the path against the child's cwd.
  const child = tree.spawn(root, { prompt: "save state", cwd, tools: [call.name] })
  await child.result()
  expect(ran).toEqual([`extension_write: ${call.args.path}`])
  expect(parentAsked).toEqual([])
})

for (const scenario of ["plan", "other-owner"] as const) {
  test(`a child's extension data exemption cannot bypass ${scenario}`, async () => {
    const asked: ApprovalRequest[] = []
    const permissions = new Permissions({
      mode: scenario === "plan" ? "plan" : "auto",
      approver: async (request) => {
        asked.push(request)
        return { approved: false }
      },
    })
    const tools = new ToolRegistry()
    const call = { name: "extension_write", args: { path: "" } }
    const { tree, root, interceptors } = treeSetup(permissions, "", { tools, call })
    const host = new ExtensionHost({ bus: root.bus, interceptors, tools })
    const ran: string[] = []
    const api = await loadWriter(host, path.join(root.cwd, "writer.ts"), ran)
    let other!: ExtensionAPI
    expect(
      await host.load(
        (a) => {
          other = a
        },
        path.join(root.cwd, "other.ts"),
      ),
    ).toBe(true)
    call.args.path = path.join(scenario === "plan" ? api.dataDir : other.dataDir, "state.json")
    const child = tree.spawn(root, { prompt: "save state", tools: [call.name] })
    await child.result()
    expect(ran).toEqual([])
    expect(asked).toHaveLength(scenario === "plan" ? 0 : 1)
    if (scenario === "other-owner") expect(asked[0]!.sessionId).toBe(child.id)
  })
}

test("a sub-agent's permission question goes to the user, never to the parent's model", async () => {
  const userAsked: ApprovalRequest[] = []
  const user: Approver = async (r) => {
    userAsked.push(r)
    return { approved: false, reason: "the user said no" }
  }
  const { tree, root, ran, parentAsked } = treeSetup(
    new Permissions({ mode: "edits", approver: user }),
    "npm i",
  )
  const child = tree.spawn(root, { prompt: "install" })
  await child.result()
  expect(ran).toEqual([])
  expect(parentAsked).toEqual([])
  expect(userAsked).toHaveLength(1)
  expect(userAsked[0]!.sessionId).toBe(child.id)
  expect(userAsked[0]!.permission?.mode).toBe("edits")
})

test("a sub-agent inherits the mode, the rules and the user's grants; the parent model cannot widen them", async () => {
  // A user approver that remembers "don't ask again" (tool and reason), as the CLI's does.
  const allowed = new Set<string>()
  let asks = 0
  const user: Approver = async (r) => {
    const key = JSON.stringify([r.name, r.reason])
    if (allowed.has(key)) return { approved: true, by: "rule" }
    asks++
    allowed.add(key)
    return { approved: true, by: "user" }
  }
  const permissions = new Permissions({
    mode: "edits",
    approver: user,
    rules: [rule(["git", "push"], "deny")],
  })
  const one = treeSetup(permissions, "npm test")
  await one.root.permissionApprover!(
    {
      sessionId: one.root.sessionId,
      toolCallId: "x",
      name: "bash",
      args: {},
      reason: 'mode "edits": shell commands ask first',
    },
    new AbortController().signal,
  )
  expect(asks).toBe(1)
  // Granted at the top: the child's call goes through without asking anyone again.
  await one.tree.spawn(one.root, { prompt: "test" }).result()
  expect(one.ran).toEqual(["bash: npm test"])
  expect(asks).toBe(1)
  expect(one.parentAsked).toEqual([])
  // The rules come along: the parent's model approves everything, and the push is still denied.
  const two = treeSetup(permissions, "git push")
  two.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "extension" }))
  await two.tree.spawn(two.root, { prompt: "push" }).result()
  expect(two.ran).toEqual([])
  // Plan mode at the top is plan mode below.
  const three = treeSetup(new Permissions({ mode: "plan", approver: user }), "ls")
  await three.tree.spawn(three.root, { prompt: "look" }).result()
  expect(three.ran).toEqual([])
})

test("an interceptor's question from a sub-agent still goes to the parent's model", async () => {
  const user: Approver = async () => ({ approved: false, reason: "no" })
  const { tree, root, ran, parentAsked, interceptors } = treeSetup(new Permissions({ approver: user }), "ls")
  interceptors.add("tool.call.before", () => ({ action: "ask", reason: "extension policy" }))
  await tree.spawn(root, { prompt: "look" }).result()
  expect(parentAsked).toHaveLength(1)
  expect(ran).toEqual(["bash: ls"])
})
