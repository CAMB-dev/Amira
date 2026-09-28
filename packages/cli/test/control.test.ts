import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { defineTool, type Extension, textResult } from "@amira/api"
import { type Agent, SessionStore } from "@amira/core"
import commandsExtension from "@amira/ext-commands"
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
      defineTool({ name, description: name, parameters: {}, execute: async () => textResult("") }),
    )
  }
}

async function setup(steps: MockStep[] = [], opts: { platform?: string; loads?: string[] } = {}) {
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
    builtins: async () => [
      { source: "builtin:commands", extension: commandsExtension },
      { source: "tools", extension: shellTools },
      { source: "counter", extension: counter },
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

test("/provider add writes the preset to settings.json and makes it usable at once", async () => {
  const { host, run, home, session } = await setup()
  const out = await run("/provider add deepseek")
  expect(out).toContain('Added provider "deepseek"')
  expect(out).toContain("/model deepseek/<model>")
  expect(JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8")).providers.deepseek).toBeDefined()
  expect(session.ai.providers().some((p) => p.id === "deepseek")).toBe(true)
  expect(await run("/provider add deepseek")).toContain("already in")
  expect(host.control.providerPresets()).toContain("ollama")
})

test("/reload unloads and loads the extensions again", async () => {
  const loads: string[] = []
  const { run, host } = await setup([], { loads })
  expect(loads).toHaveLength(1)
  expect(await run("/reload")).toBe("Reloaded extensions.")
  expect(loads).toHaveLength(2)
  expect(host.list().map((c) => c.name)).toContain("status")
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
