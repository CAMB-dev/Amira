import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type MockStep, type ModelRequest } from "@amira/ai"
import { type AnyEvent, type ApprovalRequest, defineTool, type ShellKind, textResult } from "@amira/api"
import { Agent, type ApprovalDecision, type Approver } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
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
  opts: { permissions?: Permissions; approve?: Approver; cwd?: string } = {},
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
    tools: fakeTools(ran),
    ...(opts.permissions ? { permissions: opts.permissions } : {}),
    ...(opts.approve ? { approve: opts.approve } : {}),
  })
  return { agent, bus, events, ran, interceptors }
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

/** A tree whose root's model answers approval questions APPROVE; children run `command`. */
function treeSetup(permissions: Permissions, command: string) {
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
    return { toolCalls: [{ name: "bash", args: { command } }] }
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
    tools: fakeTools(ran),
    permissions,
  })
  return { tree, root, ran, parentAsked, interceptors }
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
