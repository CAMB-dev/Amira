import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { AssistantMessage, SessionControl, SessionInfo } from "@amira/api"
import { Agent, CommandHost, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import commandsExtension, {
  ago,
  cacheHitRate,
  contextReport,
  costReport,
  formatTokens,
  sessionLabel,
  table,
  tokensPerSecond,
} from "../src/index.ts"

test("speed is timed from the first delta; the cache rate is the share of prompt tokens from cache", () => {
  expect(tokensPerSecond(84, 1000, 3000)).toBe(42)
  expect(tokensPerSecond(10, 1000, 1100)).toBeUndefined()
  expect(tokensPerSecond(0, 1000, 5000)).toBeUndefined()
  expect(cacheHitRate(0, 0, 0)).toBeUndefined()
  expect(cacheHitRate(200, 800, 0)).toBe(0.8)
  expect(cacheHitRate(100, 0, 300)).toBe(0)
})

const reply = (model: string, input: number, output: number, cost?: number): AssistantMessage => {
  const [provider, id] = model.split("/") as [string, string]
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: { provider, model: id },
    usage: { input, output, cacheRead: 0, cacheWrite: 0, ...(cost !== undefined ? { cost } : {}) },
  }
}

/** A session control that records what commands asked of it. */
function fakeControl(over: Partial<SessionControl> = {}) {
  const calls: string[] = []
  let info: SessionInfo = {
    id: "s1",
    cwd: "/work",
    model: { provider: "deepseek", model: "deepseek-flash" },
    contextWindow: 128000,
    busy: false,
    shell: "auto",
  }
  const tools = [
    { name: "bash", description: "", source: "builtin:tools", exposure: "active" as const, enabled: true },
    { name: "read", description: "", source: "builtin:tools", exposure: "active" as const, enabled: true },
  ]
  const control: SessionControl = {
    info: () => info,
    messages: () => [],
    replies: () => [],
    subagents: () => [],
    subagentMessages: () => undefined,
    stopSubagent: () => false,
    models: () => ["deepseek/deepseek-flash", "deepseek/deepseek-pro", "openai/gpt-5"],
    setModel: (ref) => {
      if (!ref.includes("/")) throw new Error(`unknown model "${ref}"`)
      const [provider, model] = ref.split("/") as [string, string]
      info = { ...info, model: { provider, model } }
    },
    newSession: async () => {
      calls.push("newSession")
      info = { ...info, id: "s2" }
    },
    sessions: () => [
      { id: "s1", updatedAt: Date.now(), firstUserText: "current", messageCount: 2 },
      { id: "old", updatedAt: Date.now() - 3 * 3600_000, firstUserText: "fix the build", messageCount: 8 },
    ],
    resume: async (id) => {
      calls.push(`resume ${id}`)
      info = { ...info, id }
    },
    compact: async (instructions) => {
      calls.push(`compact ${instructions ?? ""}`)
      return false
    },
    send: async (text) => void calls.push(`send ${text}`),
    tools: () => tools,
    setToolEnabled: (name, enabled) => {
      const t = tools.find((x) => x.name === name)
      if (!t) throw new Error(`no tool named "${name}"`)
      t.enabled = enabled
    },
    setShell: (mode) => {
      info = { ...info, shell: mode }
      tools[0]!.enabled = mode !== "powershell"
    },
    providers: () => [
      { id: "deepseek", dialect: "openai-chat", baseUrl: "https://api.deepseek.com", hasKey: true },
      {
        id: "work",
        dialect: "openai-chat",
        baseUrl: "https://llm.example.com/v1",
        apiKeyEnv: "WORK_API_KEY",
        hasKey: false,
      },
    ],
    preview: async () => ({
      systemPrompt: "x".repeat(4000),
      tools: [{ name: "read", description: "reads", parameters: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "y".repeat(400) }] }],
    }),
    reloadExtensions: async () => {
      calls.push("reload")
      return undefined
    },
    ...over,
  }
  return { control, calls }
}

