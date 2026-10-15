import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import {
  type ApprovalRequest,
  type ConversationRuntime,
  type ConversationSpec,
  defineTool,
  type PermissionMode,
  textResult,
} from "@amira/api"
import { Agent, type AgentOptions } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { ownedDirectory, readOwned, validateSpec } from "../src/owned-conversations-storage.ts"
import { type PermissionRule, Permissions } from "../src/permissions/policy.ts"
import { Child } from "../src/subagents/child.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture(steps: MockStep[] = [], options: Pick<AgentOptions, "permissions" | "callableTools"> = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "amira-owned-descendants-"))
  const worktree = path.join(home, "worktree")
  mkdirSync(worktree)
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const tools = new ToolRegistry()
  const tree = new AgentTree({ ai, sections: () => [] })
  const approvals: ApprovalRequest[] = []
  const main = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: home,
    tools,
    tree,
    sections: [],
    // These tools record policy-approved attempts without mutating files or keeping a journal.
    fileRewindSettings: { enabled: false },
    approve: async (request) => {
      approvals.push(request)
      return { approved: true, by: "user" }
    },
    ...options,
  })
  const manager = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
  const owner = manager.forOwner("coordinator")
  const spec: ConversationSpec = {
    key: "implementation",
    name: "Implementation",
    cwd: home,
    systemPrompt: "Work for the human.",
    callableTools: ["bash", "custom_shell", "question", "probe", "delegate"],
  }
  const runtime: ConversationRuntime = { askUser: async () => [{ selected: ["Human"] }] }
  const ran: { name: string; cwd: string; restricted: boolean | undefined }[] = []
  for (const name of ["bash", "custom_shell", "probe", "forbidden"]) {
    tools.register(
      defineTool({
        name,
        description: name,
        parameters: { type: "object" },
        ...(name === "bash" || name === "custom_shell"
          ? { traits: { shell: "bash" as const }, shellKind: () => "bash" as const }
          : { traits: { readOnly: true } }),
        execute: async (_args, context) => {
          ran.push({ name, cwd: context.cwd, restricted: context.session?.restricted })
          return textResult("mock check passed")
        },
      }),
      "fixture",
    )
  }
  tools.register(
    defineTool({
      name: "question",
      description: "Ask the owning human",
      traits: { readOnly: true },
      parameters: { type: "object" },
      execute: async (_args, context) =>
        textResult(
          JSON.stringify(
            await context.session!.askUser!(
              [{ question: "Who decides?", options: [{ label: "Human" }] }],
              context.signal,
            ),
          ),
        ),
    }),
    "fixture",
  )
  cleanups.push(async () => {
    await manager.drain()
    await main.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  return { home, worktree, mock, ai, tools, tree, main, manager, owner, spec, runtime, ran, approvals }
}

function childAgent(child: unknown): Agent {
  if (!(child instanceof Child)) throw new Error("expected tree child")
  return child.agent
}

async function idle(child: { state: string }) {
  const deadline = Date.now() + 3000
  while (child.state !== "idle") {
    if (Date.now() > deadline) throw new Error("child did not become idle")
    await Bun.sleep(2)
  }
}

test("descendant policy validation defaults to research and rejects unknown policies", () => {
  const f = fixture()
  expect(validateSpec(f.spec).descendants).toBe("research")
  expect(validateSpec({ ...f.spec, descendants: "research" })).toEqual(validateSpec(f.spec))
  expect(validateSpec({ ...f.spec, descendants: "inherit" }).descendants).toBe("inherit")
  for (const descendants of [null, false, "all", {}, ["inherit"]]) {
    expect(() => validateSpec(JSON.parse(JSON.stringify({ ...f.spec, descendants })))).toThrow("descendants")
  }
})

for (const descendants of [undefined, "research", "inherit"] as const) {
  test(`descendants ${descendants ?? "default"} persists through inert reopen and cannot change`, async () => {
    const f = fixture([{ text: "done" }])
    const spec = { ...f.spec, descendants }
    const first = await f.owner.openOrCreate(spec, f.runtime)
    expect(readOwned(f.home, "coordinator", first.id).spec.descendants).toBe(descendants ?? "research")
    await first.release()
    // Inherit must also survive recovery from the durable header without its metadata sidecar.
    if (descendants === "inherit")
      rmSync(path.join(ownedDirectory(f.home, "coordinator"), `${first.id}.spec.json`))
    const handle = await f.owner.open(first.id, f.runtime)
    expect(f.mock.requests).toHaveLength(0)
    const group = handle.createGroup({ name: "supplied execution group" })
    const spawn = () => group.spawn({ prompt: "check worktree", cwd: f.worktree })
    if (descendants === "inherit") {
      expect((await spawn().result()).status).toBe("done")
    } else {
      expect(spawn).toThrow("cannot change cwd")
      expect(() =>
        group.spawn({ prompt: "shell extra", extraTools: [f.tools.get("custom_shell")!] }),
      ).toThrow("shell")
      const child = group.spawn({ prompt: "same cwd research" })
      expect(childAgent(child).tools.get("bash")).toBeUndefined()
      expect((await child.result()).status).toBe("done")
    }
    await expect(
      f.owner.openOrCreate(
        { ...spec, descendants: descendants === "inherit" ? "research" : "inherit" },
        f.runtime,
      ),
    ).rejects.toThrow("spec differs")
  })
}

test("saved owners without a descendants field retain research execution restrictions", async () => {
  const f = fixture()
  const first = await f.owner.openOrCreate(f.spec, f.runtime)
  await first.release()
  const directory = ownedDirectory(f.home, "coordinator")
  const metadata = path.join(directory, `${first.id}.spec.json`)
  const saved = JSON.parse(readFileSync(metadata, "utf8"))
  delete saved.spec.descendants
  writeFileSync(metadata, JSON.stringify(saved))
  const session = path.join(directory, `${first.id}.jsonl`)
  const lines = readFileSync(session, "utf8").split("\n")
  const header = JSON.parse(lines[0]!)
  delete header.owned.spec.descendants
  lines[0] = JSON.stringify(header)
  writeFileSync(session, lines.join("\n"))
  const handle = await f.owner.openOrCreate({ ...f.spec, descendants: "research" }, f.runtime)
  expect(() =>
    handle.createGroup({ name: "old design" }).spawn({ prompt: "worktree", cwd: f.worktree }),
  ).toThrow("cannot change cwd")
  expect(f.mock.requests).toHaveLength(0)
})

test("unknown persisted descendant policies fail closed on reopen", async () => {
  const f = fixture()
  const first = await f.owner.openOrCreate({ ...f.spec, descendants: "inherit" }, f.runtime)
  await first.release()
  const file = path.join(ownedDirectory(f.home, "coordinator"), `${first.id}.spec.json`)
  const saved = JSON.parse(readFileSync(file, "utf8"))
  for (const descendants of ["all", null, false]) {
    saved.spec.descendants = descendants
    writeFileSync(file, JSON.stringify(saved))
    await expect(f.owner.open(first.id, f.runtime)).rejects.toThrow("descendants")
  }
  expect(f.mock.requests).toHaveLength(0)
})

const permissionCases: {
  mode: PermissionMode
  decision?: PermissionRule["decision"]
  runs: number
  asks: number
}[] = [
  { mode: "auto", runs: 1, asks: 0 },
  { mode: "edits", runs: 1, asks: 1 },
  { mode: "plan", runs: 0, asks: 0 },
  { mode: "auto", decision: "deny", runs: 0, asks: 0 },
  { mode: "auto", decision: "ask", runs: 1, asks: 1 },
]
for (const { mode, decision, runs, asks } of permissionCases) {
  test(`inherit shell uses host ${mode} permissions and ${decision ?? "default"} rules`, async () => {
    const permissions = new Permissions({
      mode,
      rules: decision
        ? [{ command: ["check"], decision, source: { scope: "user", file: "fixture.json" } }]
        : [],
    })
    const f = fixture(
      [
        { toolCalls: [{ name: "bash", args: { command: "check --mock" } }] },
        { text: "checked", usage: { input: 7 } },
      ],
      { permissions },
    )
    const handle = await f.owner.openOrCreate({ ...f.spec, descendants: "inherit" }, f.runtime)
    const child = handle.createGroup({ name: "implementation" }).spawn({ prompt: "check", cwd: f.worktree })
    expect(childAgent(child).permissions).toBe(permissions)
    expect((await child.result()).status).toBe("done")
    expect(f.ran).toHaveLength(runs)
    if (runs) expect(f.ran).toEqual([{ name: "bash", cwd: f.worktree, restricted: false }])
    expect(f.approvals).toHaveLength(asks)
    if (asks) expect(f.approvals[0]?.sessionId).toBe(child.id)
    expect(f.mock.requests).toHaveLength(2)
    expect(f.tree.usage.input).toBeGreaterThanOrEqual(7)
  })
}

for (const ephemeral of [false, true]) {
  test(`inherit nested ${ephemeral ? "private" : "ordinary"} child asks and approvals stay human-routed`, async () => {
    const f = fixture([
      { text: "ready" },
      {
        toolCalls: [
          { name: "question", args: {} },
          { name: "probe", args: {} },
        ],
      },
      { text: "human answered" },
    ])
    const asked: string[] = []
    const runtime: ConversationRuntime = {
      askUser: async (_questions, context) => {
        asked.push(context.sessionId)
        return [{ selected: ["Human"] }]
      },
    }
    f.main.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "Human gate" }))
    const handle = await f.owner.openOrCreate({ ...f.spec, descendants: "inherit" }, runtime)
    const parent = handle.createGroup({ name: "implementation" }).spawn({ prompt: "ready", persistent: true })
    await idle(parent)
    const agent = childAgent(parent)
    const child = agent.tree!.spawn(agent, { prompt: "ask human", ephemeral, cwd: f.worktree })
    if (ephemeral) {
      await idle(child)
      child.stop()
    }
    expect((await child.result()).text).toBe("human answered")
    expect(asked).toEqual([child.id])
    expect(f.approvals).toHaveLength(2)
    expect(f.approvals.every((request) => request.sessionId === child.id)).toBe(true)
    expect(f.mock.requests).toHaveLength(3)
  })
}

