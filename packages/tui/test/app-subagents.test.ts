import { expect, test } from "bun:test"
import { type ChildSession, defineTool, type SpawnGroup, textResult } from "@amira/api"
import { parallel, setup, waitFor } from "./app-harness.ts"

function delegateTool(role = "explorer") {
  return defineTool<{ titles: string[] }>({
    name: "delegate",
    description: "",
    parameters: {},
    concurrency: "parallel",
    execute: async (p, ctx) => {
      const kids = p.titles.map((title) =>
        ctx.session!.spawn!({
          role: title.startsWith("Add") ? "coder" : role,
          title,
          prompt: `do: ${title}`,
        }),
      )
      const results = await Promise.all(kids.map((k) => k.result()))
      return textResult(results.map((r) => r.text).join("\n"))
    },
  })
}

test("sub-agents show under their call: title, role, time, tokens, current tool, queued ones", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup(
    [
      { toolCalls: [{ name: "delegate", args: { titles: ["US market trend", "Add status bar test"] } }] },
      { toolCalls: [{ name: "read", args: { path: "a.ts" } }], usage: { input: 4000, output: 100 } },
      { text: "trend is up", delayMs: 400 },
      { text: "test added", usage: { input: 1200, output: 30 } },
      { text: "all done" },
    ],
    { cols: 80, tree: true, maxConcurrent: 1 },
  )
  agent.tools.register(delegateTool(), "test")
  terminal.send("go\r")
  // The first one runs its tool; the second waits for the slot.
  await waitFor(
    () =>
      /^ {2}└ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] delegate +\d+s\n {5}├ ◆ US market trend · explorer · \d+s · 4\.1k tok\n {5}│ └ ● read a\.ts\n {5}└ ◆ Add status bar test · coder · queued\n/m.test(
        live(),
      ),
    "rows under the call",
  )
  // No list of sub-agents at the bottom of the live region: only the activity line is there.
  expect(live().match(/◆/g)).toHaveLength(2)
  await shows("all done")
  await idle()
  const text = all()
  // Each one's rows became its end line, committed with the call right under its head, in order.
  expect(text).toMatch(
    /^ {2}└ delegate {2}✓ trend is up \(\+1 line\) · \d+\.\ds\n {5}├ ◆ US market trend ✓ explorer · \d+\.\ds · 4\.1k tok · trend is up\n {5}├ ◆ Add status bar test ✓ coder · \d+\.\ds · 1\.2k tok · test added$/m,
  )
  expect(text.match(/◆ US market trend/g)).toHaveLength(1)
  // Nothing is left of them in the live region below the transcript.
  expect(live().split("  all done")[1]).not.toContain("◆")
  // The children's replies only show as their commander's tool result, not as replies of their own.
  expect(text).not.toMatch(/^ {2}trend is up$/m)
  terminal.send("\x03")
  await exited
})

test("with sub-agents running, Esc says they go on, and quitting takes a second Ctrl+C", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup(
    [
      { toolCalls: [{ name: "spawn_bg", args: {} }] },
      { text: "late child", delayMs: 3000 },
      { text: "never shown", delayMs: 2000 },
    ],
    { cols: 90, tree: true },
  )
  agent.tools.register(
    defineTool({
      name: "spawn_bg",
      description: "",
      parameters: {},
      execute: async (_p, ctx) => {
        ctx.session!.spawn!({ role: "explorer", title: "Look around", prompt: "look" })
        return textResult("started")
      },
    }),
    "test",
  )
  terminal.send("go\r")
  await waitFor(() => (agent.tree?.children.length ?? 0) === 1, "the child")
  await Bun.sleep(100)
  terminal.send("\x1b[27u")
  await shows("Interrupted · 1 sub-agent still running · /agents")
  await idle()
  let quit = false
  void exited.then(() => {
    quit = true
  })
  terminal.send("\x03")
  await waitFor(
    () => live().includes("1 sub-agent still running — Ctrl+C again to stop them and quit"),
    "the warning",
  )
  await Bun.sleep(50)
  expect(quit).toBe(false)
  terminal.send("\x03")
  await exited
  expect(all()).not.toContain("never shown")
})

test("a sub-agent's end line stays with its call when that call is held behind a slower one", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup(
    [
      {
        toolCalls: [
          { name: "slow", args: { path: "big.log" } },
          { name: "delegate", args: { titles: ["Look around"] } },
        ],
      },
      { text: "child answer" },
      { text: "all done" },
    ],
    { cols: 80, tree: true },
  )
  let release!: () => void
  agent.tools.register(
    defineTool({
      name: "slow",
      ...parallel,
      execute: () =>
        new Promise((r) => {
          release = () => r(textResult("slow result"))
        }),
    }),
    "test",
  )
  agent.tools.register(delegateTool(), "test")
  terminal.send("go\r")
  // The child is done and so is its call, but both wait below the running slow call.
  await waitFor(
    () =>
      /^ {2}├ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] slow big\.log +\d+s\n {2}└ delegate {2}✓ child answer\n {5}└ ◆ Look around ✓ [^\n]*child answer/m.test(
        live(),
      ),
    "held",
  )
  release()
  await shows("all done")
  await idle()
  const text = all()
  expect(text).toMatch(
    /^ {2}├ slow big\.log {2}✓ slow result\n {2}└ delegate {2}✓ child answer\n {5}├ ◆ Look around ✓ [^\n]*child answer$/m,
  )
  expect(text.match(/◆ Look around ✓/g)).toHaveLength(1)
  terminal.send("\x03")
  await exited
})