async function setup(
  over: Partial<SessionControl> = {},
  answers: (string | boolean | { option: string; key?: string } | undefined)[] = [],
  aliases?: Record<string, string>,
) {
  const bus = new EventBus()
  const ext = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  await ext.load(commandsExtension, "builtin:commands")
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/work", bus })
  const { control, calls } = fakeControl(over)
  const host = new CommandHost({
    registry: ext.commands,
    skills: ext.skills,
    bus,
    ui: ext.ui,
    control,
    agent,
    ...(aliases ? { aliases } : {}),
  })
  // Dialogs answer from the list, in order; undefined is "cancelled".
  const asked: string[] = []
  bus.subscribe(
    (e) => {
      if (e.type !== "ui.request") return
      asked.push(e.data.kind === "select" ? `${e.data.title}: ${e.data.options.join(" | ")}` : e.data.title)
      const a = answers.shift()
      if (a === undefined) ext.ui.cancel(e.data.requestId)
      else ext.ui.respond(e.data.requestId, a)
    },
    { types: ["ui.request"] },
  )
  const run = async (line: string) => {
    const r = await host.run(line, { frontend: "tui" })
    return { ...r, text: r.output.join("\n") }
  }
  return { host, run, calls, asked, bus, ext }
}

test("every built-in command is registered with a description", async () => {
  const { host } = await setup()
  expect(host.list().map((c) => c.name)).toEqual([
    "clear",
    "compact",
    "context",
    "cost",
    "fork",
    "help",
    "model",
    "provider",
    "quit",
    "reload",
    "rename",
    "resume",
    "shell",
    "status",
    "tools",
  ])
  expect(host.list().every((c) => c.description.length > 0)).toBe(true)
})

test("/help lists every command with its argument hint", async () => {
  const { run } = await setup()
  const { text } = await run("/help")
  expect(text).toContain("/model [provider/model]")
  expect(text).toMatch(/\/quit \(\/exit, \/q\)\s+Leave Amira/)
  expect(text).toMatch(/\/resume \(\/continue\) \[session id\]\s+Switch/)
  expect(text).not.toContain("Aliases from settings")
})

test("the built-in aliases run their commands", async () => {
  const { host, run } = await setup()
  expect(host.list().flatMap((c) => c.aliases.map((a) => `${a}→${c.name}`))).toEqual([
    "new→clear",
    "reset→clear",
    "usage→cost",
    "?→help",
    "h→help",
    "exit→quit",
    "q→quit",
    "continue→resume",
  ])
  expect(await run("/usage")).toMatchObject({ ok: true, command: "cost" })
  expect(await run("/?")).toMatchObject({ ok: true, command: "help" })
  expect((await run("/h")).text).toContain("Commands:")
  let quit = false
  expect(await host.run("/exit", { frontend: "tui", quit: () => (quit = true) })).toMatchObject({
    command: "quit",
  })
  expect(quit).toBe(true)
})

test("/help lists the settings aliases with what they run", async () => {
  const { run } = await setup({}, [], { ds: "model deepseek/deepseek-flash", m: "model", q: "status" })
  const { text } = await run("/help")
  // /q is a built-in alias, so the settings one is left out.
  expect(text).toMatch(
    /Aliases from settings \(commandAliases\):\n\/ds\s+→ \/model deepseek\/deepseek-flash\n\/m\s+→ \/model$/,
  )
  expect((await run("/ds")).text).toBe("Model: deepseek/deepseek-flash")
})

test("/help lists other extensions' commands in their own group, descriptions cut short", async () => {
  const { run, ext } = await setup()
  await ext.load((api) => {
    api.registerCommand({ name: "deploy", description: `Ship: ${"very long ".repeat(20)}`, run: () => {} })
  }, "my-ext")
  const { text } = await run("/help")
  expect(text.indexOf("Commands:")).toBeLessThan(text.indexOf("From my-ext:"))
  // Built-in commands from anywhere are Commands, not an internal id.
  expect(text).not.toContain("From builtin:")
  expect(text).toMatch(/\/deploy\s+Ship: very long.*…\n/)
  expect(text.split("\n").every((l) => l.length < 120)).toBe(true)
})

