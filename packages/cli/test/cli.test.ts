import { expect, test } from "bun:test"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { defineTool, type Extension, textResult } from "@amira/api"
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
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
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

test("subscriber failures reach onSubscriberError", async () => {
  const boom: Extension = (api) => {
    api.on("turn.start", () => {
      throw new Error("kaput")
    })
  }
  const seen: string[] = []
  const { agent } = await mockSession([{ text: "hi" }], {
    noBuiltins: false,
    builtins: async () => [{ source: "boom", extension: boom }],
    onSubscriberError: (err, ev) => void seen.push(`${ev.type}: ${(err as Error).message}`),
  })
  await runPrint(agent, "go", false, { io: capture() })
  expect(seen).toEqual(["turn.start: kaput"])
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
    createSession({ model: "nope/x", cwd: here, extensions: [], noBuiltins: true }),
  ).rejects.toThrow(UsageError)
})

test("the amira command: help, version and usage errors have the right exit codes and streams", async () => {
  const main = path.join(here, "..", "src", "main.ts")
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["bun", main, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AMIRA_MODEL: "" },
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
  expect(noModel.err).toContain("no model selected")
  expect((await run("-m", "nope/x", "-p", "hi")).code).toBe(2)
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
