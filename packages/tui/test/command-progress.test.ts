import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { ExtensionAdmin, ExtensionProgress, SessionControl } from "@amira/api"
import { Agent, CommandHost, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { Spinner } from "@amira/tui-kit"
import commandsExtension from "../../../extensions/commands/src/index.ts"
import { plain as ctx } from "../../tui-kit/test/context.ts"
import { createCommandRunner } from "../src/app/command-runner.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"

beforeEach(() => void jest.useFakeTimers())
afterEach(() => void jest.useRealTimers())

async function setup(admin: ExtensionAdmin, extra: Partial<SessionControl> = {}) {
  const bus = new EventBus()
  const output: string[] = []
  bus.subscribe((e) => {
    if (e.type === "command.output") output.push(e.data.text)
  })
  const host = new ExtensionHost({ bus, tools: new ToolRegistry(), interceptors: new InterceptorRegistry() })
  await host.load(commandsExtension, "builtin:commands")
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m"), bus, cwd: process.cwd() })
  let sessionId = agent.sessionId
  const control = {
    extensionAdmin: admin,
    info: () => ({ id: sessionId, busy: false }),
    ...extra,
  } as unknown as SessionControl
  const commands = new CommandHost({ registry: host.commands, bus, ui: host.ui, control, agent })
  let renders = 0
  const runner = createCommandRunner({
    commands,
    keys: new Keybindings(defaultKeys({ vscode: false })),
    reaches: () => true,
    commandEcho: () => {},
    commandOutput: () => {},
    requestRender: () => renders++,
    sessionId: () => sessionId,
    quit: () => {},
    openView: () => false,
    openRewind: () => false,
    isCompacting: () => false,
    interrupt: () => {},
  })
  jest.advanceTimersByTime(0)
  const rows = () =>
    host.panels.snapshot({
      width: 120,
      now: Date.now(),
      spinner: runner.spinner,
      sessionId,
      collapsed: false,
    })
  return { host, runner, rows, output, renders: () => renders, switchSession: () => (sessionId = "s2") }
}

const emptyAdmin: ExtensionAdmin = {
  list: () => [],
  search: async () => ({ extensions: [], warnings: [] }),
  install: async (name) => ({ name, version: "1.0.0", warnings: [] }),
  update: async () => {},
  remove: () => {},
  setEnabled: () => false,
}

for (const outcome of ["done", "failed", "cancelled"] as const) {
  test(`progress frames advance on the shared clock; ${outcome} commits once and leaves no timers`, async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let progress!: (p: ExtensionProgress) => void
    const s = await setup({
      ...emptyAdmin,
      install: async (name, _scope, opts) => {
        progress = opts.onProgress
        progress({ name, phase: "fetching", percent: 42, detail: "128 KiB" })
        started.resolve()
        await release.promise
        if (outcome === "failed") throw new Error("fixture failed")
        return { name, version: "1.0.0", warnings: [] }
      },
    })
    const pending = s.runner.run("/ext install fixture")
    try {
      await started.promise
      const first = s.rows()[0]!.lines
      const spinner = new Spinner()
      expect(first[1]!.text).toStartWith(spinner.glyph)
      expect(first[1]!.text).toContain("fetching 42% · 0s · 128 KiB")
      jest.advanceTimersByTime(80)
      spinner.tick()
      const next = s.rows()[0]!.lines
      expect(next[1]!.text).toStartWith(spinner.glyph)
      expect(next).not.toEqual(first)
      expect(s.renders()).toBeGreaterThan(1)
      jest.advanceTimersByTime(1040)
      expect(s.rows()[0]!.lines[1]!.text).toContain("· 1s")
      expect(s.runner.render(120, ctx)[0]).toContain("/ext")
      if (outcome === "cancelled") {
        expect(s.runner.cancel()).toBe(true)
        expect(s.runner.render(120, ctx)).toEqual([])
        expect(s.rows()).toEqual([])
        jest.advanceTimersByTime(0)
        expect(jest.getTimerCount()).toBe(0)
        progress({ name: "fixture", phase: "dependencies" })
        expect(s.rows()).toEqual([])
      }
      release.resolve()
      await pending
      await Promise.resolve()
      jest.advanceTimersByTime(0)
      expect(s.rows()).toEqual([])
      expect(s.runner.render(120, ctx)).toEqual([])
      expect(s.runner.spinner).toBe("")
      const result =
        outcome === "done" ? "Installed fixture" : outcome === "failed" ? "fixture failed" : "cancelled"
      expect(s.output.filter((line) => line.includes(result))).toHaveLength(1)
      expect(jest.getTimerCount()).toBe(0)
      const renders = s.renders()
      jest.advanceTimersByTime(10_000)
      expect(s.renders()).toBe(renders)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      release.resolve()
      await pending
      s.runner.abortAll(new Error("test ended"))
    }
  })
}

test("/reload uses animated command activity and commits its summary once", async () => {
  const release = Promise.withResolvers<undefined>()
  const s = await setup(emptyAdmin, { reloadExtensions: () => release.promise })
  const pending = s.runner.run("/reload")
  try {
    const first = s.runner.render(120, ctx)
    expect(first[0]).toContain("/reload")
    jest.advanceTimersByTime(80)
    expect(s.runner.render(120, ctx)).not.toEqual(first)
    release.resolve(undefined)
    await pending
    expect(s.output).toEqual(["Reloaded extensions."])
    expect(s.runner.render(120, ctx)).toEqual([])
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    release.resolve(undefined)
    await pending
  }
})

test("overlapping commands share one timer; finishing one and aborting all cleans it up", async () => {
  const s = await setup(emptyAdmin)
  const one = Promise.withResolvers<void>()
  const two = Promise.withResolvers<void>()
  s.host.commands.register({ name: "one", description: "One", run: () => one.promise }, "test")
  s.host.commands.register({ name: "two", description: "Two", run: () => two.promise }, "test")
  const first = s.runner.run("/one")
  const second = s.runner.run("/two")
  try {
    expect(jest.getTimerCount()).toBe(1)
    one.resolve()
    await first
    const frame = s.runner.spinner
    jest.advanceTimersByTime(80)
    expect(s.runner.spinner).not.toBe(frame)
    expect(s.runner.render(120, ctx)[0]).toContain("/two")
    s.runner.abortAll(new Error("quitting"))
    expect(s.runner.render(120, ctx)).toEqual([])
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    one.resolve()
    two.resolve()
    await Promise.all([first, second])
  }
})

for (const line of ["/ext", "/ext search sample"] as const) {
  test(`${line}: index loads animate, remain session-bound and stop on completion`, async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const s = await setup({
      ...emptyAdmin,
      search: async () => {
        started.resolve()
        await release.promise
        return { extensions: [], warnings: [] }
      },
    })
    const pending = s.runner.run(line)
    try {
      await started.promise
      const first = s.rows()
      expect(first[0]!.lines[1]!.text).toContain("Extension index")
      jest.advanceTimersByTime(80)
      expect(s.rows()).not.toEqual(first)
      s.switchSession()
      expect(s.rows()).toEqual([])
      expect(s.runner.render(120, ctx)).toEqual([])
      release.resolve()
      await pending
      jest.advanceTimersByTime(0)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      release.resolve()
      await pending
      s.runner.abortAll(new Error("test ended"))
    }
  })
}
