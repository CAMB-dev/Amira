import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { TerminalProgress } from "@amira/api"
import terminalStatus from "../../../extensions/terminal-status/src/index.ts"
import { runPrint } from "../src/print.ts"
import { createSession } from "../src/session.ts"

const mockAi = () =>
  createAi({
    dialects: [createMockDialect([{ text: "done" }])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })

for (const noBuiltins of [false, true]) {
  test(`default terminal-status registration respects noBuiltins=${noBuiltins}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "amira-terminal-builtins-"))
    const s = await createSession({
      cwd,
      noBuiltins,
      extensions: [],
      ai: mockAi(),
      model: "mock/m",
      autoTitle: false,
    })
    try {
      expect(s.host.loaded.includes("builtin:terminal-status")).toBe(!noBuiltins)
      const titles: string[] = []
      s.host.bindTerminal({ setTitle: (title) => titles.push(title), setProgress: () => {}, bell: () => {} })
      s.agent.start("startup")
      await s.agent.bus.flush()
      expect(titles.length > 0).toBe(!noBuiltins)
    } finally {
      await s.agent.dispose()
      s.host.unloadAll()
      rmSync(cwd, { recursive: true, force: true })
    }
  })
}

test("print mode loads terminal status with no terminal output", async () => {
  const s = await createSession({
    cwd: import.meta.dir,
    noBuiltins: false,
    extensions: [],
    ai: mockAi(),
    model: "mock/m",
    builtins: async () => [{ source: "builtin:terminal-status", extension: terminalStatus }],
  })
  let out = ""
  let err = ""
  try {
    s.agent.bus.emit("ui.focus", { focused: false }, { sessionId: "host" })
    expect(
      await runPrint(s.agent, "go", false, {
        onReady: () => s.agent.start("startup"),
        io: {
          stdout: (text) => {
            out += text
          },
          stderr: (text) => {
            err += text
          },
        },
      }),
    ).toBe(0)
    expect(out).toBe("done\n")
    expect(err).toBe("")
  } finally {
    await s.agent.dispose()
    s.host.unloadAll()
  }
})

test("reload preserves latest focus, waiting and renamed title without another opening bell", async () => {
  const s = await createSession({
    cwd: import.meta.dir,
    noBuiltins: false,
    extensions: [],
    ai: mockAi(),
    model: "mock/m",
    builtins: async () => [{ source: "builtin:terminal-status", extension: terminalStatus }],
  })
  const titles: string[] = []
  const progress: TerminalProgress[] = []
  let bells = 0
  const detach = s.host.bindTerminal({
    setTitle: (title) => titles.push(title),
    setProgress: (state) => progress.push(state),
    bell: () => bells++,
  })
  const bus = s.agent.bus
  try {
    s.agent.start("startup")
    bus.emit("session.title", { title: "Renamed" }, { sessionId: s.agent.sessionId })
    bus.emit("workspace.changed", { cwd: import.meta.dir, branch: "main" }, { sessionId: s.agent.sessionId })
    bus.emit("ui.focus", { focused: true }, { sessionId: "host" })
    bus.emit("ui.waiting", { pending: 1, hidden: true, change: "opened" }, { sessionId: "host" })
    await bus.flush()
    expect(bells).toBe(1)
    expect((await s.reload()).failed).toEqual([])
    await bus.flush()
    expect(progress.at(-1)).toBe("paused")
    expect(titles.at(-1)).toEndWith(" · Renamed ⎇ main")
    expect(bells).toBe(1)
    bus.emit("ui.waiting", { pending: 0, hidden: false, change: "resolved" }, { sessionId: "host" })
    bus.emit("turn.end", { reason: "done", steps: 0 }, { sessionId: s.agent.sessionId })
    await bus.flush()
    expect(bells).toBe(1)
    bus.emit("ui.focus", { focused: false }, { sessionId: "host" })
    await bus.flush()
    await s.reload()
    await bus.flush()
    bus.emit("turn.end", { reason: "done", steps: 0 }, { sessionId: s.agent.sessionId })
    await bus.flush()
    expect(bells).toBe(2)
  } finally {
    detach()
    await s.agent.dispose()
    s.host.unloadAll()
  }
})
