import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep, userMessage } from "@amira/ai"
import { defineExtension, defineTool, type Extension, textResult } from "@amira/api"
import { EventBus, UiRequests } from "@amira/core"
import { parseCliArgs, UsageError } from "../src/args.ts"
import { type PrintIO, runPrint, safeJson } from "../src/print.ts"
import { createSession } from "../src/session.ts"

const here = import.meta.dir

test("parses print mode, repeatable extensions and the positional prompt", () => {
  const a = parseCliArgs(
    ["-p", "--json", "-m", "deepseek/x", "-e", "a.ts", "-e", "b.ts", "fix", "it"],
    here,
    {},
  )
  expect(a).toMatchObject({
    print: true,
    json: true,
    model: "deepseek/x",
    extensions: [path.join(here, "a.ts"), path.join(here, "b.ts")],
    prompt: "fix it",
    cwd: here,
  })
})

test("rejects inconsistent flags", () => {
  expect(() => parseCliArgs(["--json", "hi"], here, {})).toThrow(UsageError)
  expect(() => parseCliArgs(["-p"], here, {})).toThrow(UsageError)
  expect(() => parseCliArgs(["-p", ""], here, {})).toThrow(UsageError)
  expect(() => parseCliArgs(["--nope"], here, {})).toThrow(UsageError)
})

test("--inline and --fullscreen pick the UI's mode; unset leaves it to settings", () => {
  expect(parseCliArgs(["--inline"], here, {}).mode).toBe("inline")
  expect(parseCliArgs(["--fullscreen", "hi"], here, {}).mode).toBe("fullscreen")
  expect(parseCliArgs(["hi"], here, {}).mode).toBeUndefined()
  expect(() => parseCliArgs(["--inline", "--fullscreen"], here, {})).toThrow(UsageError)
})

test("supports -- before a dash-prefixed prompt", () => {
  expect(parseCliArgs(["-p", "--", "-weird"], here, {}).prompt).toBe("-weird")
})

test("--model beats $AMIRA_MODEL, which is the fallback", () => {
  expect(parseCliArgs(["-m", "a/b", "x"], here, { AMIRA_MODEL: "c/d" }).model).toBe("a/b")
  expect(parseCliArgs(["x"], here, { AMIRA_MODEL: "c/d" }).model).toBe("c/d")
  expect(parseCliArgs(["x"], here, {}).model).toBeUndefined()
})

test("--cwd is resolved to an absolute directory and validated", () => {
  expect(parseCliArgs(["-C", ".."], here, {}).cwd).toBe(path.dirname(here))
  expect(() => parseCliArgs(["-C", "definitely-not-here"], here, {})).toThrow(/not a directory/)
})

function capture(): PrintIO & { out: string; err: string } {
  const c = {
    out: "",
    err: "",
    stdout: (s: string) => {
      c.out += s
    },
    stderr: (s: string) => {
      c.err += s
    },
  }
  return c
}

async function mockSession(steps: MockStep[], extra: Partial<Parameters<typeof createSession>[0]> = {}) {
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "", defaultModel: { contextWindow: 128_000 } }],
  })
  const session = await createSession({
    model: "mock/m",
    cwd: here,
    extensions: [],
    noBuiltins: true,
    ai,
    ...extra,
  })
  session.agent.tools.register(
    defineTool<{ big?: boolean }>({
      name: "echo",
      description: "",
      parameters: {},
      execute: async (p) =>
        p.big ? { content: [{ type: "text", text: "big" }], details: { n: 10n } } : textResult("ok"),
    }),
    "test",
  )
  return session
}

test("plain print mode streams text to stdout and tool activity to stderr", async () => {
  const { agent } = await mockSession([
    { toolCalls: [{ name: "echo", args: { text: "x" } }] },
    { text: "all done" },
  ])
  const io = capture()
  expect(await runPrint(agent, "go", false, { io })).toBe(0)
  expect(io.out).toBe("all done\n")
  expect(io.err).toBe("● echo x\n")
})

