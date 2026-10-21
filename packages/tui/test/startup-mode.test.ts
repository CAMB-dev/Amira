import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { Agent, EventBus } from "@amira/core"
import { FakeTerminal, modes } from "@amira/tui-kit"
import { parseCliArgs } from "../../cli/src/args.ts"
import { StatusRegistry } from "../../core/src/status-registry.ts"
import { processTerminalFixture } from "../../tui-kit/test/process-terminal-fixture.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { inlineModeNotice } from "../src/app/startup.ts"
import { withFullscreenTerminal } from "../src/app/terminal.ts"
import { type InteractiveOptions, runInteractive } from "../src/app.ts"

const notice = "inline mode was removed; running fullscreen. Use -p for plain output."

function interactiveOptions(): InteractiveOptions & { agent: Agent; terminal: FakeTerminal } {
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const bus = new EventBus()
  return {
    agent: new Agent({ ai, model: ai.model("mock/m1"), cwd: "/work", systemPrompt: "", bus }),
    status: new StatusRegistry(),
    terminal: new FakeTerminal(120, 30),
    settings: { margin: 0, marginRows: 0 },
    env: {},
    setup: async () => ({
      capabilities: {
        win32InputMode: false,
        kittyKeyboard: true,
        synchronizedOutput: false,
        shiftEnter: true,
      },
      leftoverInput: "\x03",
    }),
  }
}

for (const request of ["setting", "flag", "both"] as const) {
  test(`a legacy inline ${request} runs fullscreen and prints one transition notice on exit`, async () => {
    const opts = interactiveOptions()
    const screen = new VirtualScreen(120, 30)
    const write = opts.terminal.write.bind(opts.terminal)
    opts.terminal.write = (data) => {
      write(data)
      screen.write(data)
    }
    if (request !== "flag") opts.settings = { ...opts.settings, mode: "inline" }
    if (request !== "setting") opts.mode = parseCliArgs(["--inline"], import.meta.dir, {}).mode
    try {
      expect(await runInteractive(opts)).toBe(0)
      expect(screen.altSwitches).toEqual([true, false])
      expect(screen.mainText.split(notice)).toHaveLength(2)
      expect(opts.terminal.isRaw).toBe(false)
    } finally {
      await opts.agent.dispose()
    }
  })
}

test("runInteractive rejects TERM=dumb before setup and suggests print mode", async () => {
  const opts = interactiveOptions()
  opts.env = { TERM: "dumb" }
  let setup = false
  opts.setup = async () => {
    setup = true
    throw new Error("must not probe a dumb terminal")
  }
  try {
    await expect(runInteractive(opts)).rejects.toThrow('use amira -p "<prompt>" for plain output.')
    expect(setup).toBe(false)
    expect(opts.terminal.output).toBe("")
  } finally {
    await opts.agent.dispose()
  }
})

test("runInteractive rejects a terminal that cannot enter fullscreen without falling back", async () => {
  const opts = interactiveOptions()
  let listeners = 0
  const onInput = opts.terminal.onInput.bind(opts.terminal)
  const onResize = opts.terminal.onResize.bind(opts.terminal)
  opts.terminal.onInput = (fn) => {
    listeners++
    const off = onInput(fn)
    return () => {
      listeners--
      off()
    }
  }
  opts.terminal.onResize = (fn) => {
    listeners++
    const off = onResize(fn)
    return () => {
      listeners--
      off()
    }
  }
  opts.terminal.enterAltScreen = () => {
    throw new Error("alternate screen unavailable")
  }
  try {
    await expect(runInteractive(opts)).rejects.toThrow(
      'alternate screen unavailable; use amira -p "<prompt>" for plain output.',
    )
    expect(listeners).toBe(0)
    expect(opts.terminal.isRaw).toBe(false)
  } finally {
    await opts.agent.dispose()
  }
})

test("the deprecated inline setting produces one fullscreen notice", () => {
  expect(inlineModeNotice({ settings: { mode: "inline" } })).toBe(notice)
  expect(inlineModeNotice({ mode: "fullscreen", settings: { mode: "inline" } })).toBe(notice)
  expect(inlineModeNotice({})).toBeUndefined()
  expect(inlineModeNotice({ mode: "fullscreen", settings: { mode: "fullscreen" } })).toBeUndefined()
})