test("parallel calls each keep their own sub-agents, matched by call id, not by task", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup(
    [
      {
        toolCalls: [
          { name: "delegate", args: { titles: ["First pass"] } },
          { name: "delegate", args: { titles: ["Second pass"] } },
        ],
      },
      { text: "one", delayMs: 200 },
      { text: "two", delayMs: 200 },
      { text: "all done" },
    ],
    { cols: 80, tree: true },
  )
  agent.tools.register(delegateTool(), "test")
  terminal.send("go\r")
  await waitFor(
    () =>
      /^ {2}├ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] delegate +\d+s\n {2}│ {2}└ ◆ First pass · [^\n]*\n {2}└ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] delegate +\d+s\n {5}└ ◆ Second pass · /m.test(
        live(),
      ),
    "each under its own call",
  )
  await shows("all done")
  await idle()
  expect(all()).toMatch(
    /^ {2}├ delegate {2}✓ one\n {2}│ {2}├ ◆ First pass ✓ explorer · \d+\.\ds · 0 tok · one\n {2}└ delegate {2}✓ two\n {5}├ ◆ Second pass ✓ explorer · \d+\.\ds · 0 tok · two$/m,
  )
  terminal.send("\x03")
  await exited
})

test("nested sub-agents sit one level deeper under their parent's row", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup(
    [
      { toolCalls: [{ name: "delegate", args: { titles: ["Outer task"] } }] },
      { toolCalls: [{ name: "delegate", args: { titles: ["Inner check"] } }] },
      { text: "inner done", delayMs: 400 },
      { text: "outer done" },
      { text: "all done" },
    ],
    { cols: 80, tree: true },
  )
  agent.tools.register(delegateTool(), "test")
  terminal.send("go\r")
  await waitFor(
    () =>
      /^ {2}└ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] delegate +\d+s\n {5}└ ◆ Outer task · explorer · \d+s · 0 tok\n {7}└ ● delegate\n {7}└ ◆ Inner check · explorer · \d+s · 0 tok\n/m.test(
        live(),
      ),
    "nested rows",
  )
  await shows("all done")
  await idle()
  expect(all()).toMatch(
    /^ {2}└ delegate {2}✓ outer done · \d+\.\ds\n {5}├ ◆ Outer task ✓ explorer [^\n]*outer done\n {5}│ └ ◆ Inner check ✓ explorer [^\n]*inner done$/m,
  )
  terminal.send("\x03")
  await exited
})

test("after an interrupt, a sub-agent it stopped gets its end line; one that runs on and finishes does not", async () => {
  // Replies go by who asks: the commander, or a child by its task.
  const reply = (req: { messages: { role: string; content: unknown }[] }) => {
    const task = JSON.stringify(req.messages[0]?.content)
    if (task.includes("keep going")) return { text: "kept at it", delayMs: 300 }
    if (task.includes("stop me")) return { text: "never", delayMs: 5000 }
    return { toolCalls: [{ name: "pair", args: {} }] }
  }
  const { terminal, live, all, idle, exited, agent, bus } = await setup([reply, reply, reply], {
    cols: 90,
    tree: true,
  })
  let survivor: ChildSession | undefined
  agent.tools.register(
    defineTool({
      name: "pair",
      description: "",
      parameters: {},
      // Like the main session's agent calls: an interrupt stops one child, the other runs on.
      execute: (_p, ctx) => {
        survivor = ctx.session!.spawn!({ role: "explorer", title: "Keep going", prompt: "keep going" })
        const stopped = ctx.session!.spawn!({ role: "explorer", title: "Stop me", prompt: "stop me" })
        return new Promise((r) =>
          ctx.signal.addEventListener("abort", () => {
            stopped.abort("interrupted")
            r(textResult("Started in the background"))
          }),
        )
      },
    }),
    "test",
  )
  terminal.send("go\r")
  await waitFor(() => live().includes("◆ Stop me · explorer"), "both running")
  terminal.send("\x1b[27u")
  // The one it stopped may not have ended yet when the turn does.
  await waitFor(() => /Interrupted · [12] sub-agents? still running · \/agents/.test(all()), "the interrupt")
  await survivor!.result()
  await idle()
  await bus.flush()
  await waitFor(() => !live().includes("running in background"), "the rows gone")
  expect(all()).toMatch(/└ ◆ Stop me ⊘ explorer · [^\n]*stopped/)
  expect(all().match(/◆ Stop me ⊘/g)).toHaveLength(1)
  // The survivor's notice (the agent extension's) reports it; no line of its own here.
  expect(all()).not.toContain("◆ Keep going ✓")
  terminal.send("\x03")
  await exited
})