test("plain print mode shows sub-agents' tool calls on stderr but only the commander's reply", async () => {
  const { agent } = await mockSession([
    { toolCalls: [{ name: "delegate", args: {} }] },
    { toolCalls: [{ name: "echo", args: { text: "y" } }] },
    { text: "child answer" },
    { text: "all done" },
  ])
  agent.tools.register(
    defineTool({
      name: "delegate",
      description: "",
      parameters: {},
      execute: async (_p, ctx) => {
        const r = await ctx.session!.spawn!({
          role: "explorer",
          title: "Look into it",
          prompt: "sub task",
        }).result()
        return textResult(r.text)
      },
    }),
    "test",
  )
  const io = capture()
  expect(await runPrint(agent, "go", false, { io })).toBe(0)
  expect(io.out).toBe("all done\n")
  expect(io.err).toMatch(
    /^● delegate \n◆ Look into it · explorer started: sub task\n {2}↳ explorer ● echo y\n◆ Look into it · explorer done \(\d+\.\ds\)\n$/,
  )
})

/** A tool standing in for a background sub-agent: its result comes as a notice `ms` later. */
function laterTool(ms: number) {
  return defineTool({
    name: "later",
    description: "",
    parameters: {},
    execute: async (_p, ctx) => {
      const notice = ctx.session!.expectNotice!()
      if (ms >= 0) {
        setTimeout(
          () => notice.deliver(userMessage("the late result", { text: "◆ bg finished", origin: "subagent" })),
          ms,
        )
      }
      return textResult("started")
    },
  })
}

test("print mode waits for background results and lets the commander react before exiting", async () => {
  const { agent } = await mockSession([
    { toolCalls: [{ name: "later", args: {} }] },
    { text: "started it" },
    (req) => {
      const last = req.messages.at(-1)
      const text = last?.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      return { text: `reacted to ${text}` }
    },
  ])
  agent.tools.register(laterTool(60), "test")
  const io = capture()
  expect(await runPrint(agent, "go", false, { io })).toBe(0)
  expect(io.out).toBe("started it\nreacted to the late result\n")
  expect(agent.expectedNotices).toBe(0)
  expect(agent.busy).toBe(false)
})

test("print mode waits through the resends of a failed woken turn, at most three", async () => {
  const down = { error: { message: "provider down" } }
  // Woken turn fails, the first two resends fail, the third one works.
  const ok = await mockSession(
    [
      { toolCalls: [{ name: "later", args: {} }] },
      { text: "started it" },
      down,
      down,
      down,
      { text: "reacted" },
    ],
    { noticeRetryMs: [30, 30, 30] },
  )
  ok.agent.tools.register(laterTool(20), "test")
  const io = capture()
  expect(await runPrint(ok.agent, "go", false, { io })).toBe(0)
  expect(io.out).toBe("started it\nreacted\n")
  expect(io.err.split("error: provider down").length).toBe(4)
  // All four fail: the wait ends after the third resend, with the error.
  const bad = await mockSession(
    [
      { toolCalls: [{ name: "later", args: {} }] },
      { text: "started it" },
      down,
      down,
      down,
      down,
      { text: "no" },
    ],
    { noticeRetryMs: [30, 30, 30] },
  )
  bad.agent.tools.register(laterTool(20), "test")
  const io2 = capture()
  expect(await runPrint(bad.agent, "go", false, { io: io2 })).toBe(1)
  expect(io2.err.split("error: provider down").length).toBe(5)
  expect(bad.agent.noticeRetry).toBeUndefined()
})

test("print mode stops waiting for background results on Ctrl+C", async () => {
  const { agent } = await mockSession([{ toolCalls: [{ name: "later", args: {} }] }, { text: "started it" }])
  agent.tools.register(laterTool(-1), "test")
  const io = capture()
  const p = runPrint(agent, "go", false, { io, forceExit: () => {} })
  await Bun.sleep(80)
  expect(agent.expectedNotices).toBe(1)
  process.emit("SIGINT")
  expect(await p).toBe(130)
  expect(io.out).toBe("started it\n")
})

