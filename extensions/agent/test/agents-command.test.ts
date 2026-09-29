import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import { type AnyEvent, defineTool, type FrontendView, type SessionControl, textResult } from "@amira/api"
import {
  Agent,
  AgentTree,
  CommandHost,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  listSubagents,
  ToolRegistry,
} from "@amira/core"
import { createAgentExtension, findSubagent, subagentSummary, transcriptText } from "../src/index.ts"

const dirs: string[] = []
const savedHome = process.env.AMIRA_HOME
afterAll(async () => {
  if (savedHome === undefined) delete process.env.AMIRA_HOME
  else process.env.AMIRA_HOME = savedHome
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

function who(req: ModelRequest): string {
  const m = /You are an? (explorer|coder|reviewer)\b/.exec(req.systemPrompt)
  return m ? m[1]! : req.systemPrompt.includes("# Sub-agent") ? "agent" : "commander"
}

async function setup(reply: (req: ModelRequest) => MockReply | Promise<MockReply>) {
  const home = await mkdtemp(path.join(os.tmpdir(), "amira-agents-cmd-"))
  dirs.push(home)
  process.env.AMIRA_HOME = home
  const mock = createMockDialect()
  for (let i = 0; i < 100; i++) mock.push(reply as (req: ModelRequest) => MockReply)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const tools = new ToolRegistry()
  // The commander waits for its sub-agents, so a finished prompt means finished sub-agents.
  const settings = { subagents: { background: false } }
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools, cwd: home, settings })
  expect(
    await host.load(createAgentExtension({ git: async () => ({ output: "", ok: false }) }), "builtin:agent"),
  ).toBe(true)
  tools.register(
    defineTool<{ path: string }>({
      name: "read",
      description: "read",
      parameters: { type: "object" },
      concurrency: "parallel",
      execute: async (p) => textResult(`contents of ${p.path}\nline 2\nline 3`),
    }),
    "test",
  )
  const tree = new AgentTree({ ai, sections: () => [{ name: "identity", text: "child" }] })
  const root = new Agent({
    ai,
    model: ai.model("mock/big"),
    cwd: home,
    systemPrompt: "commander",
    bus,
    tools,
    tree,
  })
  const control = {
    subagents: () => listSubagents(root, tree).map((e) => e.info),
    subagentMessages: (id: string) =>
      listSubagents(root, tree)
        .find((e) => e.info.id === id)
        ?.messages(),
    stopSubagent: (id: string) =>
      listSubagents(root, tree).some((e) => e.info.id === id) && tree.stop(id, "stopped by the user"),
  } as Partial<SessionControl> as SessionControl
  const commands = new CommandHost({ registry: host.commands, bus, ui: host.ui, control, agent: root })
  const views: FrontendView[] = []
  const run = async (line: string, frontend: "tui" | "rpc" = "tui") => {
    const r = await commands.run(line, {
      frontend,
      ...(frontend === "tui" ? { openView: (v: FrontendView) => void views.push(v) } : {}),
    })
    return { ...r, text: r.output.join("\n") }
  }
  return { root, tree, tools, bus, events, host, commands, control, run, views }
}

/** The commander starts a coder that reads a file and starts an explorer of its own. */
function nested(req: ModelRequest): MockReply {
  const role = who(req)
  const last = req.messages.at(-1)
  const answered = req.messages.filter((m) => m.role === "toolResult").length
  if (role === "commander") {
    return last?.role === "toolResult"
      ? { text: "all done" }
      : {
          toolCalls: [
            {
              name: "agent",
              args: { tasks: [{ role: "coder", title: "Fix the bug", prompt: "fix the bug\nin a.ts" }] },
            },
          ],
        }
  }
  if (role === "coder") {
    if (answered === 0) return { toolCalls: [{ name: "read", args: { path: "a.ts" } }] }
    if (answered === 1) {
      return {
        text: "Let me ask an explorer.\nIt knows more.",
        toolCalls: [
          {
            name: "agent",
            args: { tasks: [{ role: "explorer", title: "Find its uses", prompt: "where is it used" }] },
          },
        ],
        usage: { input: 1200, output: 34, cost: 0.0021 },
      }
    }
    return { text: "Fixed the bug.\nAll tests pass." }
  }
  return { text: "Used in b.ts." }
}

