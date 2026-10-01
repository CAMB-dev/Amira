import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep, NO_MODEL } from "@amira/ai"
import { defineTool, type Extension, textResult } from "@amira/api"
import { type Agent, SessionStore } from "@amira/core"
import commandsExtension from "../../../extensions/commands/src/index.ts"
import statusExtension from "../../../extensions/status/src/index.ts"
import { createCommandHost } from "../src/control.ts"
import { runPrint } from "../src/print.ts"
import { createSession } from "../src/session.ts"

const here = import.meta.dir
let savedHome: string | undefined

beforeAll(() => {
  savedHome = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = mkdtempSync(path.join(os.tmpdir(), "amira-control-home-"))
})

afterAll(() => {
  if (savedHome === undefined) delete process.env.AMIRA_HOME
  else process.env.AMIRA_HOME = savedHome
})

const shellTools: Extension = (api) => {
  for (const name of ["bash", "powershell", "read"]) {
    api.registerTool(
      defineTool({
        name,
        description: name,
        parameters: {},
        traits:
          name === "read"
            ? { readOnly: true, writesFiles: false as const }
            : { shell: name as "bash" | "powershell" },
        execute: async () => textResult(""),
      }),
    )
  }
}

/** A skill, run as $echo, that sends its arguments shown as the line typed. */
const echoSkill: Extension = (api) => {
  api.registerSkill({
    name: "echo",
    description: "Echo",
    run: (args, ctx) => ctx.session.send(`ECHO ${args}`, { display: { text: `$echo ${args}` } }),
  })
}

async function setup(
  steps: MockStep[] = [],
  opts: { platform?: string; loads?: string[]; aliases?: Record<string, string> } = {},
) {
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const counter: Extension = () => void opts.loads?.push("loaded")
  const session = await createSession({
    model: "mock/m",
    cwd: here,
    extensions: [],
    noBuiltins: false,
    ai,
    store: SessionStore.create({ cwd: here }),
    ...(opts.aliases ? { settings: { commandAliases: opts.aliases }, warnings: [] } : {}),
    builtins: async () => [
      { source: "builtin:commands", extension: commandsExtension },
      { source: "tools", extension: shellTools },
      { source: "counter", extension: counter },
      { source: "skills", extension: echoSkill },
    ],
  })
  const announced: [string, string][] = []
  const home = mkdtempSync(path.join(os.tmpdir(), "amira-control-user-"))
  const host = createCommandHost({
    session,
    cwd: here,
    home,
    disabled: ["read"],
    platform: opts.platform ?? "win32",
    ...(opts.aliases ? { aliases: opts.aliases } : {}),
    announce: (a: Agent, reason) => void announced.push([reason, a.sessionId]),
  })
  const run = async (line: string) => (await host.run(line, { frontend: "print" })).output.join("\n")
  const enabled = () =>
    host.control
      .tools()
      .filter((t) => t.enabled)
      .map((t) => t.name)
  return { session, host, run, enabled, announced, home }
}

test("/shell and /tools decide the tools together; the shell mode wins for the shell tools", async () => {
  const { host, run, enabled } = await setup()
  host.control.setShell("auto")
  expect(enabled()).toEqual(["bash", "powershell"])
  await run("/shell bash")
  expect(enabled()).toEqual(["bash"])
  await run("/tools enable powershell")
  await run("/tools enable read")
  expect(enabled()).toEqual(["bash", "powershell", "read"])
  // Choosing a shell mode again decides both shell tools anew; other choices stay.
  await run("/shell powershell")
  expect(enabled()).toEqual(["powershell", "read"])
  expect(host.control.info().shell).toBe("powershell")
})

test("the session's permission policy shows in info and /permissions, and follows the mode", async () => {
  const { session, host, run } = await setup()
  expect(host.control.info().permissions).toEqual({ mode: "auto", rules: 0 })
  session.agent.permissions.cycleMode()
  expect(host.control.permissions?.()).toMatchObject({ mode: "edits", modeSource: "this session", rules: [] })
  expect(await run("/permissions")).toContain("Mode: edits (from this session)")
  // A new session (/clear) keeps the policy: it belongs to the whole run.
  await run("/clear")
  expect(host.control.info().permissions?.mode).toBe("edits")
})

test("the powershell shell mode is refused off Windows", async () => {
  const { host } = await setup([], { platform: "linux" })
  expect(() => host.control.setShell("powershell")).toThrow(/only available on Windows/)
  expect(() => host.control.setShell("zsh" as "bash")).toThrow(/auto, bash or powershell/)
})