test("a compaction blocked by an extension is reported as skipped, not failed", async () => {
  const { agent } = await mockSession([
    { text: "r1" },
    { text: "r2", usage: { input: 100_000_000 } },
    { text: "r3" },
  ])
  agent.interceptors.add("compact.before", () => ({ action: "block", reason: "not now" }))
  await runPrint(agent, "q1", false, { io: capture() })
  await runPrint(agent, "q2", false, { io: capture() })
  const io = capture()
  expect(await runPrint(agent, "q3", false, { io })).toBe(0)
  expect(io.err).toBe("● compaction skipped: not now\n")
})

test("json print mode writes one parseable event per line, ending with turn.end", async () => {
  const { agent } = await mockSession([{ text: "hi" }])
  const io = capture()
  expect(await runPrint(agent, "go", true, { io })).toBe(0)
  const events = io.out
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
  expect(events.at(-2).type).toBe("turn.end")
  expect(events.every((e) => typeof e.seq === "number" && e.sessionId)).toBe(true)
})

test("json mode survives non-serializable tool details", async () => {
  const { agent } = await mockSession([{ toolCalls: [{ name: "echo", args: { big: true } }] }, { text: "" }])
  const io = capture()
  await runPrint(agent, "go", true, { io })
  const end = io.out
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .find((e) => e.type === "tool.execute.end")
  expect(end.data.result.details).toEqual({ n: "10" })
  const a: Record<string, unknown> = {}
  a.self = a
  expect(safeJson(a)).toBe('{"self":"[circular]"}')
})

test("model errors exit with code 1", async () => {
  const { agent } = await mockSession([{ error: { message: "nope" } }])
  const io = capture()
  expect(await runPrint(agent, "go", false, { io })).toBe(1)
  expect(io.err).toContain("error: nope")
})

test("Ctrl+C aborts the turn with 130, a second one forces exit, and the listener is removed", async () => {
  const { agent } = await mockSession([{ text: "a long reply that streams slowly", delayMs: 30 }])
  const io = capture()
  let forced = 0
  const before = process.listenerCount("SIGINT")
  const p = runPrint(agent, "go", false, { io, forceExit: () => void forced++ })
  await Bun.sleep(40)
  process.emit("SIGINT")
  process.emit("SIGINT")
  expect(await p).toBe(130)
  expect(forced).toBe(1)
  expect(io.err).toContain("aborted")
  expect(process.listenerCount("SIGINT")).toBe(before)
})

test("a hung event handler does not keep print mode from finishing", async () => {
  const hang: Extension = (api) => {
    api.on("turn.end", () => new Promise(() => {}))
  }
  const { agent } = await mockSession([{ text: "hi" }], {
    noBuiltins: false,
    builtins: async () => [{ source: "hang", extension: hang }],
  })
  const io = capture()
  expect(await runPrint(agent, "go", false, { io, flushTimeoutMs: 50 })).toBe(0)
  expect(io.err).toContain("did not finish")
})

test("an extension's failing handler is its own failure: named once, then counted", async () => {
  const boom: Extension = (api) => {
    api.on("turn.start", () => {
      throw new Error("kaput")
    })
  }
  const seen: string[] = []
  const session = await mockSession(
    Array.from({ length: 11 }, () => ({ text: "hi" })),
    {
      noBuiltins: false,
      builtins: async () => [{ source: "boom", extension: boom }],
      onSubscriberError: (err, ev) => void seen.push(`${ev.type}: ${(err as Error).message}`),
    },
  )
  const { agent } = session
  const errors: string[] = []
  agent.bus.subscribe((e) => {
    if (e.type === "extension.error") errors.push(`${e.data.source}: ${e.data.error}`)
  })
  for (let i = 0; i < 10; i++) await agent.prompt("go")
  await agent.bus.flush()
  expect(seen).toEqual([])
  expect(errors).toEqual([
    "boom: its turn.start handler failed: kaput",
    "boom: its turn.start handler has failed 10 times now; the latest: kaput",
  ])
  // A reload starts the count afresh: the extension is reported again when it still fails.
  await session.reload()
  await agent.prompt("go")
  await agent.bus.flush()
  expect(errors).toHaveLength(3)
  expect(errors[2]).toBe("boom: its turn.start handler failed: kaput")
})