test("/help lists the skills in their own section, run with $", async () => {
  const { run, ext } = await setup({}, [], { ds: "model deepseek/deepseek-flash" })
  expect((await run("/help")).text).toContain("Skills: none found ($ runs a skill: $<name> [arguments]).")
  await ext.load((api) => {
    api.registerSkill({ name: "review-pr", description: "Review a pull request", run: () => {} })
    api.registerSkill({ name: "deploy", description: `Ship ${"very long ".repeat(20)}`, run: () => {} })
  }, "builtin:skills")
  const { text } = await run("/help")
  // Folded to a line: skills can be many, and typing $ lists them.
  expect(text).toMatch(
    /\n\nSkills: 2 skills · type \$ to list them; \$<name> \[arguments\] runs one\.\n\nAliases from settings/,
  )
  // Skills are not commands.
  expect(text).not.toContain("/deploy")
  expect(text).not.toContain("From builtin:skills")
})

test("/status right at startup waits briefly for the git facts", async () => {
  const { run, bus } = await setup()
  const status = run("/status")
  await Bun.sleep(20)
  bus.emit(
    "workspace.changed",
    { cwd: "/work", repoRoot: "/work", branch: "dev", isWorktree: true },
    { sessionId: "s1" },
  )
  expect((await status).text).toMatch(/Git\s+dev \(worktree\) in \/work/)
})

test("/model switches with an argument and asks without one", async () => {
  const { run, host, asked } = await setup({}, ["openai/gpt-5", undefined])
  expect((await run("/model deepseek/deepseek-pro")).text).toBe("Model: deepseek/deepseek-pro")
  // Picked in the TUI: the picker's echo says what was chosen, so nothing is printed again.
  expect((await run("/model")).text).toBe("")
  expect((await run("/status")).text).toContain("openai/gpt-5")
  expect(asked[0]).toContain("deepseek/deepseek-flash | deepseek/deepseek-pro | openai/gpt-5")
  // Cancelling the picker keeps the model and says how to pick one.
  expect((await run("/model")).text).toContain("Model: openai/gpt-5. Pass one")
  expect((await run("/model nonsense")).ok).toBe(false)
  const done = await host.complete("/model pro")
  expect(done.candidates.map((c) => c.value)).toEqual(["deepseek/deepseek-pro"])
})

test("/model without a model or anything to pick says what to do", async () => {
  const none = { provider: "", model: "" }
  const info = () => ({
    id: "s1",
    cwd: "/work",
    model: none,
    contextWindow: 1000,
    busy: false,
    shell: "auto" as const,
  })
  const empty = await setup({ info, models: () => [], providers: () => [] })
  expect((await empty.run("/model")).error).toBe("No providers configured — add one with /provider add")
  const unlisted = await setup({ info, models: () => [] })
  expect((await unlisted.run("/model")).error).toContain("No models to pick from")
  const some = await setup({ info }, [undefined])
  expect((await some.run("/model")).text).toBe("Model: (no model). Pass one to switch: /model provider/model")
  expect(some.asked[0]).toContain("Model (now (no model))")
  expect((await some.run("/status")).text).toContain("(no model)")
})