test("/agents lists the sub-agents and prints a finished one's transcript compactly", async () => {
  const { root, run, host, bus } = await setup(nested)
  await root.prompt("go")
  const picking = run("/agents")
  await bus.flush()
  const request = host.ui.pending[0]!
  expect(request.kind).toBe("select")
  const options = request.kind === "select" ? request.options : []
  // Numbered like /agents <n>, and in that position, so a digit in the dialog picks the same one.
  expect(options[0]).toMatch(
    /^1\. Fix the bug · coder · s_\w+ · done · \d+s · 1\.2k tok · \$0\.0021 · fix the bug in a\.ts$/,
  )
  expect(options[1]).toMatch(/^2\. {3}Find its uses · explorer · s_\w+ · done · /)
  expect(options[2]).toBe("Open the live view")
  host.ui.respond(request.requestId, options[0]!)
  const { text, ok } = await picking
  expect(ok).toBe(true)
  const lines = text.split("\n")
  expect(lines[0]).toMatch(/^◆ Fix the bug · coder · s_\w+ · done · \d+s · 1\.2k tok · \$0\.0021$/)
  expect(lines.slice(1)).toEqual([
    "› fix the bug",
    "  in a.ts",
    "",
    "● read a.ts",
    "  └ contents of a.ts (+2 lines)",
    "",
    "Let me ask an explorer.…",
    "",
    "● agent",
    expect.stringMatching(/^ {2}└ ## Find its uses · explorer · s_\w+ · done/),
    expect.stringMatching(
      /^ {2}◆ Find its uses · explorer · s_\w+ · done · \d+s · 0 tok · where is it used$/,
    ),
    "",
    "Fixed the bug.",
    "All tests pass.",
  ])
})

test("/agents <n|id> prints one directly; unknown ones are an error", async () => {
  const { root, run, control } = await setup(nested)
  await root.prompt("go")
  const [coder, explorer] = control.subagents()
  expect((await run("/agents 2")).text).toContain("› where is it used")
  expect((await run(`/agents ${coder!.id}`)).text).toContain("Fixed the bug.")
  expect((await run(`/agents ${explorer!.id.slice(0, 2)}`)).ok).toBe(false)
  expect((await run(`/agents ${explorer!.id.slice(0, 7)}`)).text).toContain("Used in b.ts.")
  const bad = await run("/agents 9")
  expect(bad.ok).toBe(false)
  expect(bad.error).toContain('no sub-agent "9"')
})

test("a running sub-agent shows its transcript so far", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const { root, run, tools, control } = await setup((req) => {
    const role = who(req)
    const last = req.messages.at(-1)
    if (role === "commander") {
      return last?.role === "toolResult"
        ? { text: "ok" }
        : { toolCalls: [{ name: "agent", args: { tasks: [{ title: "Do look", prompt: "look" }] } }] }
    }
    return last?.role === "toolResult"
      ? { text: "looked" }
      : { text: "Checking.", toolCalls: [{ name: "slow", args: { what: "the disk" } }] }
  })
  tools.register(
    defineTool({
      name: "slow",
      description: "",
      parameters: {},
      execute: () => gate.then(() => textResult("done")),
    }),
    "test",
  )
  const turn = root.prompt("go")
  const deadline = Date.now() + 3000
  while (!control.subagents()[0]?.id || !(await run("/agents 1")).text.includes("running…")) {
    if (Date.now() > deadline) throw new Error("the child never called its tool")
    await Bun.sleep(10)
  }
  const { text } = await run("/agents 1")
  expect(text.split("\n")).toEqual([
    expect.stringMatching(/^◆ Do look · agent · s_\w+ · running · \d+s · 0 tok$/),
    "› look",
    "",
    "Checking.",
    "",
    "● slow the disk",
    "  └ running…",
    "",
    "… still running",
  ])
  release()
  await turn
  expect((await run("/agents 1")).text).toContain("looked")
})

