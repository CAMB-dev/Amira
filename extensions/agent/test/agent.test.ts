import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import { type AnyEvent, defineTool, type Settings, textResult, USER_STOP_REASON } from "@amira/api"
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
  // Calls wait for their sub-agents unless a test asks for the background default.
  const settings = opts.settings ?? { subagents: { background: false } }
  const host = new ExtensionHost({ bus, interceptors, tools, cwd, settings })
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
  return { root, mock, bus, events, cwd, home, tools, tree }
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
                    { role: "explorer", title: "Do find the config", prompt: "find the config" },
                    { role: "coder", title: "Do create y.txt", prompt: "create y.txt" },
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
  expect(text).toContain("## Do find the config · explorer · s_")
  expect(text).toContain("done (")
  expect(text).toContain("1.2k tokens")
  expect(text).toContain("The config is in a.ts:3")
  expect(text).toContain("Changes: none.")
  expect(text).toContain("## Do create y.txt · coder")
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
      return {
        toolCalls: [{ name: "agent", args: { tasks: [{ role: "coder", title: "Do one", prompt: "one" }] } }],
      }
    if (role === "coder" && !lastText(req).includes("two")) {
      return {
        toolCalls: [{ name: "agent", args: { tasks: [{ role: "coder", title: "Do two", prompt: "two" }] } }],
      }
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
      : { toolCalls: [{ name: "agent", args: { tasks: [{ role: "wizard", title: "Do x", prompt: "x" }] } }] },
  )
  await root.prompt("go")
  await bus.flush()
  expect(agentResult(root)).toContain("Unknown role: wizard. Known roles: explorer, coder, reviewer")
  expect(events.some((e) => e.type === "subagent.start")).toBe(false)
})

test("every task needs a short title; without one, or with a long one, nothing starts", async () => {
  for (const [title, expected] of [
    [undefined, 'Task 2 has no "title"'],
    ["   ", 'Task 2 has no "title"'],
    ["x".repeat(61), `Task 2's "title" is 61 characters long`],
  ] as const) {
    const { root, events, bus } = await setup((req) =>
      req.messages.at(-1)?.role === "toolResult"
        ? { text: "ok" }
        : {
            toolCalls: [
              {
                name: "agent",
                args: {
                  tasks: [
                    { role: "explorer", title: "Look around", prompt: "x" },
                    { role: "explorer", ...(title !== undefined ? { title } : {}), prompt: "y" },
                  ],
                },
              },
            ],
          },
    )
    await root.prompt("go")
    await bus.flush()
    expect(agentResult(root)).toContain(expected)
    expect(events.some((e) => e.type === "subagent.start")).toBe(false)
  }
})

test("a sub-agent carries its title and the id of the call that started it", async () => {
  const { root, events, bus, mock } = await setup((req) =>
    who(req) === "commander" && req.messages.at(-1)?.role !== "toolResult"
      ? {
          toolCalls: [
            {
              name: "agent",
              args: { tasks: [{ role: "explorer", title: "  US   market trend ", prompt: "look" }] },
            },
          ],
        }
      : { text: "ok" },
  )
  await root.prompt("go")
  await bus.flush()
  const call = root.messages.find((m) => m.role === "toolResult" && m.toolName === "agent")
  const callId = call?.role === "toolResult" ? call.toolCallId : ""
  expect(callId).not.toBe("")
  const start = events.find((e) => e.type === "subagent.start")
  const end = events.find((e) => e.type === "subagent.end")
  expect(start?.type === "subagent.start" && start.data).toMatchObject({
    title: "US market trend",
    toolCallId: callId,
  })
  expect(end?.type === "subagent.end" && end.data.toolCallId).toBe(callId)
  expect(agentResult(root)).toContain("## US market trend · explorer · ")
  // The model is told to give one.
  const schema = mock.requests[0]!.tools?.find((t) => t.name === "agent")?.parameters as {
    properties: { tasks: { items: { required: string[] } } }
  }
  expect(schema.properties.tasks.items.required).toEqual(["title", "prompt"])
})