test("/clear and /resume switch the active agent and announce it; a running turn blocks them", async () => {
  const { host, session, run, announced } = await setup([{ text: "first", delayMs: 50 }, { text: "second" }])
  const first = host.agent
  const turn = first.prompt("hello")
  await Bun.sleep(10)
  expect(await run("/clear")).toContain("a turn is running")
  expect(() => host.control.setModel("mock/m")).toThrow(/a turn is running/)
  await turn
  expect(await run("/clear")).toContain("Started a new session")
  expect(host.agent).not.toBe(first)
  expect(host.agent.messages).toEqual([])
  expect(announced).toEqual([["clear", host.agent.sessionId]])
  // The first session was stored, so it can be resumed; the listing leaves nothing out.
  expect(host.control.sessions().map((s) => s.id)).toContain(first.sessionId)
  expect(await run(`/resume ${first.sessionId}`)).toContain(`Resumed session ${first.sessionId} (2 messages)`)
  expect(host.agent.sessionId).toBe(first.sessionId)
  expect(announced.at(-1)).toEqual(["resume", first.sessionId])
  expect(await run("/resume nope")).toContain("no session nope")
  expect(session.agent).toBe(first)
})

test("rewind cuts the conversation back to before a user message, on a branch of the same session", async () => {
  const { host, announced } = await setup([
    { text: "one", delayMs: 30 },
    { text: "two" },
    { text: "three" },
    { text: "two again" },
  ])
  const first = host.agent
  const turn = first.prompt("first")
  await Bun.sleep(5)
  await expect(host.control.rewind!(0)).rejects.toThrow(/a turn is running/)
  await turn
  await first.prompt("second")
  await first.prompt("third")
  expect(first.messages.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
    "assistant",
  ])
  await expect(host.control.rewind!(1)).rejects.toThrow(/not a user message/)
  await expect(host.control.rewind!(99)).rejects.toThrow(/not a user message/)

  await host.control.rewind!(2)
  const cut = host.agent
  expect(cut).not.toBe(first)
  expect(cut.sessionId).toBe(first.sessionId)
  expect(announced.at(-1)).toEqual(["resume", first.sessionId])
  expect(cut.messages.map((m) => m.role === "user" && m.content)).toEqual([
    [{ type: "text", text: "first" }],
    false,
  ])
  // The conversation goes on from there, and a resume sees the new branch.
  await cut.prompt("second, better")
  const reopened = SessionStore.open(cut.session!.file).restore().messages
  expect(
    reopened.flatMap((m) => (m.role === "user" ? m.content.map((b) => b.type === "text" && b.text) : [])),
  ).toEqual(["first", "second, better"])

  // Back to before the first message: an empty conversation, still the same session.
  await host.control.rewind!(0)
  expect(host.agent.messages).toEqual([])
  expect(announced.at(-1)).toEqual(["resume", first.sessionId])
})

test("rewind refuses a message a compaction summarized", async () => {
  const { host } = await setup([{ text: "one" }, { text: "two" }, { text: "SUMMARY" }])
  await host.agent.prompt("first")
  await host.agent.prompt("second")
  expect(await host.control.compact()).toBe(true)
  const summary = host.agent.messages.findIndex((m) => m.role === "user")
  await expect(host.control.rewind!(summary)).rejects.toThrow(/summarized by a compaction/)
})

test("rewind to the first message after a compaction keeps the summary", async () => {
  const { host } = await setup([{ text: "one" }, { text: "two" }, { text: "SUMMARY" }, { text: "three" }])
  await host.agent.prompt("first")
  await host.agent.prompt("second")
  expect(await host.control.compact()).toBe(true)
  const before = host.agent.messages.length
  await host.agent.prompt("third")
  await host.control.rewind!(before)
  const text = (m: { content: { type: string; text?: string }[] }) =>
    m.content.map((b) => b.text ?? "").join("")
  expect(host.agent.messages.map(text).join("\n")).toContain("SUMMARY")
  expect(host.agent.messages.map(text)).not.toContain("third")
  expect(host.agent.messages).toHaveLength(before)
})