test("/agents view opens the live view where the frontend has one", async () => {
  const { root, run, views, control } = await setup(nested)
  expect((await run("/agents")).text).toBe("No sub-agents in this session yet.")
  await root.prompt("go")
  const [coder, explorer] = control.subagents()
  await run("/agents view")
  await run("/agents view 1")
  expect(views).toEqual([
    { kind: "subagent", sessionId: explorer!.id },
    { kind: "subagent", sessionId: coder!.id },
  ])
  const rpc = await run("/agents view", "rpc")
  expect(rpc.ok).toBe(false)
  expect(rpc.error).toContain("interactive")
})

test("the argument completes to ids, numbers as themselves, and to view <ref> after view", async () => {
  const { root, commands, control } = await setup(nested)
  await root.prompt("go")
  const [coder, explorer] = control.subagents()
  const all = await commands.complete("/agents ")
  expect(all.candidates.map((c) => c.value)).toEqual([coder!.id, explorer!.id, "view"])
  expect(all.candidates[0]!.description).toMatch(/^1\. Fix the bug · coder · /)
  // A typed number stays a number (the popup keeps an exact match), rather than an id with that digit.
  expect((await commands.complete("/agents 2")).candidates.map((c) => c.value)).toEqual(["2"])
  // Nothing after view yet: no candidates, so Enter runs /agents view on the default one.
  expect((await commands.complete("/agents view ")).candidates).toEqual([])
  expect((await commands.complete("/agents view s_")).candidates.map((c) => c.value)).toEqual([
    `view ${coder!.id}`,
    `view ${explorer!.id}`,
  ])
  expect((await commands.complete("/agents view 1")).candidates.map((c) => c.value)).toEqual(["view 1"])
})

test("/agents stop stops one running sub-agent, or all of them, and completes to running ones", async () => {
  const { root, run, commands, control, events, bus } = await setup((req) => {
    if (who(req) === "commander") {
      // Anything after the first message (the tool result, the stopped ones' reports) is answered.
      return req.messages.length > 1
        ? { text: "noted" }
        : {
            toolCalls: [
              {
                name: "agent",
                args: {
                  tasks: [
                    { title: "Do one", prompt: "one" },
                    { title: "Do two", prompt: "two" },
                    { title: "Do three", prompt: "three" },
                  ],
                  background: true,
                },
              },
            ],
          }
    }
    return { text: "slow", delayMs: 30_000 }
  })
  await root.prompt("go")
  const [a, b, c] = control.subagents()
  expect((await commands.complete("/agents stop ")).candidates.map((x) => x.value)).toEqual([
    `stop ${a!.id}`,
    `stop ${b!.id}`,
    `stop ${c!.id}`,
    "stop all",
  ])
  expect((await run("/agents stop 2")).text).toBe(`Stopped Do two (agent ${b!.id}).`)
  const ended = async (n: number) => {
    while (events.filter((e) => e.type === "subagent.end").length < n) await Bun.sleep(5)
  }
  await ended(1)
  expect(control.subagents()[1]).toMatchObject({ status: "aborted", error: "stopped by the user" })
  expect((await run("/agents stop 2")).text).toBe(`Do two (agent ${b!.id}) has already ended (aborted).`)
  expect((await run("/agents stop")).ok).toBe(false)
  expect((await run("/agents stop all")).text).toBe(
    `Stopped 2 sub-agents: Do one (agent ${a!.id}), Do three (agent ${c!.id}).`,
  )
  await ended(3)
  await bus.flush()
  expect((await run("/agents stop all")).text).toBe("No sub-agent is running.")
})

test("findSubagent takes a number, an id or a unique start of one", () => {
  const info = (id: string) => ({
    id,
    parentSessionId: "p",
    depth: 1,
    role: "agent",
    title: "Look around",
    task: "",
    status: "done" as const,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })
  const list = [info("s_aa11"), info("s_ab22")]
  expect(findSubagent(list, "2")?.id).toBe("s_ab22")
  expect(findSubagent(list, "s_aa11")?.id).toBe("s_aa11")
  expect(findSubagent(list, "s_a")).toBeUndefined()
  expect(findSubagent(list, "s_ab")?.id).toBe("s_ab22")
  expect(transcriptText({ ...list[0]!, status: "error", error: "boom" }, [], list)).toContain("✗ boom")
  // One that never started has no time to show.
  expect(subagentSummary({ ...list[0]!, status: "aborted" }, 0)).toBe(
    "Look around · agent · s_aa11 · aborted · 0 tok · ",
  )
})