test("settings agents.<role>.model picks the child's model", async () => {
  const { root, mock } = await setup(
    (req) =>
      who(req) === "commander" && req.messages.at(-1)?.role !== "toolResult"
        ? {
            toolCalls: [
              { name: "agent", args: { tasks: [{ role: "explorer", title: "Do look", prompt: "look" }] } },
            ],
          }
        : { text: "ok" },
    { settings: { agents: { explorer: { model: "cheap/small" } }, subagents: { background: false } } },
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
          : {
              toolCalls: [
                {
                  name: "agent",
                  args: { tasks: [{ role: "scribe", title: "Do note it", prompt: "note it" }] },
                },
              ],
            },
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
      childId = /(s_\w+) \(explorer: /.exec(lastText(req))?.[1] ?? ""
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
      toolCalls: [
        {
          name: "agent",
          args: { tasks: [{ role: "explorer", title: "Do bg", prompt: "bg" }], background: true },
        },
      ],
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

test("agent_result with wait false reports a sub-agent still running and keeps it collectible", async () => {
  const { root, bus } = await setup((req) => {
    const last = req.messages.at(-1)
    if (who(req) === "explorer") return { text: "slow answer", delayMs: 30_000 }
    if (last?.role === "toolResult" && last.toolName === "agent") {
      return { toolCalls: [{ name: "agent_result", args: { wait: false } }] }
    }
    if (last?.role === "toolResult") return { text: "later" }
    return {
      toolCalls: [
        {
          name: "agent",
          args: { tasks: [{ role: "explorer", title: "Do look far", prompt: "look far" }], background: true },
        },
      ],
    }
  })
  await root.prompt("go")
  expect(agentResult(root, "agent_result")).toMatch(
    /^## Do look far · explorer · s_\w+ · still running \(\d+s\): look far$/,
  )
  // The job outlived the turn; the session's end stops it.
  const ended = new Promise<void>((resolve) => {
    bus.subscribe((e) => {
      if (e.type === "subagent.end") resolve()
    })
  })
  bus.emit("session.end", { reason: "exit" }, { sessionId: root.sessionId })
  await ended
})

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
                args: {
                  tasks: [{ role: "coder", title: "Do change f", prompt: "change f", isolation: "worktree" }],
                },
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
                tasks: [{ role: "coder", title: "Do change f", prompt: "change f", isolation: "worktree" }],
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
              {
                name: "agent",
                args: { tasks: [{ role: "coder", title: "Do x", prompt: "x", isolation: "worktree" }] },
              },
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
                      { role: "coder", title: "Do a", prompt: "a", isolation: "worktree" },
                      { role: "coder", title: "Do b", prompt: "b", isolation: "worktree" },
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
            {
              name: "agent",
              args: { tasks: [{ role: "coder", title: "Do z", prompt: "z", isolation: "worktree" }] },
            },
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
              toolCalls: [
                { name: "agent", args: { tasks: [{ role: "explorer", title: "Do x", prompt: "x" }] } },
              ],
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
              {
                name: "agent",
                args: { tasks: [{ role: "explorer", title: "Do bg", prompt: "bg" }], background: true },
              },
            ],
          }
    }
    return last?.role === "toolResult"
      ? { text: "ok" }
      : { toolCalls: [{ name: "agent", args: { tasks: [{ role: "coder", title: "Do c", prompt: "c" }] } }] }
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

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await Bun.sleep(5)
  }
}

/** The commander's messages that brought background results, as the model and the transcript see them. */
function notices(root: Agent) {
  return root.messages.flatMap((m) =>
    m.role === "user" && m.display?.origin === "subagent"
      ? [{ text: m.content.map((b) => (b.type === "text" ? b.text : "")).join(""), shown: m.display.text }]
      : [],
  )
}

const isNotice = (req: ModelRequest) =>
  req.messages.at(-1)?.role === "user" && /reports? follows?/.test(lastText(req))

const replied = (root: Agent, text: string) =>
  root.messages.some(
    (m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text === text),
  )