test("sub-agents that outlive their call run on under a head shaped like the call, with no end line", async () => {
  let finish!: () => void
  // The child and the commander ask in no fixed order: each reply goes by who asks.
  const reply = (req: { messages: { role: string; content: unknown }[] }) => {
    const child = JSON.stringify(req.messages[0]?.content).includes('"scan"')
    const answered = req.messages.at(-1)?.role === "toolResult"
    if (child)
      return answered
        ? { text: "scanned" }
        : { toolCalls: [{ name: "scan", args: { path: "logs/app.log" } }] }
    return answered ? { text: "started it" } : { toolCalls: [{ name: "launch", args: {} }] }
  }
  const { terminal, live, all, shows, idle, exited, agent, bus } = await setup([reply, reply, reply, reply], {
    cols: 80,
    tree: true,
  })
  const gate = new Promise<void>((r) => {
    finish = r
  })
  agent.tools.register(
    defineTool({
      name: "scan",
      description: "",
      parameters: {},
      execute: async () => {
        await gate
        return textResult("log lines")
      },
    }),
    "test",
  )
  let child: ChildSession | undefined
  agent.tools.register(
    defineTool({
      name: "launch",
      description: "",
      parameters: {},
      execute: async (_p, ctx) => {
        child = ctx.session!.spawn!({ role: "explorer", title: "Scan the logs", prompt: "scan" })
        return textResult("Started in the background")
      },
    }),
    "test",
  )
  terminal.send("go\r")
  await shows("started it")
  await idle()
  // The call is committed; its sub-agent runs on in the live region.
  expect(all()).toMatch(/^ {2}└ launch {2}✓ Started in the background$/m)
  await waitFor(
    () =>
      /● launch · 1 sub-agent · running in background · \d+s\n {2}└ ◆ Scan the logs · explorer · \d+s · 0 tok\n {4}└ ● scan logs\/app\.log\n/.test(
        live(),
      ),
    "background rows",
  )
  const committed = all().split("running in background")[0]!
  expect(committed).not.toContain("Scan the logs")
  // No turn runs: sub-agents working in the background bring no activity line.
  expect(live()).not.toContain("Esc interrupt")
  expect(live()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (working|running)/)
  finish()
  await child!.result()
  await bus.flush()
  await waitFor(() => !live().includes("running in background"), "the rows gone")
  // Its end is reported by its notice (the agent extension's), not by an end line of its own.
  expect(all()).not.toContain("◆ Scan the logs ✓")
  terminal.send("\x03")
  await exited
})

test("a compact spawn group shows as one line with its owner's status, not a row per member", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const reply = (req: { messages: { role: string; content: unknown }[] }) => {
    const task = JSON.stringify(req.messages[0]?.content)
    const answered = req.messages.at(-1)?.role === "toolResult"
    if (task.includes("step"))
      return answered ? { text: "step done" } : { toolCalls: [{ name: "hold", args: {} }] }
    return answered ? { text: "running it" } : { toolCalls: [{ name: "flow", args: {} }] }
  }
  const { terminal, live, all, shows, idle, exited, agent, bus } = await setup(
    [reply, reply, reply, reply, reply, reply, reply, reply],
    { cols: 90, tree: true },
  )
  let group: SpawnGroup | undefined
  // Members wait here until the test has seen the line.
  agent.tools.register(
    defineTool({
      name: "hold",
      ...parallel,
      execute: async () => {
        await gate
        return textResult("held")
      },
    }),
    "test",
  )
  agent.tools.register(
    defineTool({
      name: "flow",
      description: "",
      parameters: {},
      execute: async (_p, ctx) => {
        group = ctx.session!.createGroup!({ name: "workflow demo", compact: true })
        group.setStatus("Explore · 0/3 agents")
        const kids = ["Scan api", "Scan core", "Scan tui"].map((title) =>
          group!.spawn({ role: "explorer", title, prompt: `step ${title}` }),
        )
        void Promise.all(kids.map((k) => k.result())).then(() => group!.end())
        return textResult("Started in the background")
      },
    }),
    "test",
  )
  terminal.send("go\r")
  await shows("running it")
  await idle()
  await waitFor(
    () =>
      /● flow · 3 sub-agents · running in background · \d+s\n {2}└ ◆ workflow demo · Explore · 0\/3 agents\n/.test(
        live(),
      ),
    "one line for the group",
  )
  expect(live()).not.toContain("Scan api")
  group!.setStatus("Verify · 2/3 agents")
  await waitFor(() => live().includes("◆ workflow demo · Verify · 2/3 agents"), "the new status")
  release()
  await group!.ended()
  await bus.flush()
  await waitFor(() => !live().includes("workflow demo"), "the line gone")
  // Its members never get lines of their own.
  expect(all()).not.toContain("Scan core")
  terminal.send("\x03")
  await exited
})