test("a package's extension is named after the package, and its failures say how to turn it off", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-pkg-label-"))
  const file = path.join(dir, "index.ts")
  writeFileSync(file, `export default (api) => { api.on("turn.start", () => { throw new Error("nope") }) }\n`)
  const pkg = {
    name: "lint-hooks",
    scope: "user" as const,
    dir,
    entry: { version: "1.0.0", source: { type: "path" as const, path: dir }, pinned: {}, installedAt: "" },
    manifest: { name: "lint-hooks", version: "1.0.0", extensions: [file], skills: [], commands: {} },
  }
  const { agent, host } = await mockSession([{ text: "hi" }], {
    packages: { packages: [pkg as never], problems: [], skipped: [] },
  })
  expect(host.loaded).toContain("lint-hooks")
  const errors: string[] = []
  agent.bus.subscribe((e) => {
    if (e.type === "extension.error") errors.push(`${e.data.source}: ${e.data.error}`)
  })
  await agent.prompt("go")
  await agent.bus.flush()
  expect(errors).toEqual([
    "lint-hooks: its turn.start handler failed: nope (user package; amira ext disable lint-hooks turns it off)",
  ])
})

test("startup failures are reported: missing extension files and broken built-ins", async () => {
  const { agent, startupEvents } = await mockSession([{ text: "hi" }], {
    extensions: [path.join(here, "does-not-exist.ts")],
    noBuiltins: false,
    builtins: async () => {
      throw new Error("no default export")
    },
  })
  const io = capture()
  await runPrint(agent, "go", false, { io, pending: startupEvents })
  expect(io.err).toContain("does-not-exist.ts")
  expect(io.err).toContain("failed to load built-in extensions: no default export")
})

test("an unknown provider is a usage error", async () => {
  await expect(
    createSession({ model: "nope/x", cwd: here, extensions: [], noBuiltins: true, catalog: false }),
  ).rejects.toThrow(UsageError)
})

test("the amira command: help, version and usage errors have the right exit codes and streams", async () => {
  const main = path.join(here, "..", "src", "main.ts")
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["bun", main, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      // An empty home, so the user's own settings cannot pick a model.
      env: { ...process.env, AMIRA_MODEL: "", AMIRA_HOME: path.join(here, "no-such-home") },
    })
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    return { out, err, code }
  }
  const help = await run("--help")
  expect([help.code, help.out.startsWith("Usage: amira"), help.err]).toEqual([0, true, ""])
  expect((await run("--version")).code).toBe(0)
  const noModel = await run("-p", "hi")
  expect([noModel.code, noModel.out]).toEqual([2, ""])
  expect(noModel.err).toContain('amira: no providers configured; add one with "amira provider add"')
  expect((await run("-m", "nope/x", "-p", "hi")).code).toBe(2)
  const badRef = await run("-m", "foo", "-p", "hi")
  expect(badRef.code).toBe(2)
  expect(badRef.err).toContain("Run amira --help for usage.")
}, 60_000)

test("json mode includes session.start when the session is announced on ready", async () => {
  const { agent } = await mockSession([{ text: "hi" }])
  const io = capture()
  await runPrint(agent, "go", true, { io, onReady: () => agent.start("startup") })
  const first = JSON.parse(io.out.split("\n")[0]!)
  expect(first.type).toBe("session.start")
  expect(first.data.cwd).toBe(here)
})

test("a tool call after unterminated reply text starts on a new line", async () => {
  const { agent } = await mockSession([
    { text: "Fixing:", toolCalls: [{ name: "echo", args: { text: "x" } }] },
    { text: "done" },
  ])
  const lines: string[] = []
  const io: PrintIO = {
    stdout: (s) => void lines.push(`out:${s}`),
    stderr: (s) => void lines.push(`err:${s}`),
  }
  await runPrint(agent, "go", false, { io })
  const i = lines.indexOf("err:● echo x\n")
  expect(lines[i - 1]).toBe("out:\n")
})