test("by default sub-agents run in the background and their result wakes the idle commander", async () => {
  let childId = ""
  const { root, bus, events } = await setup(
    (req) => {
      const last = req.messages.at(-1)
      if (who(req) === "explorer") return { text: "found it in a.ts", delayMs: 50 }
      if (isNotice(req)) return { toolCalls: [{ name: "agent_result", args: { ids: [childId] } }] }
      if (last?.role === "toolResult" && last.toolName === "agent_result") return { text: "thanks, reacting" }
      if (last?.role === "toolResult") {
        childId = /(s_\w+) \(explorer: /.exec(lastText(req))?.[1] ?? ""
        return { text: "started it; ask me anything meanwhile" }
      }
      return {
        toolCalls: [
          { name: "agent", args: { tasks: [{ role: "explorer", title: "Do look", prompt: "look" }] } },
        ],
      }
    },
    { settings: {} },
  )
  expect((await root.prompt("go")).reason).toBe("done")
  expect(agentResult(root)).toContain("Started in the background")
  expect(agentResult(root)).toContain("come to you by themselves")
  await until(() => replied(root, "thanks, reacting"))
  await bus.flush()
  const [notice] = notices(root)
  expect(notice?.shown).toMatch(/^◆ Do look finished · explorer · \d+s · \d+ tok$/)
  expect(notice?.text).toContain("the user did not write this message")
  expect(notice?.text).toContain(`## Do look · explorer · ${childId} · done`)
  expect(notice?.text).toContain("found it in a.ts")
  // The woken turn is an ordinary turn whose prompt is the notice.
  const starts = events.filter((e) => e.type === "turn.start" && e.sessionId === root.sessionId)
  expect(starts.length).toBe(2)
  expect(starts[1]?.type === "turn.start" && starts[1].data.prompt.display?.origin).toBe("subagent")
  // Handed out once: agent_result does not repeat it.
  expect(agentResult(root, "agent_result")).toBe(
    `${childId}: its result was already sent to you as a message.`,
  )
})

test("a background sub-agent that failed says why in its notice line", async () => {
  const { root, bus } = await setup(
    (req) => {
      if (who(req) === "explorer") return { error: { message: "HTTP 429: slow down", status: 429 } }
      if (isNotice(req)) return { text: "noted" }
      if (req.messages.at(-1)?.role === "toolResult") return { text: "started" }
      return {
        toolCalls: [
          { name: "agent", args: { tasks: [{ role: "explorer", title: "Do look", prompt: "l" }] } },
        ],
      }
    },
    { settings: {} },
  )
  await root.prompt("go")
  await until(() => replied(root, "noted"))
  await bus.flush()
  expect(notices(root)[0]?.shown).toMatch(
    /^◆ Do look failed · explorer · \d+s · \d+ tok · HTTP 429: slow down$/,
  )
})

test("a background sub-agent the user stopped does not wake the commander; its report waits", async () => {
  const { root, bus, tree, mock } = await setup(
    (req) => {
      if (who(req) === "explorer") return { text: "late", delayMs: 5_000 }
      if (isNotice(req)) return { text: "woken" }
      if (req.messages.at(-1)?.role === "toolResult") return { text: "started" }
      if (lastText(req).includes("next")) return { text: "answered next" }
      return {
        toolCalls: [
          { name: "agent", args: { tasks: [{ role: "explorer", title: "Do look", prompt: "l" }] } },
        ],
      }
    },
    { settings: {} },
  )
  await root.prompt("go")
  const [child] = tree.children
  expect(child).toBeDefined()
  tree.stop(child!.id, USER_STOP_REASON)
  await until(() => root.waitingNotices === 1)
  await Bun.sleep(100)
  await bus.flush()
  // No turn of its own: the commander is idle, the report waits.
  expect(root.busy).toBe(false)
  expect(replied(root, "woken")).toBe(false)
  const before = mock.requests.length
  await root.prompt("next")
  // The user's message and the report go to the model together, in one request.
  expect(mock.requests.length).toBe(before + 1)
  const sent = mock.requests
    .at(-1)!
    .messages.slice(-2)
    .map((m) => m.role)
  expect(sent).toEqual(["user", "user"])
  expect(notices(root)[0]?.shown).toMatch(/^◆ Do look stopped · explorer · /)
})

test("settings subagents.background false makes calls wait again", async () => {
  const { root, mock } = await setup(
    (req) =>
      who(req) === "explorer"
        ? { text: "waited answer" }
        : req.messages.at(-1)?.role === "toolResult"
          ? { text: "ok" }
          : {
              toolCalls: [
                { name: "agent", args: { tasks: [{ role: "explorer", title: "Do x", prompt: "x" }] } },
              ],
            },
    { settings: { subagents: { background: false } } },
  )
  await root.prompt("go")
  expect(agentResult(root)).toContain("waited answer")
  expect(notices(root)).toEqual([])
  expect(mock.requests[0]!.tools?.find((t) => t.name === "agent")?.description).toContain(
    "The call waits for the sub-agents",
  )
})

/** A tool that returns once `ready` resolves (or the call is aborted). */
function waitTool(ready: () => Promise<unknown>) {
  return defineTool({
    name: "hold",
    description: "hold",
    parameters: { type: "object" },
    concurrency: "parallel",
    execute: async (_p, ctx) => {
      await Promise.race([
        ready(),
        new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true })),
      ])
      return textResult("held")
    },
  })
}

