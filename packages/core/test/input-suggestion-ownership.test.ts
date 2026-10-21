import { afterEach, expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { CommandContext, ExtensionAPI, SessionControl, UiApi } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { CommandHost } from "../src/commands.ts"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const kinds = ["command", "skill", "input"] as const
type Kind = (typeof kinds)[number]
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function setup() {
  const bus = new EventBus()
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agents: Agent[] = []
  const makeAgent = () => {
    const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/work", bus })
    agents.push(agent)
    return agent
  }
  const extensions = new ExtensionHost({
    bus,
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  const commands = new CommandHost({
    registry: extensions.commands,
    skills: extensions.skills,
    inputs: extensions.inputs,
    ui: extensions.ui,
    bus,
    control: {} as SessionControl,
    agent: makeAgent(),
  })
  extensions.setSessionControl(commands.control, () => commands.agent)
  cleanups.push(async () => {
    extensions.unloadAll()
    for (const agent of agents) await agent.dispose()
  })
  return { extensions, commands, makeAgent, suggestions: extensions.ui.inputSuggestions }
}

async function load(s: ReturnType<typeof setup>, source: string) {
  let direct!: UiApi
  const contexts = new Map<Kind, UiApi>()
  expect(
    await s.extensions.load((api: ExtensionAPI) => {
      direct = api.ui
      for (const kind of kinds) {
        const definition = {
          name: source,
          description: "fixture",
          run: (_text: string, ctx: CommandContext) => {
            contexts.set(kind, ctx.ui)
          },
        }
        if (kind === "command") api.registerCommand(definition)
        else if (kind === "skill") api.registerSkill(definition)
        else api.registerInputHandler({ ...definition, claims: (text) => text === source })
      }
    }, source),
  ).toBe(true)
  return {
    direct,
    async invoke(kind: Kind, signal?: AbortSignal) {
      const opts = { frontend: "tui" as const, signal }
      const outcome =
        kind === "command"
          ? await s.commands.run(`/${source}`, opts)
          : kind === "skill"
            ? await s.commands.runSkill(`$${source}`, opts)
            : await s.commands.runInput(source, opts)
      expect(outcome.ok).toBe(true)
      return contexts.get(kind)!
    },
  }
}

for (const kind of kinds) {
  test(`${kind} suggestions cannot be cleared by another extension`, async () => {
    const s = setup()
    const a = await (await load(s, "a")).invoke(kind)
    const b = await (await load(s, "b")).invoke(kind)
    a.setInputSuggestion("from a")
    b.setInputSuggestion("from b")
    a.setInputSuggestion(undefined)
    a.setInputSuggestion(" \n\t ")
    expect(s.suggestions.text).toBe("from b")
    expect(s.extensions.unload("a")).toBe(true)
    expect(s.suggestions.text).toBe("from b")
    b.setInputSuggestion(undefined)
    expect(s.suggestions.text).toBeUndefined()
  })

  test(`${kind} acceptance callbacks belong only to the setting extension`, async () => {
    const s = setup()
    const a = await (await load(s, "a")).invoke(kind)
    const b = await (await load(s, "b")).invoke(kind)
    const accepted: string[] = []
    a.onInputSuggestionAccepted((text) => accepted.push(`a:${text}`))
    b.onInputSuggestionAccepted((text) => accepted.push(`b:${text}`))
    b.setInputSuggestion("from b")
    expect(s.suggestions.accept()).toBe("from b")
    expect(accepted).toEqual(["b:from b"])
  })

  test(`${kind} unload clears suggestions and fences retained contexts across reload`, async () => {
    const s = setup()
    const old = await load(s, "a")
    const stale = await old.invoke(kind)
    const accepted: string[] = []
    stale.onInputSuggestionAccepted((text) => accepted.push(`stale:${text}`))
    stale.setInputSuggestion("before unload")
    expect(s.extensions.unload("a")).toBe(true)
    expect(s.suggestions.text).toBeUndefined()
    stale.setInputSuggestion("after unload")
    expect(s.suggestions.text).toBeUndefined()

    const fresh = await load(s, "a")
    const current = await fresh.invoke(kind)
    current.onInputSuggestionAccepted((text) => accepted.push(`fresh:${text}`))
    fresh.direct.setInputSuggestion("after reload")
    stale.setInputSuggestion("late prediction")
    expect(s.suggestions.text).toBe("after reload")
    stale.setInputSuggestion(undefined)
    old.direct.setInputSuggestion("old direct prediction")
    stale.onInputSuggestionAccepted((text) => accepted.push(`late:${text}`))
    expect(s.suggestions.accept()).toBe("after reload")
    expect(accepted).toEqual(["fresh:after reload"])
  })

  for (const invalidation of ["switch", "abort"] as const) {
    test(`${kind} suggestion ownership preserves ${invalidation} fencing`, async () => {
      const s = setup()
      const extension = await load(s, "a")
      const controller = new AbortController()
      const stale = await extension.invoke(kind, controller.signal)
      const accepted: string[] = []
      stale.onInputSuggestionAccepted((text) => accepted.push(`stale:${text}`))
      if (invalidation === "switch") s.commands.switchTo(s.makeAgent())
      else controller.abort()
      const fresh = await extension.invoke(kind)
      fresh.onInputSuggestionAccepted((text) => accepted.push(`fresh:${text}`))
      expect(fresh.setInputSuggestion("current session")).toBeUndefined()
      expect(stale.setInputSuggestion("stale session")).toBeUndefined()
      stale.setInputSuggestion(undefined)
      const off = stale.onInputSuggestionAccepted((text) => accepted.push(`late:${text}`))
      expect(typeof off).toBe("function")
      off()
      expect(s.suggestions.accept()).toBe("current session")
      expect(accepted).toEqual(["fresh:current session"])
    })
  }
}

for (const kind of ["direct", ...kinds]) {
  test(`${kind} UI isolates async rejecting acceptance listeners`, async () => {
    // Keep unhandled rejections in the child, away from bun:test's process-wide handler.
    const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href)
    const script = `
      import assert from "node:assert/strict"
      import { createAi, createMockDialect } from ${moduleUrl("../../ai/src/index.ts")}
      import { Agent } from ${moduleUrl("../src/agent.ts")}
      import { CommandHost } from ${moduleUrl("../src/commands.ts")}
      import { EventBus } from ${moduleUrl("../src/event-bus.ts")}
      import { ExtensionHost } from ${moduleUrl("../src/extensions.ts")}
      import { InterceptorRegistry } from ${moduleUrl("../src/interceptors.ts")}
      import { ToolRegistry } from ${moduleUrl("../src/tool-registry.ts")}

      const kind = ${JSON.stringify(kind)}
      const bus = new EventBus()
      const ai = createAi({
        dialects: [createMockDialect([])],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      })
      const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/work", bus })
      const extensions = new ExtensionHost({
        bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry(),
      })
      const commands = new CommandHost({
        registry: extensions.commands, skills: extensions.skills, inputs: extensions.inputs,
        ui: extensions.ui, bus, control: {}, agent,
      })
      extensions.setSessionControl(commands.control, () => commands.agent)
      try {
        let ui
        assert.equal(await extensions.load((api) => {
          const definition = {
            name: "fixture", description: "fixture",
            run: (_text, ctx) => { ui = ctx.ui },
          }
          if (kind === "direct") ui = api.ui
          else if (kind === "command") api.registerCommand(definition)
          else if (kind === "skill") api.registerSkill(definition)
          else api.registerInputHandler({ ...definition, claims: () => true })
        }, "fixture"), true)
        const opts = { frontend: "tui" }
        if (kind === "command") assert.equal((await commands.run("/fixture", opts)).ok, true)
        else if (kind === "skill") assert.equal((await commands.runSkill("$fixture", opts)).ok, true)
        else if (kind === "input") assert.equal((await commands.runInput("fixture", opts)).ok, true)

        const accepted = []
        ui.onInputSuggestionAccepted(async (text) => {
          await Promise.resolve()
          accepted.push("reject:" + text)
          throw new Error("async suggestion listener rejection")
        })
        ui.onInputSuggestionAccepted((text) => accepted.push("next:" + text))
        ui.setInputSuggestion("safe")
        assert.equal(extensions.ui.inputSuggestions.accept(), "safe")
        assert.equal(extensions.ui.inputSuggestions.text, undefined)
        await Bun.sleep(10)
        assert.deepEqual(accepted, ["next:safe", "reject:safe"])
        console.log("acceptance completed")
      } finally {
        extensions.unloadAll()
        await agent.dispose()
      }
    `
    const child = Bun.spawn([process.execPath, "--eval", script], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(stdout.trim()).toBe("acceptance completed")
  })
}

test("direct UI, command, skill and input contexts share one extension suggestion owner", async () => {
  const s = setup()
  const extension = await load(s, "a")
  const handles = [extension.direct]
  for (const kind of kinds) handles.push(await extension.invoke(kind))
  const accepted: string[] = []
  handles.forEach((handle, i) => {
    handle.onInputSuggestionAccepted((text) => accepted.push(`${i}:${text}`))
  })
  for (let i = 0; i < handles.length; i++) {
    handles[i]!.setInputSuggestion("shared")
    handles[(i + 1) % handles.length]!.setInputSuggestion(undefined)
    expect(s.suggestions.text).toBeUndefined()
    handles[i]!.setInputSuggestion("shared")
    expect(s.suggestions.accept()).toBe("shared")
  }
  expect(accepted).toEqual(
    Array.from({ length: 4 }, () => ["0:shared", "1:shared", "2:shared", "3:shared"]).flat(),
  )
})
