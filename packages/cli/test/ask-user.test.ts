import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep, type ModelRequest } from "@amira/ai"
import type { Extension } from "@amira/api"
import agentExtension from "../../../extensions/agent/src/index.ts"
import builtinTools from "../../../extensions/builtin-tools/src/index.ts"
import { type PrintIO, runPrint } from "../src/print.ts"
import { runRpc } from "../src/rpc.ts"
import { rpcSchema } from "../src/rpc-schema.ts"
import { createSession } from "../src/session.ts"

/** ask_user end to end with the mock model: rpc clients answer it, print mode cannot. */

const here = import.meta.dir

type Line = Record<string, any>

const QUESTIONS = [
  {
    question: "Which approach do you prefer?",
    header: "Approach",
    options: [
      { label: "Rewrite (Recommended)", description: "Start the module over" },
      { label: "Patch", description: "Fix the bug in place" },
    ],
  },
  {
    question: "What else should I do?",
    header: "Extras",
    options: [
      { label: "Tests", description: "Add tests" },
      { label: "Docs", description: "Update the docs" },
    ],
    multiSelect: true,
  },
]

async function session(
  steps: MockStep[],
  extensions: Extension[] = [builtinTools],
  extra: { nonInteractive?: boolean } = {},
) {
  const mock = createMockDialect(steps)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const s = await createSession({
    model: "mock/m",
    cwd: here,
    extensions: [],
    noBuiltins: false,
    ai,
    builtins: async () => extensions.map((extension, i) => ({ source: `ext${i}`, extension })),
    ...extra,
  })
  return { ...s, mock }
}

test("a non-interactive session hides ask_user and tells the model to decide", async () => {
  const s = await session([{ text: "done" }], [builtinTools], { nonInteractive: true })
  const io: PrintIO = { stdout: () => {}, stderr: () => {} }
  expect(await runPrint(s.agent, "go", false, { io })).toBe(0)
  const request = s.mock.requests[0]!
  expect(request.tools.some((tool) => tool.name === "ask_user")).toBe(false)
  expect(request.systemPrompt).toContain("Run mode: non-interactive")
  expect(request.systemPrompt).toContain("decide for yourself")
})

function inProcess(s: Awaited<ReturnType<typeof session>>, withUi = true) {
  const queue: string[] = []
  let wake: (() => void) | undefined
  let ended = false
  const lines: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) yield queue.shift()!
        else if (ended) return
        else await new Promise<void>((r) => (wake = r))
      }
    },
  }
  const out: Line[] = []
  const done = runRpc(
    { agent: s.agent, ai: s.ai, ...(withUi ? { ui: s.host.ui } : {}) },
    { io: { lines, write: (line) => void out.push(JSON.parse(line)) } },
  )
  const until = async (match: (l: Line) => boolean, what: string) => {
    const deadline = performance.now() + 10_000
    while (!out.some(match)) {
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await Bun.sleep(5)
    }
    return out.find(match)!
  }
  const call = (cmd: Record<string, unknown>) => {
    queue.push(JSON.stringify(cmd))
    wake?.()
    return until((l) => l.id === cmd.id && "ok" in l, `response ${cmd.id}`)
  }
  const end = () => {
    ended = true
    wake?.()
    return done
  }
  return { out, until, call, end }
}

test("rpc without a UI client hides ask_user and tells the model to decide", async () => {
  const s = await session([
    (req) => ({ text: req.systemPrompt.includes("non-interactive") ? "done" : "bad" }),
  ])
  const rpc = inProcess(s, false)
  await rpc.call({ id: 1, cmd: "prompt", text: "go" })
  await rpc.until((l) => l.type === "turn.end", "the turn's end")
  expect(await rpc.end()).toBe(0)
  const request = s.mock.requests[0]!
  expect(request.tools.some((tool) => tool.name === "ask_user")).toBe(false)
  expect(request.systemPrompt).toContain("Run mode: non-interactive")
})

const toolResultText = (s: { agent: { messages: unknown[] } }, name = "ask_user") => {
  const m = s.agent.messages.find(
    (m): m is { role: "toolResult"; toolName: string; content: { text: string }[] } =>
      (m as { role?: string }).role === "toolResult" && (m as { toolName?: string }).toolName === name,
  )
  return m?.content[0]?.text
}