test("send passes a display along, whether it starts a turn or steers the running one", async () => {
  const { host } = await setup([{ text: "first", delayMs: 30 }, { text: "second" }])
  const display = { text: "/x 1", note: "Loaded skill x (4 lines)" }
  const first = host.control.send("long text", { display })
  await Bun.sleep(5)
  const steered = host.control.send("more long text", { display: { text: "/y" } })
  await first
  await steered
  const users = host.agent.messages.filter((m) => m.role === "user")
  expect(users.map((m) => m.role === "user" && [m.content, m.display])).toEqual([
    [[{ type: "text", text: "long text" }], display],
    [[{ type: "text", text: "more long text" }], { text: "/y" }],
  ])
})

test("a command's expectNotice wakes the idle session when the notice is delivered", async () => {
  const { host } = await setup([{ text: "got it" }])
  const notice = host.control.expectNotice!()
  notice.deliver({
    role: "user",
    content: [{ type: "text", text: "the background work is done" }],
    display: { text: "◆ done", origin: "test" },
  })
  const until = Date.now() + 2000
  while (host.agent.messages.length < 2 && Date.now() < until) await Bun.sleep(5)
  await host.agent.bus.flush()
  expect(host.agent.messages.map((m) => m.role)).toEqual(["user", "assistant"])
  const first = host.agent.messages[0]!
  expect(first.role === "user" && first.display).toEqual({ text: "◆ done", origin: "test" })
})

test("/clear and /resume keep the model chosen on the active agent", async () => {
  const { host, run, session } = await setup()
  const first = host.agent.sessionId
  await run("/clear")
  await run("/model mock/other")
  await run("/clear")
  expect(host.agent.model.id).toBe("other")
  await run(`/resume ${first}`)
  expect(host.agent.model.id).toBe("other")
  expect(session.agent.model.id).toBe("m")
})

test("/cost counts replies a compaction replaced; /context previews the next request", async () => {
  const { host, run } = await setup([{ text: "one" }, { text: "two" }, { text: "summary" }])
  await host.agent.prompt("a")
  await host.agent.prompt("b")
  const before = await run("/context")
  expect(before).toMatch(/User messages \(2\)/)
  expect(before).toMatch(/Tool definitions \(3\)/)
  expect(await host.control.compact("keep it short")).toBe(true)
  // The first reply is gone from the conversation, but it was paid for.
  expect(JSON.stringify(host.control.messages())).not.toContain('"text":"one"')
  expect(await run("/cost")).toMatch(/mock\/m\s+2 replies/)
})

test("readSession reads a stored session without switching to it, compacted messages included", async () => {
  const { host } = await setup([{ text: "one" }, { text: "two" }, { text: "summary" }])
  const first = host.agent
  await first.prompt("a")
  await first.prompt("b")
  expect(await host.control.compact()).toBe(true)
  await host.control.newSession()
  const read = host.control.readSession!(first.sessionId)!
  expect(host.agent).not.toBe(first)
  expect(read.id).toBe(first.sessionId)
  expect(read.cwd).toBe(here)
  expect(read.createdAt).toBeLessThanOrEqual(read.updatedAt)
  // The reply the compaction replaced is still part of the conversation as it happened.
  const texts = read.messages.map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join(""))
  expect(texts).toEqual(["a", "one", "b", "two"])
  expect(read.subagents).toEqual([])
  expect(read.subagentMessages("s_nope")).toBeUndefined()
  expect(host.control.readSession!("s_nope")).toBeUndefined()
  expect(host.control.readSession!("../escape")).toBeUndefined()
})

test("/provider lists only the configured providers; an unknown one says how to add it", async () => {
  const { host, run } = await setup()
  const listed = await run("/provider")
  expect(listed).toMatch(/\*\s+mock\s+mock/)
  expect(listed).not.toMatch(/anthropic|openai|google/)
  expect(host.control.providers().map((p) => p.id)).toEqual(["mock"])
  const r = await host.run("/model anthropic/claude-x", { frontend: "print" })
  expect(r.error).toBe(
    'unknown provider "anthropic" (configured: mock); add it with /provider add (or amira provider add)',
  )
})

test("while no model is selected, /model offers only real models", async () => {
  const { host, session } = await setup()
  session.agent.setModel(NO_MODEL)
  expect(host.control.models()).toEqual([])
  expect(host.control.info().model).toEqual({ provider: "", model: "" })
  host.control.setModel("mock/m")
  expect(host.control.models()).toEqual(["mock/m"])
})

test("/reload unloads and loads the extensions again", async () => {
  const loads: string[] = []
  const { run, host } = await setup([], { loads })
  expect(loads).toHaveLength(1)
  expect(await run("/reload")).toMatch(/^Reloaded [0-9]+ extensions · nothing changed$/)
  expect(loads).toHaveLength(2)
  expect(host.list().map((c) => c.name)).toContain("status")
})

