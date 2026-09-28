import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { parseCliArgs, UsageError } from "../src/args.ts"
import { runPrint } from "../src/print.ts"
import { createSession } from "../src/session.ts"

test("parses print mode, repeatable extensions and the positional prompt", () => {
  const a = parseCliArgs(["-p", "--json", "-m", "deepseek/x", "-e", "a.ts", "-e", "b.ts", "fix", "it"], "/w")
  expect(a).toMatchObject({
    print: true,
    json: true,
    model: "deepseek/x",
    extensions: ["a.ts", "b.ts"],
    prompt: "fix it",
    cwd: "/w",
  })
})

test("rejects inconsistent flags", () => {
  expect(() => parseCliArgs(["--json", "hi"])).toThrow(UsageError)
  expect(() => parseCliArgs(["-p"])).toThrow(UsageError)
  expect(() => parseCliArgs(["--nope"])).toThrow(UsageError)
})

async function mockSession(steps: Parameters<typeof createMockDialect>[0]) {
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = await createSession({
    model: "mock/m",
    cwd: process.cwd(),
    extensions: [],
    noBuiltins: true,
    ai,
  })
  agent.tools.register(
    defineTool({ name: "echo", description: "", parameters: {}, execute: async () => textResult("ok") }),
    "test",
  )
  return agent
}

test("plain print mode streams text to stdout and tool activity to stderr", async () => {
  const agent = await mockSession([
    { toolCalls: [{ name: "echo", args: { text: "x" } }] },
    { text: "all done" },
  ])
  let out = ""
  let err = ""
  const code = await runPrint(agent, "go", false, { stdout: (s) => (out += s), stderr: (s) => (err += s) })
  expect(code).toBe(0)
  expect(out).toBe("all done\n")
  expect(err).toBe("● echo x\n")
})

test("json print mode writes one parseable event per line, ending with turn.end", async () => {
  const agent = await mockSession([{ text: "hi" }])
  let out = ""
  const code = await runPrint(agent, "go", true, { stdout: (s) => (out += s), stderr: () => {} })
  expect(code).toBe(0)
  const events = out
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
  expect(events.at(-2).type).toBe("turn.end")
  expect(events.every((e) => typeof e.seq === "number" && e.sessionId)).toBe(true)
})

test("model errors exit with code 1", async () => {
  const agent = await mockSession([{ error: { message: "nope" } }])
  let err = ""
  const code = await runPrint(agent, "go", false, { stdout: () => {}, stderr: (s) => (err += s) })
  expect(code).toBe(1)
  expect(err).toContain("error: nope")
})