test("the deprecated inline flag produces the same notice, once even with the setting", () => {
  const args = parseCliArgs(["--inline"], import.meta.dir, {})
  expect(inlineModeNotice({ mode: args.mode })).toBe(notice)
  expect(inlineModeNotice({ mode: args.mode, settings: { mode: "inline" } })).toBe(notice)
  expect(inlineModeNotice({ mode: parseCliArgs(["--fullscreen"], import.meta.dir, {}).mode })).toBeUndefined()
})

test("TERM=dumb rejects fullscreen before setup or any terminal escapes", async () => {
  const terminal = new FakeTerminal()
  let started = false
  await expect(
    withFullscreenTerminal(terminal, { TERM: "dumb" }, async () => {
      started = true
      terminal.setRawMode(true)
      terminal.enterAltScreen()
      return 0
    }),
  ).rejects.toThrow('TERM=dumb cannot run the fullscreen UI; use amira -p "<prompt>" for plain output.')
  expect(started).toBe(false)
  expect(terminal.isRaw).toBe(false)
  expect(terminal.output).toBe("")
})

test("fullscreen startup failures restore raw mode and alternate screen and suggest print", async () => {
  const terminal = new FakeTerminal()
  await expect(
    withFullscreenTerminal(terminal, {}, async () => {
      terminal.setRawMode(true)
      terminal.enterAltScreen()
      throw new Error("terminal setup failed")
    }),
  ).rejects.toThrow('terminal setup failed; use amira -p "<prompt>" for plain output.')
  expect(terminal.isRaw).toBe(false)
  expect(terminal.output).toContain(modes.altScreen.off)
})

test("cleanup releases raw mode if restoring output fails, without hiding the original error", async () => {
  const terminal = new FakeTerminal()
  terminal.restore = () => {
    throw new Error("broken output")
  }
  await expect(
    withFullscreenTerminal(terminal, {}, async () => {
      terminal.setRawMode(true)
      throw new Error("cannot enter fullscreen")
    }),
  ).rejects.toThrow('cannot enter fullscreen; use amira -p "<prompt>" for plain output.')
  expect(terminal.isRaw).toBe(false)
})

for (const failures of [1, 3]) {
  test(`ProcessTerminal cleanup retries restore once without hiding startup errors (${failures} failed writes)`, async () => {
    const f = processTerminalFixture()
    const original = new Error("cannot start fullscreen")
    let caught: unknown
    try {
      await withFullscreenTerminal(f.terminal, {}, async () => {
        f.terminal.start()
        f.terminal.setRawMode(true)
        f.terminal.enterAltScreen()
        f.failRestores(failures)
        throw original
      }).catch((error) => {
        caught = error
      })
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).cause).toBe(original)
      expect((caught as Error).message).toContain('use amira -p "<prompt>"')
      expect({
        raw: f.raw(),
        paused: f.stdin.isPaused(),
        inputListeners: f.stdin.listenerCount("data"),
        resizeListeners: f.stdout.listenerCount("resize"),
        attempts: f.restoreAttempts(),
        alternateScreen: f.screen.inAltScreen,
      }).toEqual({
        raw: false,
        paused: true,
        inputListeners: 0,
        resizeListeners: 0,
        attempts: 2,
        alternateScreen: failures > 1,
      })
      f.failRestores(0)
      f.terminal.stop()
      expect(f.screen.inAltScreen).toBe(false)
    } finally {
      f.failRestores(0)
      f.terminal.stop()
      f.stdin.destroy()
    }
  })
}

test("fullscreen completion preserves the exit code and restores the terminal", async () => {
  const terminal = new FakeTerminal()
  expect(
    await withFullscreenTerminal(terminal, {}, async () => {
      terminal.setRawMode(true)
      terminal.enterAltScreen()
      return 7
    }),
  ).toBe(7)
  expect(terminal.isRaw).toBe(false)
  expect(terminal.output).toContain(modes.altScreen.off)
})
