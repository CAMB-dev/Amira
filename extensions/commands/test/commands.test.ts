import { expect, spyOn, test } from "bun:test"
import type {
  AssistantMessage,
  EventMap,
  ReasoningEffort,
  SessionControl,
  SessionInfo,
  UserMessage,
} from "@amira/api"
import { createAi, createMockDialect } from "../../../packages/ai/src/index.ts"
import {
  Agent,
  CommandHost,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  ToolRegistry,
} from "../../../packages/core/src/index.ts"
import commandsExtension, {
  ago,
  cacheHitRate,
  contextReport,
  costByModel,
  costReport,
  estimateTokens,
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
    supportsThinking: false,
    busy: false,
    shell: "auto",
  }
  const tools = [
    {
      name: "bash",
      description: "",
      source: "builtin:tools",
      exposure: "active" as const,
      traits: { shell: "bash" as const },
      enabled: true,
    },
    {
      name: "read",
      description: "",
      source: "builtin:tools",
      exposure: "active" as const,
      traits: { readOnly: true, writesFiles: false as const },
      enabled: true,
    },
  ]
  const control: SessionControl = {
    info: () => info,
    trace: async () => [],
    messages: () => [],
    replies: () => [],
    subagents: () => [],
    subagentMessages: () => undefined,
    stopSubagent: () => false,
    messageSubagent: () => false,
    pauseSubagent: () => false,
    resumeSubagent: () => false,
    models: () => ["deepseek/deepseek-flash", "deepseek/deepseek-pro", "openai/gpt-5"],
    setModel: (ref) => {
      if (!ref.includes("/")) throw new Error(`unknown model "${ref}"`)
      const [provider, model] = ref.split("/") as [string, string]
      info = { ...info, model: { provider, model } }
    },
    setThinking: (level) => {
      calls.push(`setThinking ${level ?? "default"}`)
      info = { ...info, thinkingLevel: level, thinking: info.supportsThinking ? level : undefined }
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
  workspaceReady = true,
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
  // This harness has no workspace provider. Publish its empty result instead of waiting
  // two seconds for one on every /status; tests can still publish their own git facts.
  if (workspaceReady) {
    const { id, cwd } = control.info()
    bus.emit("workspace.changed", { cwd }, { sessionId: id })
    await bus.flush()
  }
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
  const requests: EventMap["ui.request"][] = []
  bus.subscribe(
    (e) => {
      if (e.type !== "ui.request") return
      requests.push(e.data)
      asked.push(e.data.kind === "select" ? `${e.data.title}: ${e.data.options.join(" | ")}` : e.data.title)
      const a = answers.shift()
      if (a === undefined) ext.ui.cancel(e.data.requestId)
      else ext.ui.respond(e.data.requestId, a)
    },
    { types: ["ui.request"] },
  )
  const run = async (line: string, frontend: "tui" | "rpc" | "print" = "tui") => {
    const r = await host.run(line, { frontend })
    return { ...r, text: r.output.join("\n") }
  }
  return { host, run, calls, asked, requests, bus, ext }
}

test("every built-in command is registered with a description", async () => {
  const { host } = await setup()
  expect(host.list().map((c) => c.name)).toEqual([
    "clear",
    "compact",
    "context",
    "cost",
    "ext",
    "fork",
    "help",
    "model",
    "permissions",
    "provider",
    "prune",
    "quit",
    "reload",
    "rename",
    "resume",
    "rewind",
    "rewind-prune",
    "shell",
    "status",
    "thinking",
    "tools",
  ])
  expect(host.list().every((c) => c.description.length > 0)).toBe(true)
})

test("/rewind opens the frontend's rewind picker, and needs one", async () => {
  const messages: UserMessage[] = [{ role: "user", content: [{ type: "text", text: "a request" }] }]
  const rewinds: number[] = []
  const { host, requests } = await setup({
    messages: () => messages,
    rewind: async (i) => void rewinds.push(i),
  })
  let opened = 0
  const shown = await host.run("/rewind", { frontend: "tui", openRewind: () => ++opened > 0 })
  expect(shown.ok).toBe(true)
  expect(opened).toBe(1)
  // The picker itself is the frontend's: the command asks nothing and rewinds nothing.
  expect(requests).toEqual([])
  expect(rewinds).toEqual([])

  const busy = await host.run("/rewind", { frontend: "tui", openRewind: () => false })
  expect(busy.ok).toBe(false)
  expect(busy.error).toContain("Cannot open the rewind picker now")
  const rpc = await host.run("/rewind", { frontend: "rpc" })
  expect(rpc.ok).toBe(false)
  expect(rpc.error).toContain("/rewind <n> [--yes]")
  expect(rewinds).toEqual([])
})

test("/rewind n confirms its plan, and --yes is required without a responder", async () => {
  const messages: UserMessage[] = [
    { role: "user", content: [{ type: "text", text: "older" }] },
    { role: "user", content: [{ type: "text", text: "newer" }] },
  ]
  const rewinds: { index: number; restoreFiles?: boolean }[] = []
  let plan = {
    owner: "core",
    enabled: true,
    restored: 3,
    removed: 1,
    conflicts: ["/work/stale"],
    note: "Resolve conflicts before restoring.",
  }
  const control: Partial<SessionControl> = {
    messages: () => messages,
    planRewind: () => plan,
    rewind: async (index, options) => void rewinds.push({ index, ...options }),
  }
  const interactive = await setup(control, [true, false])
  expect((await interactive.run("/rewind 2")).text).toContain("2nd most recent")
  expect(rewinds).toEqual([{ index: 0, restoreFiles: true }])
  expect(interactive.requests[0]).toMatchObject({
    kind: "confirm",
    title: "Rewind to before the 2nd most recent user message?",
  })
  const preview = (interactive.requests[0] as Extract<EventMap["ui.request"], { kind: "confirm" }>).message
  expect(preview).toContain("Message: older")
  expect(preview).toContain("This removes 2 messages")
  expect(preview).toContain("Files: 3 restored, 1 removed.")
  expect(preview).toContain("refused until they are resolved")
  expect(preview).toContain("/work/stale")
  // Declined: nothing changes.
  expect((await interactive.run("/rewind 1")).text).toContain("Rewind cancelled.")
  expect(rewinds).toHaveLength(1)

  const headless = await setup(control)
  expect((await headless.run("/rewind 1", "print")).error).toContain("--yes")
  expect(rewinds).toHaveLength(1)
  // Nothing captured to restore: conversation only, as the picker would default to.
  plan = { ...plan, restored: 0, removed: 0, conflicts: [] }
  const yes = await headless.run("/rewind 1 --yes", "print")
  expect(yes.ok).toBe(true)
  expect(yes.text).toContain("Files were not restored.")
  expect(rewinds.at(-1)).toEqual({ index: 1, restoreFiles: false })
  expect(headless.requests).toEqual([])

  for (const bad of ["/rewind 0", "/rewind two", "/rewind 1 --force", "/rewind --yes"])
    expect((await headless.run(bad, "print")).error).toContain("Usage: /rewind <n> [--yes]")
  expect((await headless.run("/rewind 3 --yes", "print")).error).toContain("only 2 user messages")
  expect(rewinds).toHaveLength(2)
})

test("/help lists every command with its argument hint", async () => {
  const { run } = await setup()
  const { text } = await run("/help")
  expect(text).toContain("/model [provider/model]")
  expect(text).toContain("/provider [add|edit|remove|key]")
  expect(text).toContain("/provider add picks a catalog vendor or Custom (choose a protocol).")
  expect(text).toContain("/provider add <vendor|protocol> skips the picker")
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
    /Aliases from settings \(commandAliases\):\n\/ds\s+→ \/model deepseek\/deepseek-flash\n\/m\s+→ \/model\n\nProviders:/,
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

test("/status finishes with unknown git facts when no workspace provider is loaded", async () => {
  const { run, ext } = await setup({}, [], undefined, false)
  const started = performance.now()
  try {
    expect((await run("/status")).text).toMatch(/Git\s+unknown/)
    expect(performance.now() - started).toBeLessThan(3000)
  } finally {
    ext.unloadAll()
  }
})

test("/status right at startup waits briefly for the git facts", async () => {
  const { run, bus } = await setup({}, [], undefined, false)
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

function thinkingControl(thinkingLevel?: ReasoningEffort, supportsThinking = true) {
  let info: SessionInfo = {
    ...fakeControl().control.info(),
    thinkingLevel,
    thinking: supportsThinking ? thinkingLevel : undefined,
    supportsThinking,
  }
  const changes: (ReasoningEffort | undefined)[] = []
  const control: Partial<SessionControl> = {
    info: () => info,
    setThinking: (level) => {
      changes.push(level)
      info = { ...info, thinkingLevel: level, thinking: info.supportsThinking ? level : undefined }
    },
    setModel: (ref) => {
      const [provider, model] = ref.split("/") as [string, string]
      const supportsThinking = model !== "deepseek-flash"
      info = {
        ...info,
        model: { provider, model },
        supportsThinking,
        thinking: supportsThinking ? info.thinkingLevel : undefined,
      }
    },
  }
  return { control, changes, info: () => info }
}

test("/thinking accepts every effort and default, with no picker", async () => {
  const session = thinkingControl()
  const { run, requests } = await setup(session.control)
  for (const level of ["low", "medium", "high", "xhigh", "max", "default"]) {
    expect(await run(`/thinking ${level}`)).toMatchObject({
      ok: true,
      text: `Thinking: ${level === "default" ? "default (not sent)" : level}`,
    })
  }
  expect(session.changes).toEqual(["low", "medium", "high", "xhigh", "max", undefined])
  expect(session.info().thinkingLevel).toBeUndefined()
  expect(requests).toEqual([])
})

test("/thinking rejects invalid arguments and completes all choices, marking the current one", async () => {
  const session = thinkingControl("high")
  const { run, host } = await setup(session.control)
  for (const value of ["off", "HIGH", "high extra"]) {
    expect(await run(`/thinking ${value}`)).toMatchObject({
      ok: false,
      error: "Choose thinking effort: low, medium, high, xhigh, max, default",
    })
  }
  expect(session.changes).toEqual([])
  const completion = await host.complete("/thinking ")
  expect(completion.candidates.map((c) => c.value)).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "default",
  ])
  expect(completion.candidates.find((c) => c.value === "high")?.description).toBe("current")
  expect(completion.candidates.find((c) => c.value === "default")?.description).toBe("not sent")
})

test("/thinking picker marks and preselects the effective choice even for a non-thinking model", async () => {
  const session = thinkingControl("xhigh", false)
  const { run, requests } = await setup(session.control, ["medium"])
  const result = await run("/thinking")
  expect(requests[0]).toMatchObject({
    kind: "select",
    options: ["low", "medium", "high", "xhigh (current)", "max", "default (not sent)"],
    initial: "xhigh (current)",
  })
  expect(result.text).toContain("Thinking: medium")
  expect(result.text).toContain("doesn't think; choice kept for a thinking model")
  expect(session.changes).toEqual(["medium"])
  expect(session.info().thinking).toBeUndefined()
  expect(session.info().thinkingLevel).toBe("medium")
})

test("/thinking picker preselects default, and cancellation keeps the choice", async () => {
  const session = thinkingControl()
  const { run, requests, host } = await setup(session.control, [undefined])
  expect((await run("/thinking")).ok).toBe(true)
  expect(requests[0]).toMatchObject({ initial: "default (not sent) (current)" })
  expect(session.changes).toEqual([])
  expect((await host.complete("/thinking ")).candidates.find((c) => c.value === "default")?.description).toBe(
    "current; not sent",
  )
})

test("/thinking picker can select default and reports the result outside the TUI", async () => {
  const session = thinkingControl("max")
  const { run } = await setup(session.control, ["default (not sent)"])
  expect(await run("/thinking", "rpc")).toMatchObject({ ok: true, text: "Thinking: default (not sent)" })
  expect(session.changes).toEqual([undefined])
})

test("/model interactive selection asks for effort using the newly selected model's capability", async () => {
  const session = thinkingControl("high", false)
  const { run, requests } = await setup(session.control, ["openai/gpt-5", "max"])
  expect(await run("/model")).toMatchObject({ ok: true, text: "" })
  expect(requests).toHaveLength(2)
  expect(requests[1]).toMatchObject({ kind: "select", title: "Thinking effort", initial: "high (current)" })
  expect(session.info().model).toEqual({ provider: "openai", model: "gpt-5" })
  expect(session.changes).toEqual(["max"])
})

test("/model cancellation never opens the effort step", async () => {
  const session = thinkingControl("high")
  const before = session.info().model
  const { run, requests } = await setup(session.control, [undefined])
  expect((await run("/model")).ok).toBe(true)
  expect(requests).toHaveLength(1)
  expect(session.info().model).toEqual(before)
  expect(session.changes).toEqual([])
})

test("/model effort cancellation keeps the new model and the effective choice", async () => {
  const session = thinkingControl("xhigh", false)
  const { run, requests } = await setup(session.control, ["openai/gpt-5", undefined])
  expect((await run("/model")).ok).toBe(true)
  expect(requests).toHaveLength(2)
  expect(session.info()).toMatchObject({
    model: { provider: "openai", model: "gpt-5" },
    thinkingLevel: "xhigh",
  })
  expect(session.changes).toEqual([])
})

test("/model effort step preselects default and can return a chosen effort in RPC", async () => {
  const session = thinkingControl()
  const { run, requests } = await setup(session.control, ["openai/gpt-5", "low"])
  expect(await run("/model", "rpc")).toMatchObject({
    ok: true,
    text: "Model: openai/gpt-5\nThinking: low",
  })
  expect(requests[1]).toMatchObject({ initial: "default (not sent) (current)" })
  expect(session.changes).toEqual(["low"])
})

test("/model direct argument and non-thinking selection never ask for effort", async () => {
  const session = thinkingControl("high")
  const { run, requests } = await setup(session.control, ["deepseek/deepseek-flash"])
  expect((await run("/model openai/gpt-5")).ok).toBe(true)
  expect(requests).toEqual([])
  expect((await run("/model")).ok).toBe(true)
  expect(requests).toHaveLength(1)
  expect(session.changes).toEqual([])
  expect(session.info().thinkingLevel).toBe("high")
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

test.each([undefined, "low", "medium", "high", "xhigh", "max"] as const)(
  "/status shows thinking only when configured (%s)",
  async (thinking) => {
    const { control } = fakeControl()
    const { run, bus } = await setup({
      info: () => ({ ...control.info(), ...(thinking ? { thinking } : {}) }),
    })
    bus.emit("workspace.changed", { cwd: "/work" }, { sessionId: "s1" })
    await bus.flush()
    const { text } = await run("/status")
    if (thinking) expect(text).toMatch(new RegExp(`Thinking\\s+${thinking}`))
    else expect(text).not.toMatch(/^Thinking\s/m)
  },
)

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
  expect(text).toMatch(/Speed\s+reply \d+(\.\d)? tok\/s in this session's last reply/)
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

test("/status tracks thinking and text separately and clears an unmeasurable last reply", async () => {
  const { run, bus } = await setup()
  const meta = { sessionId: "s1" }
  const model = { provider: "mock", model: "m" }
  bus.emit("workspace.changed", { cwd: "/work" }, meta)
  const clock = spyOn(Date, "now")
  const end = {
    ...reply("mock/m", 0, 100),
    content: [
      { type: "thinking" as const, text: "x".repeat(320) },
      { type: "text" as const, text: "answer" },
    ],
    usage: { input: 0, output: 100, reasoning: 80, cacheRead: 0, cacheWrite: 0 },
  }
  try {
    clock.mockReturnValue(0)
    bus.emit("message.start", { model }, meta)
    await bus.flush()
    clock.mockReturnValue(100)
    bus.emit("message.delta", { kind: "text", text: "" }, meta)
    await bus.flush()
    clock.mockReturnValue(1000)
    bus.emit("message.delta", { kind: "thinking", text: "hmm" }, meta)
    await bus.flush()
    clock.mockReturnValue(5000)
    bus.emit("message.delta", { kind: "text", text: "answer" }, meta)
    await bus.flush()
    clock.mockReturnValue(6000)
    bus.emit("message.end", { message: end }, meta)
  } finally {
    clock.mockRestore()
  }
  await bus.flush()
  expect((await run("/status")).text).toContain("reply 20 tok/s · thinking 20 tok/s")

  const shortClock = spyOn(Date, "now")
  try {
    shortClock.mockReturnValue(7000)
    bus.emit("message.start", { model }, meta)
    await bus.flush()
    bus.emit("message.delta", { kind: "text", text: "hi" }, meta)
    await bus.flush()
    shortClock.mockReturnValue(7100)
    bus.emit("message.end", { message: reply("mock/m", 0, 2) }, meta)
  } finally {
    shortClock.mockRestore()
  }
  await bus.flush()
  expect((await run("/status")).text).toMatch(/Speed\s+not measured yet/)

  // A reply that only calls a tool is timed from its first arguments.
  const toolClock = spyOn(Date, "now")
  const call: AssistantMessage = {
    ...reply("mock/m", 0, 50),
    content: [{ type: "toolCall", id: "t", name: "read", args: {} }],
  }
  try {
    toolClock.mockReturnValue(8000)
    bus.emit("message.start", { model }, meta)
    await bus.flush()
    toolClock.mockReturnValue(8500)
    bus.emit("message.delta", { kind: "toolCall", toolCallId: "t", argsDelta: "{}" }, meta)
    await bus.flush()
    toolClock.mockReturnValue(9000)
    bus.emit("message.end", { message: call }, meta)
  } finally {
    toolClock.mockRestore()
  }
  await bus.flush()
  expect((await run("/status")).text).toMatch(/Speed\s+reply 100 tok\/s in this session's last reply/)
})

test("/clear starts a new session; /resume switches, or asks among the other sessions", async () => {
  const { run, calls, asked, host } = await setup({}, [undefined])
  // The TUI names the new session in its boundary line; elsewhere the command says it.
  expect((await run("/clear")).text).toBe("")
  expect((await host.run("/clear", { frontend: "print" })).output).toEqual([
    expect.stringMatching(/^Started a new session \(s\d+\)\.$/),
  ])
  expect((await run("/resume abc")).text).toBe("")
  // The picker leaves out the current session (now abc); cancelling lists the recent ones.
  const listed = await run("/resume")
  expect(asked[0]).toContain("s1  just now  2 msgs  current")
  expect(asked[0]).toContain("old  3h ago  8 msgs  fix the build")
  expect(listed.text).toContain("Recent sessions:")
  expect(calls).toEqual(["newSession", "newSession", "resume abc"])
})

test("/resume with a picked session resumes its id", async () => {
  const { run, calls } = await setup({}, ["old  3h ago  8 msgs  fix the build"])
  expect((await run("/resume")).text).toBe("")
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

test("/resume reports when the picked session is open elsewhere instead of deleting it", async () => {
  const now = Date.now()
  const old = {
    id: "old",
    updatedAt: now,
    title: "Database repair",
    firstUserText: "hello",
    searchText: "hello",
    messageCount: 2,
  }
  const { run } = await setup(
    {
      sessions: () => [old, { ...old, id: "s1" }],
      deleteSession: async () => {
        throw new Error(
          "cannot delete session old: it is open in another Amira process (pid 42); close that process first",
        )
      },
    },
    [{ option: sessionLabel(old, now), key: "d" }, true],
  )
  const result = await run("/resume")
  expect(result.ok).toBe(false)
  expect(result.error).toContain("open in another Amira process")
})

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

for (const frontend of ["print", "rpc"] as const) {
  test(`/resume keeps its notice in ${frontend} mode`, async () => {
    const { host, calls } = await setup()
    expect((await host.run("/resume abc", { frontend })).output).toEqual([
      "Resumed session abc (0 messages).",
    ])
    expect(calls).toEqual(["resume abc"])
  })
}

test("/compact passes its instructions; the compact events report the outcome", async () => {
  const { run, calls } = await setup()
  expect((await run("/compact keep the API notes")).text).toBe("")
  await run("/compact")
  expect(calls).toEqual(["compact keep the API notes", "compact "])
})

test("/permissions lists the mode and the rules with their sources; /status counts them", async () => {
  const none = await setup()
  expect((await none.run("/permissions")).text).toBe("This session has no permission policy.")
  expect((await none.run("/status")).text).not.toContain("Permissions")
  const { run } = await setup({
    info: () => ({
      id: "s1",
      cwd: "/work",
      model: { provider: "deepseek", model: "deepseek-flash" },
      contextWindow: 128000,
      busy: false,
      shell: "auto",
      permissions: { mode: "edits", rules: 2 },
    }),
    permissions: () => ({
      mode: "edits",
      modeSource: "/home/u/.amira/settings.json",
      rules: [
        { command: ["git", "push"], decision: "ask", reason: "review first", scope: "user", file: "u.json" },
        { command: ["rm"], decision: "deny", scope: "project", file: "p.json" },
      ],
      warnings: ['p.json: 1 "allow" rule is ignored; this project is not trusted'],
    }),
  })
  expect((await run("/status")).text).toMatch(/Permissions\s+edits mode; 2 command rules/)
  const text = (await run("/permissions")).text
  expect(text).toContain("Mode: edits (from /home/u/.amira/settings.json)")
  expect(text).toMatch(/ask\s+git push\s+user u\.json — review first/)
  expect(text).toMatch(/deny\s+rm\s+project p\.json/)
  expect(text).toContain("Shell commands can still change these files")
  expect(text).toContain("this project is not trusted")
})

test("/prune reports artifacts by reference and deletes only the scope asked for", async () => {
  const pruned: string[] = []
  const { run, host } = await setup({
    artifacts: {
      usage: () => ({
        active: 3,
        inactive: 2,
        unused: 1,
        pruned: 0,
        bytes: 3 * 1024 * 1024,
        quotaBytes: 256 * 1024 * 1024,
        dir: "/s/x.assets/outputs",
        groups: [
          {
            id: "s1",
            label: "This session",
            active: 2,
            inactive: 1,
            unused: 0,
            pruned: 0,
            bytes: 2 * 1024 * 1024,
            quotaBytes: 256 * 1024 * 1024,
            dir: "/s/x.assets/outputs",
          },
          {
            id: "child",
            label: "Sub-agent: explorer (child)",
            active: 1,
            inactive: 1,
            unused: 1,
            pruned: 0,
            bytes: 1024 * 1024,
            quotaBytes: 256 * 1024 * 1024,
            dir: "/s/subagents/child.assets/outputs",
            protected: true,
          },
        ],
      }),
      prune: async (scope) => {
        pruned.push(scope)
        return { removed: scope === "unused" ? 1 : 0, bytes: 1024 * 1024 }
      },
    },
  })
  const report = (await run("/prune")).text
  expect(report).toContain("3.0 MB of the 256 MB quota in /s/x.assets/outputs")
  expect(report).toMatch(/Active\s+3/)
  expect(report).toMatch(/Unused\s+1/)
  expect(report).toContain("Groups:")
  expect(report).toContain("Sub-agent: explorer (child) (protected)")
  // Showing deletes nothing.
  expect(pruned).toEqual([])
  expect((await run("/prune unused")).text).toBe(
    "Deleted 1 artifact (1.0 MB). Reading one now says it was pruned.",
  )
  expect((await run("/prune inactive")).text).toBe("Nothing to delete.")
  expect((await run("/prune everything")).error).toBe("usage: /prune [unused|inactive|all]")
  expect(pruned).toEqual(["unused", "inactive"])
  expect((await host.complete("/prune ")).candidates.map((c) => c.value)).toEqual([
    "unused",
    "inactive",
    "all",
  ])
  const none = await setup()
  expect((await none.run("/prune")).error).toBe("this session keeps no artifacts")
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

test("/cost and /status keep unpriced searches unknown after priced replies", async () => {
  for (const counted of [true, false]) {
    const search = reply("anthropic/claude", 100, 20)
    search.content = [{ type: "serverTool", id: "s", name: "web_search", input: {}, status: "done" }]
    if (counted) search.usage!.webSearchRequests = 1
    const replies = [reply("anthropic/claude", 100, 20, 0.01), search, reply("openai/gpt", 100, 20, 0.02)]
    const rows = costByModel(replies)
    expect(rows[0]!.cost).toBeUndefined()
    expect(rows[0]!.usage.webSearchRequests).toBe(counted ? 1 : undefined)
    const { run } = await setup({ replies: () => replies })
    expect((await run("/cost")).text).toMatch(/total\s+in 300\s+out 60\s+price unknown/)
    expect((await run("/status")).text).toMatch(/Cost\s+unknown/)
  }
})

test("/context estimates opaque cited text and unsigned search sources", () => {
  const message = reply("anthropic/claude", 10, 10)
  message.content = [
    {
      type: "text",
      text: "Answer",
      signature: { dialect: "anthropic-messages", kind: "webSearch", value: "encrypted-index".repeat(100) },
    },
    {
      type: "serverTool",
      id: "s",
      name: "web_search",
      input: {},
      status: "done",
      sources: [{ url: `https://source.test/${"path/".repeat(100)}` }],
    },
  ]
  expect(estimateTokens(message)).toBeGreaterThan(450)
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