test("--shell and --disable-tools decide which tools are hidden", async () => {
  const a = parseCliArgs(
    ["--shell", "bash", "--disable-tools", "glob, grep", "--disable-tools", "write", "x"],
    here,
    {},
  )
  expect(a.shell).toBe("bash")
  expect(a.disabledTools).toEqual(["glob", "grep", "write"])
  expect(() => parseCliArgs(["--shell", "zsh", "x"], here, {})).toThrow(/--shell/)
  const { toolsToDisable } = await import("../src/session.ts")
  expect(toolsToDisable("auto", [])).toEqual([])
  expect(toolsToDisable("bash", ["glob"]).sort()).toEqual(["glob", "powershell"])
  expect(toolsToDisable("powershell", [])).toEqual(["bash"])
})

test("unknown names to disable are reported at startup, with where they came from", async () => {
  const builtins = async () => [
    {
      source: "builtin:test",
      extension: defineExtension((api) => {
        for (const name of ["bash", "glob"])
          api.registerTool(
            defineTool({ name, description: "", parameters: {}, execute: async () => textResult("") }),
          )
      }),
    },
  ]
  const { agent, startupEvents } = await createSession({
    model: "mock/m",
    cwd: here,
    extensions: [],
    noBuiltins: false,
    builtins,
    disabledTools: ["glob", "nope", "powershell"],
    requestedDisabled: { names: ["glob", "nope"], from: "settings tools.disabled" },
    ai: createAi({
      dialects: [createMockDialect([])],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "", defaultModel: { contextWindow: 128_000 } }],
    }),
  })
  const errors = startupEvents.flatMap((e) => (e.type === "extension.error" ? [e.data.error] : []))
  expect(errors).toHaveLength(1)
  expect(errors[0]).toBe(`settings tools.disabled: no tool named "nope"`)
  expect(agent.tools.specs().map((s) => s.name)).toEqual(["bash"])
})

test("the top-level session asks the user to approve; dismissing denies and stops the turn", async () => {
  const { userApprover } = await import("../src/session.ts")
  const bus = new EventBus()
  const ui = new UiRequests(bus)
  const answers: (boolean | null)[] = [true, false, null]
  const asked: string[] = []
  bus.subscribe((e) => {
    if (e.type !== "ui.request" || !answers.length) return
    asked.push(`${e.data.title} | ${e.data.kind === "confirm" ? e.data.message : ""}`)
    ui.respond(e.data.requestId, answers.shift())
  })
  const approve = userApprover(ui)
  const request = {
    sessionId: "s",
    toolCallId: "t",
    name: "bash",
    args: { command: "rm x" },
    reason: "policy",
  }
  const signal = new AbortController().signal
  expect(await approve(request, signal)).toEqual({ approved: true, by: "user" })
  expect(await approve(request, signal)).toEqual({ approved: false, reason: "the user said no" })
  expect(await approve(request, signal)).toEqual({
    approved: false,
    reason: "the user dismissed the question and stopped the turn",
    interrupt: true,
  })
  // Without a presenter the arguments show as they are, with what "don't ask again" covers.
  expect(asked[0]).toBe(
    `Allow bash? | policy\n{"command":"rm x"}\n"Don't ask again" covers bash asked about for: policy`,
  )
  // An interrupted turn cancels the question: that is no dismissal.
  const stop = new AbortController()
  const pending = approve({ ...request, reason: "other" }, stop.signal)
  stop.abort()
  expect(await pending).toEqual({ approved: false, reason: "the turn was interrupted" })
  ui.unavailable = "print mode"
  expect(await approve({ ...request, reason: "third" }, signal)).toEqual({
    approved: false,
    reason: "nobody can approve it (print mode)",
  })
})