test("/status shows model, provider, session, context, cost, cwd and git", async () => {
  const { run, bus } = await setup({
    replies: () => [reply("deepseek/deepseek-flash", 1000, 100, 0.002)],
    info: () => ({
      id: "s1",
      cwd: "/work",
      model: { provider: "deepseek", model: "deepseek-flash" },
      contextWindow: 128000,
      contextTokens: 32000,
      busy: false,
      shell: "auto",
    }),
  })
  bus.emit("workspace.changed", { cwd: "/work", repoRoot: "/work", branch: "main" }, { sessionId: "s1" })
  await bus.flush()
  const { text } = await run("/status")
  expect(text).toMatch(/Model\s+deepseek\/deepseek-flash/)
  expect(text).toContain("deepseek (openai-chat, https://api.deepseek.com)")
  expect(text).toMatch(/Session\s+s1/)
  expect(text).toContain("32k of 128k tokens (25%)")
  expect(text).toMatch(/Cost\s+\$0\.0020 \(this session; no sub-agents\)/)
  expect(text).toMatch(/Output\s+100 tokens written by this session's replies/)
  expect(text).toMatch(/Cache\s+0% of this session's prompt tokens read from the cache/)
  expect(text).toMatch(/Speed\s+not measured yet/)
  expect(text).toMatch(/Directory\s+\/work/)
  expect(text).toMatch(/Git\s+main in \/work$/m)
  // Where the window came from is unknown here: the size alone.
  expect(text).toMatch(/Window\s+128k$/m)
})

test("/status says where the context window came from, and when it is only a guess", async () => {
  const windowRow = async (contextWindow: number, source?: SessionInfo["contextWindowSource"]) => {
    const { run, bus } = await setup({
      info: () => ({
        id: "s1",
        cwd: "/work",
        model: { provider: "deepseek", model: "deepseek-flash" },
        contextWindow,
        ...(source ? { contextWindowSource: source } : {}),
        busy: false,
        shell: "auto",
      }),
    })
    bus.emit("workspace.changed", { cwd: "/work" }, { sessionId: "s1" })
    await bus.flush()
    return (await run("/status")).text.split("\n").find((l) => l.startsWith("Window"))
  }
  expect(await windowRow(128_000, "default")).toMatch(
    /^Window\s+128k \(default guess — set contextWindow for this model\)$/,
  )
  expect(await windowRow(1_050_000, "catalog")).toMatch(/^Window\s+1\.1M \(from the model catalog\)$/)
  expect(await windowRow(256_000, "settings")).toMatch(/^Window\s+256k \(your settings\)$/)
})

test("/status names the scope of each number: the session's output, cache and speed, the tree's cost", async () => {
  const cached: AssistantMessage = {
    ...reply("deepseek/deepseek-flash", 200, 300, 0.01),
    usage: { input: 200, output: 300, cacheRead: 800, cacheWrite: 0, cost: 0.01 },
  }
  const child = {
    id: "c1",
    parentSessionId: "s1",
    depth: 1,
    role: "agent",
    title: "x",
    task: "x",
    status: "done" as const,
    usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.004 },
  }
  const { run, bus } = await setup({ replies: () => [cached], subagents: () => [child] })
  bus.emit(
    "workspace.changed",
    { cwd: "/work", repoRoot: "/work", branch: "main", dirty: true },
    { sessionId: "s1" },
  )
  const meta = { sessionId: "s1" }
  const model = { provider: "deepseek", model: "deepseek-flash" }
  bus.emit("message.start", { model }, meta)
  bus.emit("message.delta", { kind: "text", text: "a" }, meta)
  await Bun.sleep(250)
  bus.emit("message.end", { message: cached }, meta)
  await bus.flush()
  const { text } = await run("/status")
  expect(text).toMatch(/Output\s+300 tokens written by this session's replies/)
  expect(text).toMatch(/Cache\s+80% of this session's prompt tokens read from the cache/)
  expect(text).toMatch(/Speed\s+\d+(\.\d)? tokens\/s in this session's last reply/)
  // The sub-agents' replies count in the cost the status shows; this session's own is named too.
  expect(text).toMatch(/Cost\s+\$0\.014 with sub-agents; this session alone \$0\.010/)
  expect(text).toMatch(/Git\s+main in \/work, with uncommitted changes/)
})

test("/status names only the session's cost when it had no sub-agents, and a sub-agent's speed is not its own", async () => {
  const { run, bus } = await setup({ replies: () => [reply("deepseek/deepseek-flash", 1000, 100, 0.042)] })
  const child = { sessionId: "c1", parentSessionId: "s1" }
  const model = { provider: "deepseek", model: "deepseek-flash" }
  bus.emit("message.start", { model }, child)
  bus.emit("message.delta", { kind: "text", text: "a" }, child)
  await Bun.sleep(250)
  bus.emit("message.end", { message: reply("deepseek/deepseek-flash", 10, 100) }, child)
  await bus.flush()
  const { text } = await run("/status")
  expect(text).toMatch(/Cost\s+\$0\.042 \(this session; no sub-agents\)/)
  expect(text).toMatch(/Speed\s+not measured yet/)
})

test("/clear starts a new session; /resume switches, or asks among the other sessions", async () => {
  const { run, calls, asked, host } = await setup({}, [undefined])
  // The TUI names the new session in its boundary line; elsewhere the command says it.
  expect((await run("/clear")).text).toBe("")
  expect((await host.run("/clear", { frontend: "print" })).output).toEqual([
    expect.stringMatching(/^Started a new session \(s\d+\)\.$/),
  ])
  expect((await run("/resume abc")).text).toContain("Resumed session abc")
  // The picker leaves out the current session (now abc); cancelling lists the recent ones.
  const listed = await run("/resume")
  expect(asked[0]).toContain("s1  just now  2 msgs  current")
  expect(asked[0]).toContain("old  3h ago  8 msgs  fix the build")
  expect(listed.text).toContain("Recent sessions:")
  expect(calls).toEqual(["newSession", "newSession", "resume abc"])
})

test("/resume with a picked session resumes its id", async () => {
  const { run, calls } = await setup({}, ["old  3h ago  8 msgs  fix the build"])
  await run("/resume")
  expect(calls).toEqual(["resume old"])
})

for (const confirmed of [true, false]) {
  test(`/resume confirms deletion (${confirmed}) and never offers the current session`, async () => {
    const now = Date.now()
    const old = {
      id: "old",
      updatedAt: now,
      title: "Database repair",
      firstUserText: "hello",
      searchText: "later assistant: 数据库连接",
      messageCount: 4,
    }
    let stored = [old, { ...old, id: "s1", title: "Current session" }]
    const removed: string[] = []
    const { run, asked, bus } = await setup(
      {
        sessions: () => stored,
        deleteSession: async (id) => {
          removed.push(id)
          stored = stored.filter((s) => s.id !== id)
        },
      },
      [{ option: sessionLabel(old, now), key: "d" }, confirmed, undefined],
    )
    const requests: any[] = []
    bus.subscribe(
      (e) => {
        if (e.type === "ui.request") requests.push(e.data)
      },
      { types: ["ui.request"] },
    )
    expect((await run("/resume")).ok).toBe(true)
    expect(asked[0]).not.toContain("Current session")
    expect(asked[1]).toBe("Delete this session?")
    expect(removed).toEqual(confirmed ? ["old"] : [])
    expect(requests[0].searchTexts).toEqual([old.searchText])
    expect(requests[0].sections[0].keys).toEqual([{ key: "d", label: "delete" }])
  })
}

test("/resume offers every session, including content beyond the old 50-session limit", async () => {
  const sessions = Array.from({ length: 110 }, (_, i) => ({
    id: `s_${i}`,
    updatedAt: Date.now(),
    title: `Topic ${i}`,
    firstUserText: "hi",
    searchText: `later answer ${i}`,
    messageCount: 2,
  }))
  const { run, bus } = await setup({ sessions: () => sessions })
  let options = 0
  bus.subscribe(
    (e) => {
      if (e.type === "ui.request" && e.data.kind === "select") options = e.data.options.length
    },
    { types: ["ui.request"] },
  )
  await run("/resume")
  expect(options).toBe(110)
})

test("/compact passes its instructions; the compact events report the outcome", async () => {
  const { run, calls } = await setup()
  expect((await run("/compact keep the API notes")).text).toBe("")
  await run("/compact")
  expect(calls).toEqual(["compact keep the API notes", "compact "])
})

test("/shell shows and sets the mode; /tools lists, disables and enables tools", async () => {
  const { run, host } = await setup()
  expect((await run("/shell")).text).toBe("Shell: auto (tools: bash)")
  expect((await run("/shell powershell")).text).toBe("Shell: powershell (tools: none)")
  await run("/shell auto")
  expect((await run("/tools disable read")).text).toBe("Disabled read for this session.")
  const list = (await run("/tools")).text
  expect(list).toContain("Tools (1 on, 1 off)")
  expect(list).toMatch(/off\s+read\s+builtin:tools/)
  expect((await run("/tools enable nope")).error).toBe('no tool named "nope"')
  expect((await run("/tools frobnicate x")).error).toContain("usage: /tools")
  expect((await host.complete("/tools ")).candidates.map((c) => c.value)).toEqual(["disable", "enable"])
  expect((await host.complete("/tools enable ")).candidates.map((c) => c.value)).toEqual(["enable read"])
  expect((await host.complete("/shell p")).candidates.map((c) => c.value)).toEqual(["powershell"])
})

test("/provider lists the configured providers", async () => {
  const { run } = await setup()
  const list = (await run("/provider")).text
  expect(list).toMatch(/\*\s+deepseek\s+openai-chat/)
  expect(list).toContain("no key (WORK_API_KEY)")
  expect((await run("/provider add")).error).toBe("this host cannot change providers")
})

test("/cost breaks the session cost down by model", async () => {
  const { run } = await setup({
    replies: () => [
      reply("deepseek/deepseek-flash", 1000, 100, 0.001),
      reply("deepseek/deepseek-flash", 2000, 200, 0.002),
      reply("openai/gpt-5", 500, 50),
    ],
  })
  const { text } = await run("/cost")
  expect(text).toMatch(/deepseek\/deepseek-flash\s+2 replies\s+in 3\.0k\s+out 300\s+\$0\.0030/)
  expect(text).toMatch(/openai\/gpt-5\s+1 reply\s+in 500\s+out 50\s+price unknown/)
  expect(text).toMatch(/total\s+in 3\.5k\s+out 350\s+\$0\.0030/)
  expect(costReport([])).toContain("No model replies")
})

test("/status and /cost count compactions and name their share", async () => {
  const usage = (input: number, output: number, cost: number) => ({
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    cost,
  })
  const { run } = await setup({
    replies: () => [reply("openai/gpt-5", 1000, 100, 0.01)],
    compactions: () => [
      { model: { provider: "openai", model: "gpt-5" }, usage: usage(4000, 300, 0.004), native: true },
      { model: { provider: "openai", model: "gpt-5" }, usage: usage(2000, 100, 0.002) },
    ],
  })
  const status = (await run("/status")).text
  expect(status).toMatch(/Cost\s+\$0\.016 \(this session; no sub-agents\); of which compaction \$0\.0060/)
  const cost = (await run("/cost")).text
  expect(cost).toMatch(/openai\/gpt-5 \(compaction\)\s+2 compactions\s+in 6\.0k\s+out 400\s+\$0\.0060/)
  expect(cost).toMatch(/total\s+in 7\.0k\s+out 500\s+\$0\.016/)
})

test("/context estimates the system prompt, tools and messages against the window", async () => {
  const { run } = await setup()
  const { text } = await run("/context")
  expect(text).toContain("Context window: 128k tokens")
  expect(text).toMatch(/System prompt\s+~1\.0k\s+1%/)
  expect(text).toMatch(/Tool definitions \(1\)\s+~\d+/)
  expect(text).toMatch(/User messages \(1\)\s+~104/)
  expect(contextReport({ systemPrompt: "", tools: [], messages: [] }, 1000, 250)).toContain(
    "Context: 250 of 1.0k tokens at the last reply (25%); 750 free.",
  )
})

test("/reload reloads extensions and /quit asks the frontend to leave", async () => {
  const { host, calls } = await setup()
  let quit = false
  await host.run("/quit", { frontend: "tui", quit: () => (quit = true) })
  const r = await host.run("/reload", { frontend: "tui" })
  expect(quit).toBe(true)
  expect(r.output).toEqual(["Reloaded extensions."])
  expect(calls).toEqual(["reload"])
})

test("formatting helpers", () => {
  expect(formatTokens(999)).toBe("999")
  expect(formatTokens(46_300)).toBe("46k")
  expect(
    table([
      ["a", "bb"],
      ["ccc", "d"],
    ]),
  ).toBe("a    bb\nccc  d")
  // Columns line up in terminal cells: a CJK character takes two.
  expect(
    table([
      ["名前", "x"],
      ["abc", "y"],
    ]),
  ).toBe("名前  x\nabc   y")
  expect(ago(0, 90_000)).toBe("1m ago")
  expect(sessionLabel({ id: "x", updatedAt: 0, firstUserText: "  a\n b ", messageCount: 3 }, 30_000)).toBe(
    "x  just now  3 msgs  a b",
  )
})

test("/help lists the frontend's common keys between the commands and the skills", async () => {
  const { host } = await setup()
  const r = await host.run("/help", {
    frontend: "tui",
    keys: () => [
      { keys: "Enter", description: "Send the message" },
      { keys: "Ctrl+R", description: "Search the prompt history" },
    ],
  })
  const text = r.output.join("\n")
  expect(text).toMatch(/\n\nKeys:\nEnter\s+Send the message\nCtrl\+R\s+Search the prompt history\n\nSkills:/)
  // A frontend without keys has no such part.
  const plain = await host.run("/help", { frontend: "rpc" })
  expect(plain.output.join("\n")).not.toContain("Keys:")
})