test("inherit children cannot widen callable ceilings with spawn options or shell extras", async () => {
  const f = fixture([
    {
      toolCalls: [
        { name: "custom_shell", args: {} },
        { name: "forbidden", args: {} },
        { name: "probe", args: {} },
      ],
    },
    { text: "done" },
  ])
  const handle = await f.owner.openOrCreate(
    { ...f.spec, descendants: "inherit", callableTools: ["probe"] },
    f.runtime,
  )
  const child = handle.createGroup({ name: "bounded" }).spawn({
    prompt: "cannot widen",
    cwd: f.worktree,
    callableTools: ["probe", "custom_shell", "forbidden"],
    extraTools: [f.tools.get("custom_shell")!],
  })
  expect([...childAgent(child).callableTools!]).toEqual(["probe"])
  expect((await child.result()).status).toBe("done")
  expect(f.ran.map((call) => call.name)).toEqual(["probe"])
})

for (const ephemeral of [false, true]) {
  test(`inherit nested ${ephemeral ? "private" : "ordinary"} children preserve write ceilings across cwd changes`, async () => {
    const f = fixture([
      { text: "ready" },
      {
        toolCalls: [
          { name: "write", args: { path: "outside.txt" } },
          { name: "write", args: { path: "worktree/inside.txt" } },
        ],
      },
      { text: "bounded" },
    ])
    const writes: string[] = []
    f.tools.register(
      defineTool<{ path: string }>({
        name: "write",
        description: "Mock file mutation",
        parameters: { type: "object" },
        traits: { writesFiles: "paths" },
        getWrittenPaths: (args) => [args.path],
        execute: async (args) => {
          writes.push(args.path)
          return textResult("mock write")
        },
      }),
      "fixture",
    )
    const handle = await f.owner.openOrCreate(
      {
        ...f.spec,
        cwd: f.worktree,
        descendants: "inherit",
        callableTools: ["write"],
        writeRoots: [f.worktree],
      },
      f.runtime,
    )
    const parent = handle.createGroup({ name: "bounded" }).spawn({ prompt: "ready", persistent: true })
    await idle(parent)
    const agent = childAgent(parent)
    const child = agent.tree!.spawn(agent, {
      prompt: "cannot widen",
      cwd: f.home,
      ephemeral,
      writeRoots: [f.home],
    })
    expect(childAgent(child).writeRoots).toEqual(agent.writeRoots)
    if (ephemeral) {
      await idle(child)
      child.stop()
    }
    expect((await child.result()).status).toBe("done")
    expect(writes).toEqual(["worktree/inside.txt"])
  })
}