test("a result that arrives while the commander works joins its turn before the next model call", async () => {
  const { root, bus, events, tools } = await setup(
    (req) => {
      const last = req.messages.at(-1)
      if (who(req) === "explorer") return { text: "quick answer", delayMs: 10 }
      if (isNotice(req)) return { text: "used the answer" }
      if (last?.role === "toolResult" && last.toolName === "agent")
        return { toolCalls: [{ name: "hold", args: {} }] }
      if (last?.role === "toolResult") return { text: "no notice?" }
      return {
        toolCalls: [{ name: "agent", args: { tasks: [{ role: "explorer", title: "Do q", prompt: "q" }] } }],
      }
    },
    { settings: {} },
  )
  // The commander keeps working until the result is queued for it.
  tools.register(
    waitTool(
      () =>
        new Promise<void>((resolve) => {
          const off = bus.subscribe((e) => {
            if (e.type === "turn.steer" && e.data.state === "queued") {
              off()
              resolve()
            }
          })
        }),
    ),
    "test",
  )
  expect((await root.prompt("go")).reason).toBe("done")
  await bus.flush()
  expect(replied(root, "used the answer")).toBe(true)
  expect(events.filter((e) => e.type === "turn.start" && e.sessionId === root.sessionId).length).toBe(1)
  const injected = events.filter((e) => e.type === "turn.steer" && e.data.state === "injected")
  expect(injected.length).toBe(1)
  expect(notices(root)[0]?.text).toContain("quick answer")
})

test("sub-agents finishing close together come back as one message", async () => {
  const { root, bus, events } = await setup(
    (req) => {
      const last = req.messages.at(-1)
      if (who(req) === "explorer") {
        return lastText(req) === "a" ? { text: "answer A", delayMs: 20 } : { text: "answer B", delayMs: 80 }
      }
      if (isNotice(req)) return { text: "both in" }
      if (last?.role === "toolResult") return { text: "started" }
      return {
        toolCalls: [
          {
            name: "agent",
            args: {
              tasks: [
                { role: "explorer", title: "Do a", prompt: "a" },
                { role: "explorer", title: "Do b", prompt: "b" },
              ],
            },
          },
        ],
      }
    },
    { settings: {} },
  )
  await root.prompt("go")
  await until(() => replied(root, "both in"))
  await bus.flush()
  const all = notices(root)
  expect(all.length).toBe(1)
  expect(all[0]?.text).toContain("2 sub-agents you started in the background have ended")
  expect(all[0]?.text).toContain("answer A")
  expect(all[0]?.text).toContain("answer B")
  expect(all[0]?.shown.split("\n").length).toBe(2)
  expect(events.filter((e) => e.type === "turn.start" && e.sessionId === root.sessionId).length).toBe(2)
})

test("in the main session agent_result does not wait: the result still comes once, as a notice", async () => {
  const { root, bus, events } = await setup(
    (req) => {
      const last = req.messages.at(-1)
      if (who(req) === "explorer") return { text: "awaited answer", delayMs: 30 }
      if (isNotice(req)) return { text: "got the notice" }
      if (last?.role === "toolResult" && last.toolName === "agent") {
        return { toolCalls: [{ name: "agent_result", args: {} }] }
      }
      if (last?.role === "toolResult") return { text: "collected" }
      return {
        toolCalls: [{ name: "agent", args: { tasks: [{ role: "explorer", title: "Do x", prompt: "x" }] } }],
      }
    },
    { settings: {} },
  )
  await root.prompt("go")
  // The call came back at once, while the sub-agent was still running.
  expect(agentResult(root, "agent_result")).not.toContain("awaited answer")
  await Bun.sleep(400)
  await bus.flush()
  expect(
    notices(root)
      .map((n) => n.text)
      .join("\n"),
  ).toContain("awaited answer")
  expect(root.expectedNotices).toBe(0)
  expect(events.filter((e) => e.type === "turn.start" && e.sessionId === root.sessionId).length).toBe(2)
})

test("the main session runs sub-agents in the background even when the model asks to wait", async () => {
  const { root, bus } = await setup(
    (req) => {
      const last = req.messages.at(-1)
      if (who(req) === "explorer") return { text: "late answer", delayMs: 30 }
      if (isNotice(req)) return { text: "summarized" }
      if (last?.role === "toolResult") return { text: "started" }
      return {
        toolCalls: [
          {
            name: "agent",
            args: { background: false, tasks: [{ role: "explorer", title: "Do x", prompt: "x" }] },
          },
        ],
      }
    },
    { settings: {} },
  )
  await root.prompt("go")
  expect(agentResult(root, "agent")).toContain("Started in the background")
  await Bun.sleep(400)
  await bus.flush()
  expect(
    notices(root)
      .map((n) => n.text)
      .join("\n"),
  ).toContain("late answer")
})

