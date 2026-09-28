import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import { type AnyEvent, defineTool, type Settings, textResult } from "@amira/api"
import { Agent, AgentTree, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { runCommand } from "@amira/proc"
import { createAgentExtension, hostGit } from "../src/index.ts"

setDefaultTimeout(60_000)

const git = hostGit({ runCommand })
const dirs: string[] = []
async function tempDir(prefix: string) {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(d)
  return d
}
const savedHome = process.env.AMIRA_HOME
afterAll(async () => {
  if (savedHome === undefined) delete process.env.AMIRA_HOME
  else process.env.AMIRA_HOME = savedHome
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

/** Who is asking: the commander, or a child by the role instructions in its system prompt. */
function who(req: ModelRequest): string {
  const m = /You are an? (explorer|coder|reviewer)\b/.exec(req.systemPrompt)
  return m ? m[1]! : req.systemPrompt.includes("commander") ? "commander" : "agent"
}

const lastText = (req: ModelRequest) => {
  const last = req.messages.at(-1)
  return last?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? ""
}

async function setup(
  reply: (req: ModelRequest) => MockReply,
  opts: { cwd?: string; settings?: Settings; budget?: { tokens: number } } = {},
) {
  const home = await tempDir("amira-agent-home-")
  process.env.AMIRA_HOME = home
  const cwd = opts.cwd ?? (await tempDir("amira-agent-cwd-"))
  const mock = createMockDialect()
  for (let i = 0; i < 100; i++) mock.push(reply)
  const ai = createAi({
    dialects: [mock],
    providers: [
      { id: "mock", dialect: "mock", baseUrl: "" },
      { id: "cheap", dialect: "mock", baseUrl: "" },
    ],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const interceptors = new InterceptorRegistry()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors, tools, cwd, settings: opts.settings ?? {} })
  expect(await host.load(createAgentExtension({ git }), "builtin:agent")).toBe(true)
  tools.register(
    defineTool({
      name: "read",
      description: "read",
      parameters: { type: "object" },
      concurrency: "parallel",
      execute: async () => textResult("contents"),
    }),
    "test",
  )
  tools.register(
    defineTool<{ path: string; content: string }>({
      name: "write",
      description: "write",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
      execute: async (p, ctx) => {
        writeFileSync(path.resolve(ctx.cwd, p.path), p.content)
        return textResult("written")
      },
    }),
    "test",
  )
  const tree = new AgentTree({
    ai,
    sections: () => [{ name: "identity", text: "child" }],
    ...(opts.budget ? { budget: opts.budget } : {}),
  })
  const root = new Agent({
    ai,
    model: ai.model("mock/big"),
    cwd,
    systemPrompt: "commander",
    bus,
    interceptors,
    tools,
    tree,
  })
  return { root, mock, bus, events, cwd, home, tools }
}

/** The text of the commander's agent tool result. */
function agentResult(root: Agent, tool = "agent"): string {
  const r = root.messages.find((m) => m.role === "toolResult" && m.toolName === tool)
  return r?.role === "toolResult" ? r.content.map((b) => (b.type === "text" ? b.text : "")).join("") : ""
}

test("the commander runs an explorer and a coder in parallel and gets both answers with changes", async () => {
  const { root, mock, bus, events } = await setup((req) => {
    const role = who(req)
    const last = req.messages.at(-1)
    if (role === "commander") {
      return last?.role === "toolResult"
        ? { text: "all done" }
        : {
            toolCalls: [
              {
                name: "agent",
                args: {
                  tasks: [
                    { role: "explorer", prompt: "find the config" },
                    { role: "coder", prompt: "create y.txt" },
                  ],
                },
              },
            ],
          }
    }
    if (role === "explorer") return { text: "The config is in a.ts:3", usage: { input: 1000, output: 200 } }
    if (role === "coder") {
      return last?.role === "toolResult"
        ? { text: "Created y.txt." }
        : { toolCalls: [{ name: "write", args: { path: "y.txt", content: "y" } }] }
    }
    return { text: "?" }
  })
  const r = await root.prompt("go")
  await bus.flush()
  expect(r.reason).toBe("done")
  const text = agentResult(root)
  expect(text).toContain("## explorer · s_")
  expect(text).toContain("done (")
  expect(text).toContain("1.2k tokens")
  expect(text).toContain("The config is in a.ts:3")
  expect(text).toContain("Changes: none.")
  expect(text).toContain("## coder")
  expect(text).toContain("Created y.txt.")
  expect(text).toContain("Changes: changed y.txt.")

  // The explorer only gets the read-only tools that exist; the coder gets everything.
  const explorerReq = mock.requests.find((q) => who(q) === "explorer")!
  expect(explorerReq.tools?.map((t) => t.name)).toEqual(["read"])
  const coderReq = mock.requests.find((q) => who(q) === "coder")!
  expect(coderReq.tools?.map((t) => t.name).sort()).toEqual(["agent", "agent_result", "read", "write"])
  expect(coderReq.systemPrompt).toContain("# Sub-agent")
  const starts = events.filter((e) => e.type === "subagent.start")
  expect(starts.map((e) => e.type === "subagent.start" && e.data.role)).toEqual(["explorer", "coder"])
})

test("a child at the deepest level does not get the agent tools", async () => {
  const { root, mock } = await setup((req) => {
    const role = who(req)
    const last = req.messages.at(-1)
    if (last?.role === "toolResult") return { text: `${role} done` }
    if (role === "commander")
      return { toolCalls: [{ name: "agent", args: { tasks: [{ role: "coder", prompt: "one" }] } }] }
    if (role === "coder" && !lastText(req).includes("two")) {
      return { toolCalls: [{ name: "agent", args: { tasks: [{ role: "coder", prompt: "two" }] } }] }
    }
    return { text: "leaf" }
  })
  await root.prompt("go")
  const grandchild = mock.requests.find((q) => lastText(q) === "two")!
  expect(grandchild.tools?.map((t) => t.name).sort()).toEqual(["read", "write"])
  expect(agentResult(root)).toContain("coder done")
})

test("unknown roles are refused before anything starts", async () => {
  const { root, events, bus } = await setup((req) =>
    req.messages.at(-1)?.role === "toolResult"
      ? { text: "ok" }
      : { toolCalls: [{ name: "agent", args: { tasks: [{ role: "wizard", prompt: "x" }] } }] },
  )
  await root.prompt("go")
  await bus.flush()
  expect(agentResult(root)).toContain("Unknown role: wizard. Known roles: explorer, coder, reviewer")
  expect(events.some((e) => e.type === "subagent.start")).toBe(false)
})

test("settings agents.<role>.model picks the child's model", async () => {
  const { root, mock } = await setup(
    (req) =>
      who(req) === "commander" && req.messages.at(-1)?.role !== "toolResult"
        ? { toolCalls: [{ name: "agent", args: { tasks: [{ role: "explorer", prompt: "look" }] } }] }
        : { text: "ok" },
    { settings: { agents: { explorer: { model: "cheap/small" } } } },
  )
  await root.prompt("go")
  const req = mock.requests.find((q) => who(q) === "explorer")!
  expect(`${req.model.provider}/${req.model.id}`).toBe("cheap/small")
  const commander = mock.requests.find((q) => who(q) === "commander")!
  expect(commander.model.id).toBe("big")
})

test("project role files are offered and used", async () => {
  const cwd = await tempDir("amira-agent-proj-")
  mkdirSync(path.join(cwd, ".amira", "agents"), { recursive: true })
  writeFileSync(
    path.join(cwd, ".amira", "agents", "scribe.md"),
    "---\ndescription: Writes notes\ntools: [read]\n---\nYou are a scribe of notes.",
  )
  const { root, mock } = await setup(
    (req) =>
      req.systemPrompt.includes("scribe of notes")
        ? { text: "noted" }
        : req.messages.at(-1)?.role === "toolResult"
          ? { text: "ok" }
          : { toolCalls: [{ name: "agent", args: { tasks: [{ role: "scribe", prompt: "note it" }] } }] },
    { cwd },
  )
  await root.prompt("go")
  expect(mock.requests[0]!.tools?.find((t) => t.name === "agent")?.description).toContain(
    "- scribe: Writes notes",
  )
  expect(mock.requests.find((q) => q.systemPrompt.includes("scribe"))?.tools?.map((t) => t.name)).toEqual([
    "read",
  ])
  expect(agentResult(root)).toContain("noted")
})

test("background sub-agents return ids at once; agent_result collects each result once", async () => {
  let childId = ""
  const { root } = await setup((req) => {
    const role = who(req)
    const last = req.messages.at(-1)
    if (role === "explorer") return { text: "background answer", delayMs: 20 }
    if (last?.role === "toolResult" && last.toolName === "agent") {
      childId = /(s_\w+) \(explorer\)/.exec(lastText(req))?.[1] ?? ""
      return { toolCalls: [{ name: "agent_result", args: { ids: [childId] } }] }
    }
    if (
      last?.role === "toolResult" &&
      last.toolName === "agent_result" &&
      !lastText(req).includes("already")
    ) {
      return { toolCalls: [{ name: "agent_result", args: {} }] }
    }
    if (last?.role === "toolResult") return { text: "finished" }
    return {
      toolCalls: [{ name: "agent", args: { tasks: [{ role: "explorer", prompt: "bg" }], background: true } }],
    }
  })
  await root.prompt("go")
  expect(agentResult(root)).toContain("Started in the background")
  const results = root.messages.filter((m) => m.role === "toolResult" && m.toolName === "agent_result")
  const texts = results.map((m) =>
    m.role === "toolResult" && m.content[0]?.type === "text" ? m.content[0].text : "",
  )
  expect(texts[0]).toContain("background answer")
  expect(texts[1]).toBe("There are no background sub-agents to collect.")
  expect(childId).toMatch(/^s_/)
})

test("a coder in a worktree has its change merged into the commander's checkout", async () => {
  const repo = await tempDir("amira-agent-repo-")
  const g = async (...args: string[]) => {
    const r = await git(args, repo)
    if (!r.ok) throw new Error(r.output)
  }
  await g("init", "-q")
  writeFileSync(path.join(repo, "f.txt"), "one\n")
  await g("add", ".")
  await g(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "init",
  )

  let childCwd = ""
  const { root } = await setup(
    (req) => {
      const role = who(req)
      const last = req.messages.at(-1)
      if (role === "coder") {
        childCwd = /own git worktree \(([^)]+)\)/.exec(req.systemPrompt)?.[1] ?? ""
        return last?.role === "toolResult"
          ? { text: "edited f.txt" }
          : { toolCalls: [{ name: "write", args: { path: "f.txt", content: "two\n" } }] }
      }
      return last?.role === "toolResult"
        ? { text: "ok" }
        : {
            toolCalls: [
              {
                name: "agent",
                args: { tasks: [{ role: "coder", prompt: "change f", isolation: "worktree" }] },
              },
            ],
          }
    },
    { cwd: repo },
  )
  await root.prompt("go")
  const text = agentResult(root)
  expect(text).toContain("edited f.txt")
  expect(text).toContain("Worktree: merged into the working tree, 1 file, +1 -1 (f.txt).")
  expect(childCwd).not.toBe(repo)
  expect(readFileSync(path.join(repo, "f.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("two\n")
})

test("worktree isolation outside a repository falls back to the shared directory", async () => {
  const { root, cwd } = await setup((req) => {
    const last = req.messages.at(-1)
    if (who(req) === "coder") {
      return last?.role === "toolResult"
        ? { text: "done" }
        : { toolCalls: [{ name: "write", args: { path: "z.txt", content: "z" } }] }
    }
    return last?.role === "toolResult"
      ? { text: "ok" }
      : {
          toolCalls: [
            { name: "agent", args: { tasks: [{ role: "coder", prompt: "z", isolation: "worktree" }] } },
          ],
        }
  })
  await root.prompt("go")
  expect(agentResult(root)).toContain(
    "No worktree (not a git repository); it worked in the shared directory.",
  )
  expect(readFileSync(path.join(cwd, "z.txt"), "utf8")).toBe("z")
})

test("a spent budget is reported for tasks that cannot start", async () => {
  const { root } = await setup(
    (req) =>
      req.messages.at(-1)?.role === "toolResult"
        ? { text: "ok" }
        : who(req) === "commander"
          ? {
              toolCalls: [{ name: "agent", args: { tasks: [{ role: "explorer", prompt: "x" }] } }],
              usage: { input: 500 },
            }
          : { text: "x" },
    { budget: { tokens: 100 } },
  )
  await root.prompt("go")
  expect(agentResult(root)).toContain(
    "did not start: the agent tree's budget is spent (500 tokens used, limit 100)",
  )
})