test("releasing an inherit owner cancels descendant human waits without stopping main children", async () => {
  const f = fixture([{ toolCalls: [{ name: "question", args: {} }] }, { text: "main stays independent" }])
  let ready!: () => void
  const asked = new Promise<void>((resolve) => {
    ready = resolve
  })
  let questionSignal: AbortSignal | undefined
  const handle = await f.owner.openOrCreate(
    { ...f.spec, descendants: "inherit" },
    {
      askUser: async (_questions, context) => {
        questionSignal = context.signal
        ready()
        return new Promise(() => {})
      },
    },
  )
  const group = handle.createGroup({ name: "implementation" })
  const child = group.spawn({ prompt: "ask human" })
  await asked
  const mainChild = f.tree.spawn(f.main, { prompt: "main", persistent: true })
  await idle(mainChild)
  await f.manager.releaseOwner("coordinator")
  expect(questionSignal?.aborted).toBe(true)
  expect((await child.result()).status).toBe("aborted")
  expect(mainChild.state).toBe("idle")
  expect(() => group.spawn({ prompt: "stale" })).toThrow("released")
  expect(f.mock.requests).toHaveLength(2)
})

test("a delegator sees normal inherited execution and can spawn one check without retargeting main", async () => {
  const f = fixture([
    { toolCalls: [{ name: "delegate", args: {} }] },
    { toolCalls: [{ name: "bash", args: { command: "check --mock" } }] },
    { text: "child checked" },
    { text: "owner done" },
  ])
  const restricted: (boolean | undefined)[] = []
  f.tools.register(
    defineTool({
      name: "delegate",
      description: "Delegate one check",
      parameters: { type: "object" },
      execute: async (_args, context) => {
        restricted.push(context.session?.restricted)
        const child = context.session!.spawn!({ prompt: "check", cwd: f.worktree })
        return textResult((await child.result()).text ?? "")
      },
    }),
    "fixture",
  )
  const handle = await f.owner.openOrCreate({ ...f.spec, descendants: "inherit" }, f.runtime)
  await f.main.dispose("switch")
  await handle.send("delegate")
  expect(restricted).toEqual([false])
  expect(f.ran).toEqual([{ name: "bash", cwd: f.worktree, restricted: false }])
  expect(f.main.messages).toEqual([])
  expect(f.mock.requests).toHaveLength(4)
  await f.manager.releaseOwner("coordinator")
  expect(() => handle.createGroup({ name: "stale" })).toThrow("released")
})