test("interrupting the commander leaves its background sub-agents running; their result still comes", async () => {
  const { root, bus, events, tools } = await setup(
    (req) => {
      const last = req.messages.at(-1)
      if (who(req) === "explorer") return { text: "survived", delayMs: 150 }
      if (isNotice(req)) return { text: "got it after the interrupt" }
      if (last?.role === "toolResult" && last.toolName === "agent")
        return { toolCalls: [{ name: "hold", args: {} }] }
      if (last?.role === "toolResult") return { text: "?" }
      return {
        toolCalls: [{ name: "agent", args: { tasks: [{ role: "explorer", title: "Do x", prompt: "x" }] } }],
      }
    },
    { settings: {} },
  )
  let holding!: () => void
  const held = new Promise<void>((resolve) => {
    holding = resolve
  })
  tools.register(
    waitTool(() => {
      holding()
      return new Promise(() => {})
    }),
    "test",
  )
  const turn = root.prompt("go")
  await held
  root.abort()
  expect((await turn).reason).toBe("aborted")
  await until(() => replied(root, "got it after the interrupt"))
  await bus.flush()
  const end = events.find((e) => e.type === "subagent.end")
  expect(end?.type === "subagent.end" && end.data.status).toBe("done")
  expect(notices(root)[0]?.text).toContain("survived")
})

test("agent_result called after an interrupt returns at once and leaves the result to the notice", async () => {
  const { root, bus, tools } = await setup(
    (req) =>
      who(req) === "explorer"
        ? { text: "late answer", delayMs: 100 }
        : isNotice(req)
          ? { text: "got it" }
          : req.messages.at(-1)?.role === "toolResult"
            ? { text: "started" }
            : {
                toolCalls: [
                  { name: "agent", args: { tasks: [{ role: "explorer", title: "Do x", prompt: "x" }] } },
                ],
              },
    { settings: {} },
  )
  await root.prompt("go")
  const abort = new AbortController()
  abort.abort()
  const r = await tools.get("agent_result")!.execute(
    {},
    {
      cwd: root.cwd,
      toolCallId: "c1",
      signal: abort.signal,
      update: () => {},
      session: { sessionId: root.sessionId } as never,
    },
  )
  expect(r.content[0]).toEqual({
    type: "text",
    text: "Interrupted; finished results come to you as a message.",
  })
  await until(() => replied(root, "got it"))
  await bus.flush()
  expect(notices(root)[0]?.text).toContain("late answer")
  expect(root.expectedNotices).toBe(0)
})

test("a new conversation stops the old one's background sub-agents", async () => {
  const { root, bus, events } = await setup(
    (req) =>
      who(req) === "explorer"
        ? { text: "slow", delayMs: 30_000 }
        : req.messages.at(-1)?.role === "toolResult"
          ? { text: "started" }
          : {
              toolCalls: [
                { name: "agent", args: { tasks: [{ role: "explorer", title: "Do x", prompt: "x" }] } },
              ],
            },
    { settings: {} },
  )
  await root.prompt("go")
  expect(root.expectedNotices).toBe(1)
  bus.emit(
    "session.start",
    { reason: "clear", cwd: root.cwd, model: { provider: "mock", model: "big" } },
    { sessionId: "s_new" },
  )
  await until(() => events.some((e) => e.type === "subagent.end"))
  await bus.flush()
  expect(root.expectedNotices).toBe(0)
  const end = events.find((e) => e.type === "subagent.end")
  expect(end?.type === "subagent.end" && end.data.error).toBe("its commander's session was closed")
  await Bun.sleep(400)
  expect(notices(root)).toEqual([])
})

test("a persistent sub-agent's background sub-agents outlive its turn and their report wakes it", async () => {
  const { root, tree, bus, events } = await setup((req) => {
    if (who(req) === "explorer") return { text: "found it in a.ts", delayMs: 150 }
    if (!req.systemPrompt.includes("WORKER")) return { text: "root" }
    if (isNotice(req)) return { text: "got the report" }
    if (req.messages.at(-1)?.role === "toolResult") return { text: "waiting for the explorer" }
    return {
      toolCalls: [
        {
          name: "agent",
          args: { tasks: [{ role: "explorer", title: "Look around", prompt: "look" }], background: true },
        },
      ],
    }
  })
  const worker = tree.spawn(root, { prompt: "work", systemPrompt: "WORKER", persistent: true })
  await until(() => worker.turns >= 2 && worker.state === "idle")
  await bus.flush()
  const explorerEnd = events.find((e) => e.type === "subagent.end" && e.sessionId === worker.id)
  expect(explorerEnd?.type === "subagent.end" && explorerEnd.data.status).toBe("done")
  worker.stop()
  const r = await worker.result()
  expect(r).toMatchObject({ status: "done", turns: 2, text: "got the report" })
})