test("an approval shows what the call would do as its tool presents it", async () => {
  const { userApprover, approvalPreview } = await import("../src/session.ts")
  const { builtinPresenters } = await import("@amira/builtin-tools")
  expect(approvalPreview({ command: "make build\necho done" }, builtinPresenters.bash)).toEqual([
    { kind: "code", text: "make build" },
    { kind: "code", text: "echo done" },
  ])
  const edit = approvalPreview({ path: "a.ts", old_string: "one", new_string: "two" }, builtinPresenters.edit)
  expect(edit?.[0]).toEqual({ kind: "muted", text: "a.ts" })
  expect(edit?.map((l) => l.kind)).toContain("diff-add")
  expect(approvalPreview({ x: 1 }, undefined)).toBeUndefined()
  const bus = new EventBus()
  const ui = new UiRequests(bus)
  const asked: unknown[] = []
  bus.subscribe((e) => {
    if (e.type !== "ui.request") return
    asked.push(e.data)
    ui.respond(e.data.requestId, true)
  })
  const approve = userApprover(ui, { presenters: { get: (n) => builtinPresenters[n] } })
  const request = { sessionId: "s", toolCallId: "t", name: "bash", args: { command: "make" }, reason: "p" }
  await approve(request, new AbortController().signal)
  expect(asked[0]).toMatchObject({
    message: `p\n"Don't ask again" covers bash asked about for: p`,
    preview: [{ kind: "code", text: "make" }],
    always: true,
  })
})

test("an approval may be given for the rest of the session, or refused with what to do instead", async () => {
  const { userApprover } = await import("../src/session.ts")
  const bus = new EventBus()
  const ui = new UiRequests(bus)
  const answers: unknown[] = [{ other: "use trash instead" }, "always"]
  const asked: unknown[] = []
  bus.subscribe((e) => {
    if (e.type !== "ui.request") return
    asked.push(e.data)
    ui.respond(e.data.requestId, answers.shift())
  })
  const approve = userApprover(ui)
  const request = {
    sessionId: "s",
    toolCallId: "t",
    name: "bash",
    args: { command: "rm x" },
    reason: "policy",
  }
  const signal = new AbortController().signal
  expect(await approve(request, signal)).toEqual({
    approved: false,
    reason: "the user said no: use trash instead",
  })
  expect(asked[0]).toMatchObject({
    kind: "confirm",
    always: true,
    other: true,
    source: "approval",
  })
  expect(await approve(request, signal)).toEqual({ approved: true, by: "user" })
  // Not asked again for the same tool and reason; asked for another reason.
  expect(await approve({ ...request, args: { command: "rm y" } }, signal)).toEqual({
    approved: true,
    by: "rule",
  })
  expect(asked).toHaveLength(2)
  answers.push(false)
  expect(await approve({ ...request, reason: "other policy" }, signal)).toEqual({
    approved: false,
    reason: "the user said no",
  })
  expect(asked).toHaveLength(3)
})

test("the top-level session's questions go to the user; print mode says nobody can answer", async () => {
  const { userAsker } = await import("../src/session.ts")
  const bus = new EventBus()
  const ui = new UiRequests(bus)
  const replies: unknown[] = [[{ selected: ["A"] }], null]
  bus.subscribe((e) => {
    if (e.type === "ui.request") ui.respond(e.data.requestId, replies.shift())
  })
  const ask = userAsker(ui)
  const questions = [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }]
  const request = { sessionId: "s", questions }
  const signal = new AbortController().signal
  expect(await ask(request, signal)).toEqual({ answers: [{ selected: ["A"] }] })
  expect(await ask(request, signal)).toEqual({ declined: true })
  ui.unavailable = "print mode"
  expect(await ask(request, signal)).toEqual({ unavailable: "print mode" })
})

test("plain print mode shows extensions' notices on stderr, problems with their level", async () => {
  const { agent } = await mockSession([{ toolCalls: [{ name: "note", args: {} }] }, { text: "all done" }])
  agent.tools.register(
    defineTool({
      name: "note",
      description: "",
      parameters: {},
      execute: async () => {
        agent.bus.emit(
          "extension.notice",
          { source: "x", text: "formatted a.ts", level: "success" },
          { sessionId: "host" },
        )
        agent.bus.emit(
          "extension.notice",
          { source: "x", text: "tests failed", level: "error" },
          { sessionId: "host" },
        )
        return textResult("ok")
      },
    }),
    "test",
  )
  const io = capture()
  expect(await runPrint(agent, "go", false, { io })).toBe(0)
  expect(io.out).toBe("all done\n")
  expect(io.err).toBe("● note \n● formatted a.ts\nerror: tests failed\n")
})
