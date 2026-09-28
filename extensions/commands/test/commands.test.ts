import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { AssistantMessage, SessionControl, SessionInfo } from "@amira/api"
import { Agent, CommandHost, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import commandsExtension, {
  ago,
  contextReport,
  costReport,
  formatTokens,
  sessionLabel,
  table,
} from "../src/index.ts"

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
        id: "openai",
        dialect: "openai-chat",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        hasKey: false,
      },
    ],
    providerPresets: () => ["deepseek", "openai", "ollama"],
    addProvider: async (id) => `Added provider "${id}".`,
    preview: async () => ({
      systemPrompt: "x".repeat(4000),
      tools: [{ name: "read", description: "reads", parameters: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "y".repeat(400) }] }],
    }),
    reloadExtensions: async () => void calls.push("reload"),
    ...over,
  }
  return { control, calls }
}

async function setup(
  over: Partial<SessionControl> = {},
  answers: (string | undefined)[] = [],
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
    "help",
    "model",
    "provider",
    "quit",
    "reload",
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
    api.registerCommand({ name: "deploy", description: `Skill: ${"very long ".repeat(20)}`, run: () => {} })
  }, "builtin:skills")
  const { text } = await run("/help")
  expect(text.indexOf("Commands:")).toBeLessThan(text.indexOf("From builtin:skills:"))
  expect(text).toMatch(/\/deploy\s+Skill: very long.*…\n?$/)
  expect(text.split("\n").every((l) => l.length < 120)).toBe(true)
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
  expect((await run("/model")).text).toBe("Model: openai/gpt-5")
  expect(asked[0]).toContain("deepseek/deepseek-flash | deepseek/deepseek-pro | openai/gpt-5")
  // Cancelling the picker keeps the model and says how to pick one.
  expect((await run("/model")).text).toContain("Model: openai/gpt-5. Pass one")
  expect((await run("/model nonsense")).ok).toBe(false)
  const done = await host.complete("/model pro")
  expect(done.candidates.map((c) => c.value)).toEqual(["deepseek/deepseek-pro"])
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
  expect(text).toMatch(/Cost\s+\$0\.0020/)
  expect(text).toMatch(/Directory\s+\/work/)
  expect(text).toMatch(/Git\s+main in \/work/)
})

test("/clear starts a new session; /resume switches, or asks among the other sessions", async () => {
  const { run, calls, asked } = await setup({}, [undefined])
  expect((await run("/clear")).text).toBe("Started a new session (s2).")
  expect((await run("/resume abc")).text).toContain("Resumed session abc")
  // The picker leaves out the current session (now abc); cancelling lists the recent ones.
  const listed = await run("/resume")
  expect(asked[0]).toContain("s1  just now  2 msgs  current")
  expect(asked[0]).toContain("old  3h ago  8 msgs  fix the build")
  expect(listed.text).toContain("Recent sessions:")
  expect(calls).toEqual(["newSession", "resume abc"])
})

test("/resume with a picked session resumes its id", async () => {
  const { run, calls } = await setup({}, ["old  3h ago  8 msgs  fix the build"])
  await run("/resume")
  expect(calls).toEqual(["resume old"])
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

test("/provider lists providers and adds presets", async () => {
  const { run, host } = await setup()
  const list = (await run("/provider")).text
  expect(list).toMatch(/\*\s+deepseek\s+openai-chat/)
  expect(list).toContain("no key (OPENAI_API_KEY)")
  expect((await run("/provider add ollama")).text).toBe('Added provider "ollama".')
  expect((await host.complete("/provider add ol")).candidates.map((c) => c.value)).toEqual(["add ollama"])
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
  expect(ago(0, 90_000)).toBe("1m ago")
  expect(sessionLabel({ id: "x", updatedAt: 0, firstUserText: "  a\n b ", messageCount: 3 }, 30_000)).toBe(
    "x  just now  3 msgs  a b",
  )
})
