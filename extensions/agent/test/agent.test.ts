import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import { type AnyEvent, defineTool, type Settings, textResult } from "@amira/api"
import { Agent, AgentTree, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { runCommand } from "@amira/proc"
import { createAgentExtension, hostGit, type RunGit } from "../src/index.ts"

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
  opts: { cwd?: string; settings?: Settings; budget?: { tokens: number }; git?: RunGit } = {},
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
  expect(await host.load(createAgentExtension({ git: opts.git ?? git }), "builtin:agent")).toBe(true)
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
    // git is slow on Windows; an interrupted agent tool still gets to report its children.
    abortGraceMs: 30_000,
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

/** A repository with one commit holding f.txt ("one"). */
async function gitRepo(): Promise<string> {
  const repo = await tempDir("amira-agent-repo-")
  const g = async (...args: string[]) => {
    const r = await git(args, repo)
    if (!r.ok) throw new Error(r.output)
  }
  await g("init", "-q")
  writeFileSync(path.join(repo, "f.txt"), "one\n")
  await g("add", ".")
  const id = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
  await g(...id, "commit", "-q", "-m", "init")
  return repo
}

const readText = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n")

test("a coder in a worktree has its change merged into the commander's checkout", async () => {
  const repo = await gitRepo()
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
  expect(readText(path.join(repo, "f.txt"))).toBe("two\n")
})

/** A worktree coder that writes f.txt, then thinks for a long time; the commander waits for it. */
function slowCoder(opts: { background?: boolean } = {}) {
  return (req: ModelRequest): MockReply => {
    const last = req.messages.at(-1)
    if (who(req) === "coder") {
      return last?.role === "toolResult"
        ? { text: "finished editing", delayMs: 30_000 }
        : { toolCalls: [{ name: "write", args: { path: "f.txt", content: "half\n" } }] }
    }
    return last?.role === "toolResult"
      ? { text: "ok" }
      : {
          toolCalls: [
            {
              name: "agent",
              args: {
                tasks: [{ role: "coder", prompt: "change f", isolation: "worktree" }],
                ...(opts.background ? { background: true } : {}),
              },
            },
          ],
        }
  }
}

/** Resolves once a sub-agent's write has run. */
function afterChildWrite(bus: EventBus): Promise<void> {
  return new Promise((resolve) => {
    const off = bus.subscribe((e) => {
      if (e.type === "tool.execute.end" && e.data.name === "write" && e.parentSessionId) {
        off()
        resolve()
      }
    })
  })
}

test("interrupting the commander aborts its sub-agents and keeps their half-done work unmerged", async () => {
  const repo = await gitRepo()
  const { root, bus, events } = await setup(slowCoder(), { cwd: repo })
  const turn = root.prompt("go")
  await afterChildWrite(bus)
  root.abort()
  expect((await turn).reason).toBe("aborted")
  await bus.flush()
  const end = events.find((e) => e.type === "subagent.end")
  expect(end?.type === "subagent.end" && end.data.status).toBe("aborted")
  // Nothing was applied to the commander's checkout; the change waits in the worktree.
  expect(readText(path.join(repo, "f.txt"))).toBe("one\n")
  const text = agentResult(root)
  expect(text).toContain("Worktree: NOT merged because the sub-agent was stopped along with its commander")
  const dir = /stay in (\S+); the patch/.exec(text)?.[1] ?? ""
  expect(readText(path.join(dir, "f.txt"))).toBe("half\n")
})

test("a sub-agent that fails keeps its worktree changes unmerged", async () => {
  const repo = await gitRepo()
  const { root } = await setup(
    (req) => {
      const last = req.messages.at(-1)
      if (who(req) === "coder") {
        return last?.role === "toolResult"
          ? { error: { message: "provider exploded" } }
          : { toolCalls: [{ name: "write", args: { path: "f.txt", content: "half\n" } }] }
      }
      return last?.role === "toolResult"
        ? { text: "ok" }
        : {
            toolCalls: [
              { name: "agent", args: { tasks: [{ role: "coder", prompt: "x", isolation: "worktree" }] } },
            ],
          }
    },
    { cwd: repo },
  )
  await root.prompt("go")
  expect(agentResult(root)).toContain("Worktree: NOT merged because the sub-agent ended with status error")
  expect(readText(path.join(repo, "f.txt"))).toBe("one\n")
})

test("an interrupt while worktrees are being made starts nothing further", async () => {
  const repo = await gitRepo()
  let makingSecond: () => void = () => {}
  const second = new Promise<void>((resolve) => {
    makingSecond = resolve
  })
  let adds = 0
  const slowGit: typeof git = async (args, cwd, stdoutOnly) => {
    if (args[0] === "worktree" && args[1] === "add" && ++adds === 2) {
      makingSecond()
      await Bun.sleep(300)
    }
    return git(args, cwd, stdoutOnly)
  }
  const { root, bus, events } = await setup(
    (req) =>
      who(req) === "coder"
        ? { text: "coding", delayMs: 30_000 }
        : req.messages.at(-1)?.role === "toolResult"
          ? { text: "ok" }
          : {
              toolCalls: [
                {
                  name: "agent",
                  args: {
                    tasks: [
                      { role: "coder", prompt: "a", isolation: "worktree" },
                      { role: "coder", prompt: "b", isolation: "worktree" },
                    ],
                  },
                },
              ],
            },
    { cwd: repo, git: slowGit },
  )
  const turn = root.prompt("go")
  await second
  root.abort()
  await turn
  await bus.flush()
  const starts = events.filter((e) => e.type === "subagent.start")
  const ends = events.filter((e) => e.type === "subagent.end")
  expect(starts.length).toBe(1)
  expect(ends.map((e) => e.type === "subagent.end" && e.data.status)).toEqual(["aborted"])
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

test("uncollected background sub-agents are stopped when the session ends, their work kept", async () => {
  const repo = await gitRepo()
  const { root, bus, events } = await setup(slowCoder({ background: true }), { cwd: repo })
  const wrote = afterChildWrite(bus)
  await root.prompt("go")
  expect(agentResult(root)).toContain("Started in the background")
  await wrote
  const reported = new Promise<void>((resolve) => {
    bus.subscribe((e) => {
      if (e.type === "extension.error") resolve()
    })
  })
  bus.emit("session.end", { reason: "exit" }, { sessionId: root.sessionId })
  await reported
  await bus.flush()
  const end = events.find((e) => e.type === "subagent.end")
  expect(end?.type === "subagent.end" && end.data.status).toBe("aborted")
  const error = events.find((e) => e.type === "extension.error")
  expect(error?.type === "extension.error" && error.data.error).toContain(
    "ended after its commander stopped: Worktree: NOT merged",
  )
  expect(readText(path.join(repo, "f.txt"))).toBe("one\n")
})

test("a sub-agent's own background sub-agents end with its turn", async () => {
  const { root, bus, events } = await setup((req) => {
    const last = req.messages.at(-1)
    if (who(req) === "explorer") return { text: "never", delayMs: 30_000 }
    if (who(req) === "coder") {
      return last?.role === "toolResult"
        ? { text: "coder done without collecting" }
        : {
            toolCalls: [
              { name: "agent", args: { tasks: [{ role: "explorer", prompt: "bg" }], background: true } },
            ],
          }
    }
    return last?.role === "toolResult"
      ? { text: "ok" }
      : { toolCalls: [{ name: "agent", args: { tasks: [{ role: "coder", prompt: "c" }] } }] }
  })
  const grandchildEnded = new Promise<void>((resolve) => {
    bus.subscribe((e) => {
      if (e.type === "subagent.end" && e.parentSessionId !== undefined) resolve()
    })
  })
  await root.prompt("go")
  await grandchildEnded
  await bus.flush()
  const ends = events.flatMap((e) => (e.type === "subagent.end" ? [e.data.status] : []))
  expect(ends.sort()).toEqual(["aborted", "done"])
})