test("an rpc client gets ask_user as a ui.request of kind ask and answers with the selections", async () => {
  const s = await session([
    { toolCalls: [{ name: "ask_user", args: { questions: QUESTIONS } }] },
    { text: "ok" },
  ])
  const rpc = inProcess(s)
  await rpc.call({ id: 1, cmd: "prompt", text: "go" })
  const request = await rpc.until((l) => l.type === "ui.request", "the question")
  expect(request.data).toMatchObject({ kind: "ask", title: "2 questions", questions: QUESTIONS })
  const bad = await rpc.call({
    id: 2,
    cmd: "ui.respond",
    requestId: request.data.requestId,
    value: ["Patch"],
  })
  expect(bad).toMatchObject({ ok: false, error: { code: "invalid_params" } })
  const value = [{ selected: ["Patch"] }, { selected: ["Tests"], other: "and a changelog" }]
  expect(
    await rpc.call({ id: 3, cmd: "ui.respond", requestId: request.data.requestId, value }),
  ).toMatchObject({
    ok: true,
  })
  await rpc.until((l) => l.type === "turn.end", "the turn's end")
  expect(await rpc.end()).toBe(0)
  expect(toolResultText(s)).toBe(
    [
      "The user answered:",
      "1. Which approach do you prefer?",
      "   → Patch",
      "2. What else should I do?",
      '   → Tests, (own words) "and a changelog"',
    ].join("\n"),
  )
})

test("an rpc client that cancels leaves the model a declined answer", async () => {
  const s = await session([
    { toolCalls: [{ name: "ask_user", args: { questions: QUESTIONS } }] },
    { text: "ok" },
  ])
  const rpc = inProcess(s)
  await rpc.call({ id: 1, cmd: "prompt", text: "go" })
  const request = await rpc.until((l) => l.type === "ui.request", "the question")
  await rpc.call({ id: 2, cmd: "ui.respond", requestId: request.data.requestId, value: null })
  await rpc.until((l) => l.type === "turn.end", "the turn's end")
  expect(await rpc.end()).toBe(0)
  expect(toolResultText(s)).toStartWith("The user declined to answer.")
})

test("in print mode ask_user is not offered", async () => {
  const s = await session([
    { toolCalls: [{ name: "ask_user", args: { questions: QUESTIONS } }] },
    { text: "ok" },
  ])
  const errors: string[] = []
  const io: PrintIO = { stdout: () => {}, stderr: (t) => void errors.push(t) }
  expect(await runPrint(s.agent, "go", false, { io, ui: s.host.ui })).toBe(0)
  expect(toolResultText(s)).toStartWith('Unknown tool "ask_user".')
  expect(errors.join("")).not.toContain("cancelled")
})

test("a sub-agent's question goes to its commander, which passes it on to the rpc client", async () => {
  const text = (req: ModelRequest, i: number) => {
    const c = req.messages.at(i)?.content[0]
    return c?.type === "text" ? c.text : ""
  }
  const route = (req: ModelRequest) => {
    const last = req.messages.at(-1)
    if (text(req, -1).includes("asks you this question")) return { text: "ASK_USER" }
    if (text(req, 0) === "child task") {
      if (last?.role === "toolResult") return { text: "child done" }
      return { toolCalls: [{ name: "ask_user", args: { questions: [QUESTIONS[0]] } }] }
    }
    if (text(req, -1) === "go") {
      return {
        toolCalls: [
          { name: "agent", args: { tasks: [{ title: "Pick an approach", prompt: "child task" }] } },
        ],
      }
    }
    return { text: "main done" }
  }
  const s = await session(
    Array.from({ length: 10 }, () => route),
    [builtinTools, agentExtension],
  )
  const rpc = inProcess(s)
  await rpc.call({ id: 1, cmd: "prompt", text: "go" })
  const request = await rpc.until((l) => l.type === "ui.request", "the question")
  // It reaches the user marked as a sub-agent's.
  expect(request.data).toMatchObject({
    kind: "ask",
    source: "sub-agent",
    title: "Which approach do you prefer?",
  })
  await rpc.call({
    id: 2,
    cmd: "ui.respond",
    requestId: request.data.requestId,
    value: [{ selected: ["Patch"] }],
  })
  const end = await rpc.until(
    (l) => l.type === "tool.execute.end" && l.data.name === "ask_user",
    "the sub-agent's ask_user result",
  )
  await rpc.until((l) => l.type === "subagent.end", "the sub-agent's end")
  expect(await rpc.end()).toBe(0)
  const start = rpc.out.find((l) => l.type === "subagent.start")
  expect(end.sessionId).toBe(start?.data.childSessionId)
  expect(end.data.result.content[0].text).toBe(
    "The user answered:\n1. Which approach do you prefer?\n   → Patch",
  )
})

test("the rpc schema describes ask requests and their answers", () => {
  const schema = JSON.stringify(rpcSchema())
  expect(schema).toContain('"ask"')
  expect(schema).toContain("AskAnswer")
  expect(schema).toContain("AskQuestion")
})