test("a running turn or compaction blocks /reload, /clear and /model", async () => {
  const loads: string[] = []
  const { host, run } = await setup(
    [{ text: "one", delayMs: 50 }, { text: "two" }, { text: "summary", delayMs: 50 }],
    { loads },
  )
  const turn = host.agent.prompt("a")
  await Bun.sleep(10)
  expect(await run("/reload")).toContain("a turn is running")
  expect(loads).toHaveLength(1)
  await turn
  await host.agent.prompt("b")
  const compaction = host.control.compact()
  await Bun.sleep(10)
  expect(host.control.info().busy).toBe(true)
  expect(await run("/clear")).toContain("a compaction is running")
  expect(() => host.control.setModel("mock/other")).toThrow(/a compaction is running/)
  expect(await run("/reload")).toContain("a compaction is running")
  expect(await compaction).toBe(true)
  expect(host.control.info().busy).toBe(false)
  expect(await run("/reload")).toMatch(/^Reloaded [0-9]+ extensions · nothing changed$/)
})

test("a prompt or notice during /reload waits for the extensions to load again", async () => {
  const dialect = createMockDialect([{ text: "before" }, { text: "during" }])
  const ai = createAi({ dialects: [dialect], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  let release = () => {}
  let entered = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const atGate = new Promise<void>((r) => (entered = r))
  let loads = 0
  // Its second load (the reload) takes a while, as an extension's async setup may.
  const slowTools: Extension = async (api) => {
    if (++loads === 2) {
      entered()
      await gate
    }
    api.registerTool(
      defineTool({
        name: "fixture_read",
        description: "",
        parameters: {},
        execute: async () => textResult(""),
      }),
    )
  }
  const session = await createSession({
    model: "mock/m",
    cwd: here,
    extensions: [],
    noBuiltins: false,
    ai,
    builtins: async () => [
      { source: "builtin:commands", extension: commandsExtension },
      { source: "slow", extension: slowTools },
    ],
  })
  const host = createCommandHost({
    session,
    cwd: here,
    home: mkdtempSync(path.join(os.tmpdir(), "amira-r-")),
  })
  const notice = session.agent.expectNotice()
  await session.agent.prompt("before")
  const reload = host.run("/reload", { frontend: "print" })
  await atGate
  expect(host.control.info().busy).toBe(true)
  expect(() => host.control.setModel("mock/other")).toThrow(/a reload is running/)
  const turn = session.agent.prompt("during")
  notice.deliver({ role: "user", content: [{ type: "text", text: "background result" }] })
  await Bun.sleep(10)
  expect(dialect.requests).toHaveLength(1)
  release()
  expect((await reload).error).toBeUndefined()
  expect(await turn).toMatchObject({ reason: "done" })
  expect(dialect.requests).toHaveLength(2)
  expect(dialect.requests.map((r) => r.tools?.map((t) => t.name))).toEqual([
    ["fixture_read"],
    ["fixture_read"],
  ])
  // The notice went along with the prompt.
  expect(JSON.stringify(dialect.requests[1]!.messages.at(-1))).toContain("background result")
})

test("the extensions a /reload loads again pick up the session where it is (the status keeps its items)", async () => {
  const ai = createAi({
    dialects: [createMockDialect([{ text: "ok", usage: { input: 2000, cost: 0.25 } }])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const session = await createSession({
    model: "mock/m",
    cwd: here,
    extensions: [],
    noBuiltins: false,
    ai,
    builtins: async () => [
      { source: "builtin:commands", extension: commandsExtension },
      { source: "builtin:status", extension: statusExtension },
    ],
  })
  const host = createCommandHost({
    session,
    cwd: here,
    home: mkdtempSync(path.join(os.tmpdir(), "amira-r-")),
  })
  const { agent } = session
  agent.start("startup")
  agent.bus.emit(
    "workspace.changed",
    { cwd: here, repoRoot: here, branch: "main" },
    { sessionId: agent.sessionId },
  )
  await agent.prompt("hello")
  await agent.bus.flush()
  const items = () => session.host.status.snapshot().map((s) => [s.id, s.text])
  const before = items()
  expect(before).toEqual([
    ["model", "m"],
    ["context", expect.stringMatching(/^ctx 2\.0k/)],
    ["cost", "$0.250"],
    ["place", "main"],
  ])
  const seen: string[] = []
  const off = agent.bus.subscribe((e) => void seen.push(e.type))
  expect((await host.run("/reload", { frontend: "print" })).error).toBeUndefined()
  await agent.bus.flush()
  off()
  expect(items()).toEqual(before)
  // Handed to the reloaded extensions only: nothing on the bus says a session started.
  expect(seen).not.toContain("session.start")
  expect(seen).not.toContain("workspace.changed")
})

test("print mode runs a slash command instead of a turn", async () => {
  const { host, session } = await setup([{ text: "never" }])
  const out: string[] = []
  const err: string[] = []
  const io = { stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s) }
  expect(await runPrint(session.agent, "/status", false, { io, commands: host })).toBe(0)
  expect(out.join("")).toMatch(/Model\s+mock\/m/)
  expect(session.agent.messages).toEqual([])
  expect(await runPrint(session.agent, "/nope", false, { io, commands: host })).toBe(1)
  expect(err.join("")).toContain("error: Unknown command /nope")
})

test("print mode runs a $skill; other text that starts with $ is a prompt", async () => {
  const { host, session } = await setup([{ text: "echoed" }, { text: "cheap" }])
  const out: string[] = []
  const io = { stdout: (s: string) => void out.push(s), stderr: () => {} }
  expect(await runPrint(session.agent, "$echo hi there", false, { io, commands: host })).toBe(0)
  expect(await runPrint(session.agent, "$100 is the price", false, { io, commands: host })).toBe(0)
  expect(out.join("")).toContain("echoed")
  expect(out.join("")).toContain("cheap")
  const users = session.agent.messages.filter((m) => m.role === "user")
  expect(users.map((m) => [(m.content[0] as { text: string }).text, m.display?.text])).toEqual([
    ["ECHO hi there", "$echo hi there"],
    ["$100 is the price", undefined],
  ])
})

test("print mode runs built-in and settings aliases; shadowed settings aliases warn at startup", async () => {
  const { host, session } = await setup([{ text: "never" }], {
    aliases: { st: "status", mm: "model mock/m", q: "status", bad: "nope" },
  })
  const warnings = session.startupEvents.flatMap((e) => (e.type === "extension.error" ? [e.data] : []))
  expect(warnings).toEqual([
    {
      source: "settings",
      error:
        "commandAliases: /q is already an alias of /quit (from builtin:commands); the setting is ignored",
    },
  ])
  const out: string[] = []
  const err: string[] = []
  const io = { stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s) }
  expect(await runPrint(session.agent, "/usage", false, { io, commands: host })).toBe(0)
  expect(out.join("")).toContain("No model replies with usage")
  expect(await runPrint(session.agent, "/st", false, { io, commands: host })).toBe(0)
  expect(out.join("")).toMatch(/Model\s+mock\/m/)
  expect(await runPrint(session.agent, "/mm", false, { io, commands: host })).toBe(0)
  expect(out.join("")).toContain("Model: mock/m")
  expect(await runPrint(session.agent, "/bad", false, { io, commands: host })).toBe(1)
  expect(err.join("")).toContain("error: The alias /bad runs /nope, which is not a command")
  expect(session.agent.messages).toEqual([])
})

test("the first provider saved is used at once, and an edit of the one in use applies at once", async () => {
  const session = await createSession({
    cwd: here,
    extensions: [],
    noBuiltins: true,
    ai: createAi({}),
  })
  expect(session.agent.model).toBe(NO_MODEL)
  const home = mkdtempSync(path.join(os.tmpdir(), "amira-control-first-"))
  const host = createCommandHost({ session, cwd: here, home, announce: () => {} })
  const admin = host.control.providerAdmin!
  const draft = {
    id: "local",
    dialect: "openai-chat",
    baseUrl: "http://127.0.0.1:1/v1",
    keySource: "none" as const,
    models: ["small", "big"],
  }
  expect(await admin.save(draft)).toContain("Now using local/small.")
  expect(session.agent.model.provider).toBe("local")
  expect(session.agent.model.id).toBe("small")
  const before = session.agent.model
  const edited = await admin.save({ ...draft, defaults: { contextWindow: 9000 } })
  expect(edited).toContain("In use: the changes apply now (local/small).")
  // The model is resolved again, with what the edit changed.
  expect(session.agent.model).not.toBe(before)
  expect(session.agent.model.contextWindow).toBe(9000)
})
