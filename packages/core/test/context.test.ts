import { expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  type AssistantMessage,
  createAi,
  createMockDialect,
  type Message,
  type MockReply,
  type ModelRequest,
  type ToolResultMessage,
} from "@amira/ai"
import { ARTIFACT_HEADER, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { estimateTokens } from "../src/compaction.ts"
import { agingCandidates, type ContextView, projectMessages } from "../src/context.ts"
import { EventBus } from "../src/event-bus.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

// Context management (A0–A3): what requests carry is a projection of the session, which itself
// stays whole; views are decided once and repeated verbatim; calls and results always pair.

async function tempDir(prefix = "amira-context-") {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

/** A read tool like the built-in one, for files in the working directory. */
const read = defineTool<{ path: string; offset?: number; limit?: number; force?: boolean }>({
  name: "read",
  description: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "integer" },
      limit: { type: "integer" },
      force: { type: "boolean" },
    },
  },
  concurrency: "parallel",
  async execute({ path: p, offset = 1, limit = 2000 }, ctx) {
    try {
      const lines = (await readFile(path.resolve(ctx.cwd, p), "utf8")).split("\n")
      return textResult(
        lines
          .slice(offset - 1, offset - 1 + limit)
          .map((l, i) => `${String(i + offset).padStart(6)}\t${l}`)
          .join("\n"),
      )
    } catch {
      return textResult(`File not found: ${p}`, true)
    }
  },
})

/** Returns `size` characters of a numbered log, different for each `n`. */
const big = defineTool<{ n: number; size?: number }>({
  name: "big",
  description: "big",
  parameters: { type: "object", properties: { n: { type: "integer" }, size: { type: "integer" } } },
  concurrency: "parallel",
  execute: async ({ n, size = 6000 }) => textResult(logText(n, size)),
})

function logText(n: number, size: number): string {
  const lines: string[] = []
  let length = 0
  for (let i = 1; length < size; i++) {
    const line = `[run ${n}] step ${i}: compiled module ${i * 7} ok`
    lines.push(line)
    length += line.length + 1
  }
  return lines.join("\n").slice(0, size)
}

/** Usage as a model would count it: about what estimateTokens says of the request. */
function usageOf(req: ModelRequest) {
  const input =
    estimateTokens(req.messages) + Math.ceil((req.systemPrompt.length + JSON.stringify(req.tools).length) / 4)
  return { input, output: 10 }
}

function setup(opts: {
  steps?: (MockReply | ((req: ModelRequest) => MockReply))[]
  window?: number
  session?: SessionStore
  messages?: Message[]
  views?: ReadonlyMap<Message, ContextView>
  cwd?: string
  context?: ConstructorParameters<typeof Agent>[0]["context"]
  compaction?: ConstructorParameters<typeof Agent>[0]["compaction"]
}) {
  const mock = createMockDialect(opts.steps ?? [])
  const ai = createAi({
    dialects: [mock],
    providers: [
      { id: "mock", dialect: "mock", baseUrl: "", defaultModel: { contextWindow: opts.window ?? 128_000 } },
    ],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const tools = new ToolRegistry()
  tools.register(read, "test")
  tools.register(big, "test")
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: opts.cwd ?? process.cwd(),
    systemPrompt: "sys",
    bus,
    tools,
    ...(opts.session ? { session: opts.session } : {}),
    ...(opts.messages ? { messages: opts.messages } : {}),
    ...(opts.views ? { views: opts.views } : {}),
    ...(opts.context ? { context: opts.context } : {}),
    ...(opts.compaction ? { compaction: opts.compaction } : {}),
  })
  return { agent, mock, ai, bus, tools }
}

const textOf = (m: Message | undefined) =>
  (m?.content ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("")

const results = (messages: readonly Message[]) =>
  messages.filter((m): m is ToolResultMessage => m.role === "toolResult")

/** Every call in `messages` has exactly one result right after its reply, and nothing else does. */
function expectPaired(messages: readonly Message[]) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role !== "assistant") continue
    const ids = m.content.flatMap((b) => (b.type === "toolCall" ? [b.id] : []))
    const after = messages.slice(i + 1, i + 1 + ids.length)
    expect(after.map((r) => (r.role === "toolResult" ? r.toolCallId : r.role))).toEqual(ids)
  }
  const calls = messages.flatMap((m) =>
    m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall") : [],
  )
  expect(results(messages)).toHaveLength(calls.length)
}

// ---- A0: the projection ----

test("projectMessages swaps only the content of results with a view and keeps pairing", () => {
  const call: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "big", args: {} }],
    model: { provider: "mock", model: "test" },
  }
  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "big",
    content: [{ type: "text", text: "LONG" }],
    isError: true,
  }
  const history: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }, call, result]
  const views = new Map<Message, ContextView>([[result, { kind: "aged", text: "STUB", epoch: 1 }]])
  const out = projectMessages(history, views)
  expect(out[0]).toBe(history[0])
  expect(out[1]).toBe(call)
  expect(out[2]).toEqual({ ...result, content: [{ type: "text", text: "STUB" }] })
  // The session's own message is never changed.
  expect(textOf(result)).toBe("LONG")
  expectPaired(out)
  // The same view gives the same text every time.
  expect(JSON.stringify(projectMessages(history, views))).toBe(JSON.stringify(out))
})

// ---- A1: large outputs ----

test("a large result of any tool is saved as an artifact; the request gets a preview with its id", async () => {
  const mcp = defineTool<Record<string, never>>({
    name: "mcp__docs__search",
    description: "an MCP tool",
    parameters: { type: "object" },
    execute: async () => ({
      content: [
        { type: "text", text: logText(1, 30_000) },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ],
    }),
  })
  const { agent, mock, tools } = setup({
    steps: [{ toolCalls: [{ name: "mcp__docs__search", args: {}, id: "c1" }] }, { text: "done" }],
  })
  tools.register(mcp, "test")
  await agent.prompt("go")
  const sent = mock.requests[1]!.messages.at(-1)!
  const preview = textOf(sent)
  const id = ARTIFACT_HEADER.exec(preview)?.[1]
  expect(id).toBeDefined()
  expect(preview.length).toBeLessThan(8_600)
  // The image stays, after the preview.
  expect(sent.content.map((b) => b.type)).toEqual(["text", "image"])
  const info = agent.artifacts.find(id!)!
  expect(info.tool).toBe("mcp__docs__search")
  expect(readFileSync(info.path, "utf8")).toBe(logText(1, 30_000))
  expect(info.complete).toBe(true)
  await rm(path.dirname(info.path), { recursive: true, force: true })
})

test("the size limit is exclusive and configurable", async () => {
  const exact = defineTool<{ size: number }>({
    name: "exact",
    description: "exact",
    parameters: { type: "object", properties: { size: { type: "integer" } } },
    execute: async ({ size }) => textResult("x".repeat(size)),
  })
  const { agent, mock, tools } = setup({
    steps: [
      { toolCalls: [{ name: "exact", args: { size: 2000 }, id: "a" }] },
      { toolCalls: [{ name: "exact", args: { size: 2001 }, id: "b" }] },
      { text: "done" },
    ],
    context: { saveAbove: 2000, previewChars: 600 },
  })
  tools.register(exact, "test")
  await agent.prompt("go")
  expect(textOf(mock.requests[1]!.messages.at(-1))).toBe("x".repeat(2000))
  const cut = textOf(mock.requests[2]!.messages.at(-1))
  expect(cut).toMatch(ARTIFACT_HEADER)
  expect(cut.length).toBeLessThan(800)
})

test("an artifact that cannot be written leaves a preview that says so and names none", async () => {
  const dir = await tempDir()
  const session = SessionStore.create({ cwd: dir, dir })
  // A file where the session's artifact directory would go.
  writeFileSync(path.join(dir, `${session.id}.assets`), "in the way")
  const { agent, mock } = setup({
    session,
    steps: [{ toolCalls: [{ name: "big", args: { n: 1, size: 40_000 }, id: "c1" }] }, { text: "done" }],
  })
  await agent.prompt("go")
  const preview = textOf(mock.requests[1]!.messages.at(-1))
  expect(preview).toStartWith("[Output too long: 40,000 characters")
  expect(preview).toContain("could not be saved")
  expect(preview).not.toMatch(/a_[0-9a-f]{10}/)
  await rm(dir, { recursive: true, force: true })
})

test("past the session's quota outputs are only previewed, and earlier artifacts stay", async () => {
  const dir = await tempDir()
  const session = SessionStore.create({ cwd: dir, dir })
  const { agent, mock } = setup({
    session,
    context: { quotaBytes: 50_000 },
    steps: [
      { toolCalls: [{ name: "big", args: { n: 1, size: 30_000 }, id: "c1" }] },
      { toolCalls: [{ name: "big", args: { n: 2, size: 30_000 }, id: "c2" }] },
      { text: "done" },
    ],
  })
  await agent.prompt("go")
  const first = textOf(mock.requests[1]!.messages.at(-1))
  const second = textOf(mock.requests[2]!.messages.at(-1))
  const id = ARTIFACT_HEADER.exec(first)![1]!
  expect(existsSync(agent.artifacts.find(id)!.path)).toBe(true)
  expect(second).toContain("quota")
  expect(second).toContain("/prune")
  await rm(dir, { recursive: true, force: true })
})

test("a tool that returns after an interrupt (within the grace period) still gets its output saved", async () => {
  let release!: () => void
  const slow = defineTool<Record<string, never>>({
    name: "slow",
    description: "slow",
    parameters: { type: "object" },
    execute: async () => {
      await new Promise<void>((r) => {
        release = r
      })
      return textResult(logText(9, 30_000), true)
    },
  })
  const { agent, tools } = setup({ steps: [{ toolCalls: [{ name: "slow", args: {}, id: "c1" }] }] })
  tools.register(slow, "test")
  const turn = agent.prompt("go")
  while (!release) await Bun.sleep(5)
  agent.abort()
  release()
  await turn
  const result = results(agent.messages)[0]!
  const id = ARTIFACT_HEADER.exec(textOf(result))?.[1]
  expect(id).toBeDefined()
  expect(readFileSync(agent.artifacts.find(id!)!.path, "utf8")).toBe(logText(9, 30_000))
})

test("artifacts are found again after a resume, through the tool session", async () => {
  const dir = await tempDir()
  const session = SessionStore.create({ cwd: dir, dir })
  const { agent } = setup({
    session,
    steps: [{ toolCalls: [{ name: "big", args: { n: 3, size: 20_000 }, id: "c1" }] }, { text: "done" }],
  })
  await agent.prompt("go")
  const id = ARTIFACT_HEADER.exec(textOf(results(agent.messages)[0]))![1]!
  const { agent: resumed } = setup({ session: SessionStore.open(session.file) })
  expect(resumed.artifacts.find(id)?.chars).toBe(20_000)
  expect(resumed.artifacts.dir).toBe(path.join(dir, `${session.id}.assets`, "outputs"))
  await rm(dir, { recursive: true, force: true })
})

// ---- A2: repeated reads ----

/** A file long enough that a note about it is shorter than its text. */
const doc = (middle = "two") =>
  ["one", middle, "three", ...Array.from({ length: 30 }, (_, i) => `filler line ${i + 1}`)].join("\n")

/** A tool that runs a test's action by name, e.g. to change a file between two reads. */
function actTool(actions: Record<string, () => Promise<unknown> | unknown>) {
  return defineTool<{ name: string }>({
    name: "act",
    description: "act",
    parameters: { type: "object", properties: { name: { type: "string" } } },
    execute: async ({ name }) => {
      await actions[name]?.()
      return textResult(`did ${name}`)
    },
  })
}

const readCall = (id: string, args: Record<string, unknown> = {}): MockReply => ({
  toolCalls: [{ name: "read", args: { path: "a.txt", ...args }, id }],
})
const actCall = (name: string): MockReply => ({
  toolCalls: [{ name: "act", args: { name }, id: `act-${name}` }],
})

/** Runs reads and actions in order; returns the results the last request carried. */
async function runReads(
  dir: string,
  steps: MockReply[],
  actions: Record<string, () => Promise<unknown> | unknown> = {},
  context?: ConstructorParameters<typeof Agent>[0]["context"],
) {
  const { agent, mock, tools } = setup({
    cwd: dir,
    steps: [...steps, { text: "done" }],
    ...(context ? { context } : {}),
  })
  tools.register(actTool(actions), "test")
  await agent.prompt("go")
  const sent = results(mock.requests.at(-1)!.messages).filter((r) => r.toolName === "read")
  expectPaired(mock.requests.at(-1)!.messages)
  return { agent, mock, sent: sent.map((r) => textOf(r)) }
}

const isNote = (t: string | undefined) => t?.startsWith("[Unchanged: ") ?? false

test("a read returning what the latest read of the same range returned is sent as a note", async () => {
  const dir = await tempDir()
  await writeFile(path.join(dir, "a.txt"), doc())
  const { agent, mock, sent } = await runReads(dir, [readCall("r1"), readCall("r2", { path: "./a.txt" })])
  expect(sent[0]).toContain("two")
  expect(sent[1]).toStartWith(
    "[Unchanged: this read returned exactly the same text as the earlier read call r1",
  )
  expect(sent[1]).toContain("force: true")
  // The earlier read is never rewritten: the prefix sent before is sent again as it was.
  const [before, after] = [mock.requests[1]!.messages, mock.requests[2]!.messages]
  expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before))
  // The session keeps both reads whole.
  expect(textOf(results(agent.messages)[1])).toContain("two")
  await rm(dir, { recursive: true, force: true })
})

test("a repeated read is sent whole for another range, when forced, or when the file changed", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "a.txt")
  const reset = () => writeFile(file, doc())
  await reset()
  expect((await runReads(dir, [readCall("r1"), readCall("r2", { offset: 2 })])).sent.some(isNote)).toBe(false)
  expect((await runReads(dir, [readCall("r1"), readCall("r2", { limit: 2 })])).sent.some(isNote)).toBe(false)
  expect((await runReads(dir, [readCall("r1"), readCall("r2", { force: true })])).sent.some(isNote)).toBe(
    false,
  )
  // Same size and modification time, other content: the content decides, not the metadata.
  const sameStat = await runReads(dir, [readCall("r1"), actCall("swap"), readCall("r2")], {
    swap: async () => {
      const { statSync } = await import("node:fs")
      const st = statSync(file)
      await writeFile(file, doc("TWO"))
      await utimes(file, st.atime, st.mtime)
    },
  })
  expect(sameStat.sent[1]).toContain("TWO")
  await reset()
  // Deleted: an error, never a note; re-created with the same text: identical, so a note.
  const gone = await runReads(dir, [readCall("r1"), actCall("rm"), readCall("r2")], { rm: () => rm(file) })
  expect(gone.sent[1]).toStartWith("File not found")
  await reset()
  const back = await runReads(dir, [readCall("r1"), actCall("again"), readCall("r2")], {
    again: async () => {
      await rm(file)
      await reset()
    },
  })
  expect(isNote(back.sent[1])).toBe(true)
  // The latest read decides: v1, v2, then v1 again is sent whole (the range changed since v1's read).
  await reset()
  const flip = await runReads(
    dir,
    [readCall("r1"), actCall("v2"), readCall("r2"), actCall("v1"), readCall("r3")],
    {
      v2: () => writeFile(file, doc("2")),
      v1: reset,
    },
  )
  expect(flip.sent.some(isNote)).toBe(false)
  // Off in the settings.
  await reset()
  expect(
    (await runReads(dir, [readCall("r1"), readCall("r2")], {}, { dedupeReads: false })).sent.some(isNote),
  ).toBe(false)
  await rm(dir, { recursive: true, force: true })
})

test("a read shorter than the note about it is sent whole", async () => {
  const dir = await tempDir()
  await writeFile(path.join(dir, "a.txt"), "x")
  expect((await runReads(dir, [readCall("r1"), readCall("r2")])).sent).toEqual(["     1\tx", "     1\tx"])
  await rm(dir, { recursive: true, force: true })
})

test("two identical reads in one batch: the second is the note; failed reads are never notes", async () => {
  const dir = await tempDir()
  await writeFile(path.join(dir, "a.txt"), doc())
  const batch = await runReads(dir, [
    {
      toolCalls: [
        { name: "read", args: { path: "a.txt" }, id: "p1" },
        { name: "read", args: { path: "a.txt" }, id: "p2" },
      ],
    },
  ])
  expect(isNote(batch.sent[0])).toBe(false)
  expect(batch.sent[1]).toContain("earlier read call p1")
  const missing = await runReads(dir, [
    readCall("m1", { path: "missing.txt" }),
    readCall("m2", { path: "missing.txt" }),
  ])
  expect(missing.sent.every((t) => t.startsWith("File not found"))).toBe(true)
  await rm(dir, { recursive: true, force: true })
})

test("after a compaction summarized the earlier read, the same read is sent whole again", async () => {
  const dir = await tempDir()
  await writeFile(path.join(dir, "a.txt"), doc())
  const { agent, mock } = setup({ cwd: dir, compaction: { auto: false } })
  const turn = (...steps: MockReply[]) => {
    mock.push(...steps)
    return agent.prompt("go")
  }
  await turn(readCall("r1"), { text: "read it" })
  await turn({ text: "two" })
  await turn({ text: "three" })
  mock.push({ text: "SUMMARY: read a.txt" })
  expect(await agent.compact()).toBe(true)
  await turn(readCall("r2"), { text: "done" })
  const sent = results(mock.requests.at(-1)!.messages)
  expect(sent).toHaveLength(1)
  expect(textOf(sent[0])).toContain("two")
  await rm(dir, { recursive: true, force: true })
})

test("notes are restored with the session, and only on the branch that recorded them", async () => {
  const dir = await tempDir()
  await writeFile(path.join(dir, "a.txt"), doc())
  const session = SessionStore.create({ cwd: dir, dir })
  const first = setup({ cwd: dir, session, steps: [readCall("r1"), readCall("r2"), { text: "done" }] })
  await first.agent.prompt("go")
  const sentLast = first.mock.requests.at(-1)!.messages
  const resumed = setup({ cwd: dir, session: SessionStore.open(session.file) })
  const preview = (await resumed.agent.preview()).messages
  expect(JSON.stringify(preview.slice(0, sentLast.length))).toBe(JSON.stringify(sentLast))
  // Back to the second read itself, before the entry that recorded its note: sent whole.
  const store = SessionStore.open(session.file)
  const dupEntry = store.entries.find(
    (e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === "r2",
  )!
  store.append({ type: "checkout", target: dupEntry.id })
  const rewound = setup({ cwd: dir, session: SessionStore.open(session.file) })
  const whole = results((await rewound.agent.preview()).messages)
  expect(whole.map((r) => isNote(textOf(r)))).toEqual([false, false])
  await rm(dir, { recursive: true, force: true })
})

// ---- A3: aging ----

const ref = { provider: "mock", model: "test" }

/** Turns of history: a prompt, a call to big, its result, an answer. */
function history(
  turns: number,
  size: number,
  opts: { lastUsage?: number; thinking?: AssistantMessage["content"] } = {},
) {
  const out: Message[] = []
  for (let i = 1; i <= turns; i++) {
    out.push({ role: "user", content: [{ type: "text", text: `turn ${i}` }] })
    out.push({
      role: "assistant",
      content: [{ type: "toolCall", id: `c${i}`, name: "big", args: { n: i } }],
      model: ref,
    })
    out.push({
      role: "toolResult",
      toolCallId: `c${i}`,
      toolName: "big",
      content: [{ type: "text", text: logText(i, size) }],
      isError: false,
    })
    const last = i === turns
    out.push({
      role: "assistant",
      content: [...(last && opts.thinking ? opts.thinking : []), { type: "text", text: `ok ${i}` }],
      model: ref,
      ...(last && opts.lastUsage
        ? { usage: { input: opts.lastUsage, output: 10, cacheRead: 0, cacheWrite: 0 } }
        : {}),
    })
  }
  return out
}

/** A model that calls big once per prompt (or `steps` times in a row), then answers. */
function worker(steps = 1, size = 6000) {
  return (req: ModelRequest): MockReply => {
    const turn = req.messages.filter((m) => m.role === "user").length
    const since = req.messages.length - req.messages.findLastIndex((m) => m.role === "user") - 1
    const done = Math.floor(since / 2)
    if (done < steps)
      return { toolCalls: [{ name: "big", args: { n: turn * 100 + done, size } }], usage: usageOf(req) }
    return { text: `ok ${turn}`, usage: usageOf(req) }
  }
}

const stubs = (messages: readonly Message[]) =>
  results(messages).filter((r) => textOf(r).startsWith("[Earlier tool result cleared"))

test("under pressure old results are cleared in one batch, the same way in every later request and after a resume", async () => {
  const dir = await tempDir()
  const session = SessionStore.create({ cwd: dir, dir })
  const { agent, mock, bus } = setup({ session, window: 24_000, compaction: { auto: false } })
  const notices: string[] = []
  bus.subscribe(
    (e) => void (e.type === "extension.notice" && e.data.source === "context" && notices.push(e.data.text)),
  )
  for (let i = 0; i < 300; i++) mock.push(worker())
  for (let i = 0; i < 16; i++) await agent.prompt(`task ${i}`)
  await bus.flush()
  const last = mock.requests.at(-1)!.messages
  const cleared = stubs(last)
  expect(cleared.length).toBeGreaterThan(0)
  expect(notices.length).toBeGreaterThan(0)
  expectPaired(last)
  // Each stub names the artifact holding what it replaced.
  for (const stub of cleared) {
    const id = /artifact (a_[0-9a-f]{10})/.exec(textOf(stub))![1]!
    const original = results(agent.messages).find((r) => r.toolCallId === stub.toolCallId)!
    expect(readFileSync(agent.artifacts.find(id)!.path, "utf8")).toBe(textOf(original))
  }
  // The last two turns are never touched.
  const starts = last.flatMap((m, i) => (m.role === "user" ? [i] : []))
  expect(stubs(last.slice(starts.at(-2)!))).toHaveLength(0)
  // Requests only ever extend the one before, except right after an aging round.
  const rounds = new Set(
    [...agent.contextViews.values()].flatMap((v) => (v.kind === "aged" ? [v.epoch] : [])),
  )
  let breaks = 0
  for (let k = 1; k < mock.requests.length; k++) {
    const [a, b] = [mock.requests[k - 1]!.messages, mock.requests[k]!.messages]
    if (JSON.stringify(b.slice(0, a.length)) !== JSON.stringify(a)) breaks++
  }
  expect(rounds.size).toBeGreaterThan(0)
  expect(breaks).toBe(rounds.size)
  // The stubs come back the same after a resume.
  const resumed = setup({ session: SessionStore.open(session.file), window: 24_000 })
  const preview = (await resumed.agent.preview()).messages
  expect(JSON.stringify(preview.slice(0, last.length))).toBe(JSON.stringify(last))
  // The session file keeps every result whole.
  const whole = results(resumed.agent.messages).map(textOf)
  expect(whole.every((t) => t.startsWith("[run "))).toBe(true)
  await rm(dir, { recursive: true, force: true })
})

test("a round that would free too little is skipped; aging can be turned off", async () => {
  // About 3,000 tokens of history against a 20,000-token window: past 10%, with one result
  // (turn 1; turn 2 and this one are kept) of about 1,400 tokens to clear.
  const run = async (aging: NonNullable<ConstructorParameters<typeof Agent>[0]["context"]>["aging"]) => {
    const used = estimateTokens(history(2, 6000)) + 10
    const { agent, mock } = setup({
      window: 20_000,
      messages: history(2, 6000, { lastUsage: used }),
      context: { aging: { start: 0.1, target: 0.01, ...aging } },
      compaction: { auto: false },
      steps: [{ text: "fine" }],
    })
    await agent.prompt("next")
    return stubs(mock.requests[0]!.messages).map((r) => r.toolCallId)
  }
  // The band (9% of the window) caps what a round must free: 1,800 tokens, more than there is.
  expect(await run({ minSavedTokens: 30_000 })).toEqual([])
  expect(await run({ enabled: false, minSavedTokens: 0 })).toEqual([])
  expect(await run({ minSavedTokens: 1000 })).toEqual(["c1"])
})

test("nothing before signed reasoning the model would get back is aged; a checkpoint is sent as it is", async () => {
  const signed = (dialect: string): AssistantMessage["content"] => [
    { type: "thinking", text: "hmm", signature: { dialect, value: "sig" } },
  ]
  const { summaryMessages } = await import("../src/compaction.ts")
  const checkpoint = summaryMessages("earlier work", ref, {
    dialect: "mock",
    value: "opaque",
    kind: "checkpoint",
    provider: "mock",
    host: "mock",
    model: "test",
  })
  const run = async (dialect: string) => {
    const past = [...checkpoint, ...history(10, 6000, { thinking: signed(dialect) })]
    ;(past.at(-1) as AssistantMessage).usage = {
      input: estimateTokens(past) + 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
    }
    const { agent, mock } = setup({
      window: 20_000,
      messages: past,
      compaction: { auto: false },
      steps: [{ text: "fine" }],
    })
    await agent.prompt("next")
    return { sent: mock.requests[0]!.messages, projected: agent.projectedMessages() }
  }
  // Signed by this model's dialect: rewriting what comes before it could invalidate it.
  expect(stubs((await run("mock")).sent)).toHaveLength(0)
  // Signed by another dialect: the request drops the signature, so the history may change.
  const other = await run("other")
  expect(stubs(other.sent).length).toBeGreaterThan(0)
  // The checkpoint pair is never touched.
  expect(other.projected.slice(0, 2)).toEqual(checkpoint)
})

test("in one long turn only its last steps are kept; an experimental setting ages by turns alone", async () => {
  const long = setup({ window: 24_000, compaction: { auto: false } })
  for (let i = 0; i < 40; i++) long.mock.push(worker(14))
  await long.agent.prompt("one long task")
  const sent = long.mock.requests.at(-1)!.messages
  const all = results(sent)
  expect(stubs(sent).length).toBeGreaterThan(0)
  expect(all.slice(-2).every((r) => !textOf(r).startsWith("[Earlier"))).toBe(true)
  expectPaired(sent)

  const byTurns = setup({
    messages: history(6, 3000),
    context: { aging: { afterTurns: 2, minSavedTokens: 0 } },
    compaction: { auto: false },
    steps: [{ text: "fine" }],
  })
  await byTurns.agent.prompt("next")
  const kept = byTurns.mock.requests[0]!.messages
  // Older than the last two turns (the 6th and this one): cleared; the rest whole.
  expect(stubs(kept).map((r) => r.toolCallId)).toEqual(["c1", "c2", "c3", "c4", "c5"])
})

test("a context overflow gets one aging round, then compaction, then gives up", async () => {
  const overflow: MockReply = {
    error: { message: "prompt is too long: 300000 tokens > 200000", status: 400 },
  }
  const once = setup({
    messages: history(8, 6000),
    compaction: { auto: false },
    steps: [overflow, { text: "fits now" }],
  })
  const r = await once.agent.prompt("next")
  expect(r.reason).toBe("done")
  expect(once.mock.requests).toHaveLength(2)
  expect(stubs(once.mock.requests[0]!.messages)).toHaveLength(0)
  expect(stubs(once.mock.requests[1]!.messages).length).toBeGreaterThan(0)

  const always = setup({
    messages: history(8, 6000),
    steps: [overflow, overflow, { text: "SUMMARY" }, overflow, overflow],
  })
  const failed = await always.agent.prompt("next")
  expect(failed.reason).toBe("error")
  // The request, again after aging, the summary, again after compacting: no more.
  expect(always.mock.requests).toHaveLength(4)
  const summary = always.mock.requests[2]!
  expect(summary.systemPrompt).toContain("You summarize")
  // The summary is written from the projection: cleared results as their stubs.
  const transcript = textOf(summary.messages[0])
  expect(transcript).toContain("Earlier tool result cleared")
  expect(transcript).not.toContain(logText(1, 6000).slice(0, 2000))
})

test("aging keeps whole recent turns before steps of a long turn, and results a note points at", () => {
  const opts = { keepTurns: 2, keepSteps: 2, sealed: -1, cwd: process.cwd() }
  const ids = (ms: Message[], views = new Map<Message, ContextView>()) =>
    agingCandidates(ms, views, opts).map((c) => c.message.toolCallId)
  /** A user turn whose model calls big once per id, a step each. */
  const turn = (...calls: string[]): Message[] => [
    { role: "user", content: [{ type: "text", text: "go" }] },
    ...calls.flatMap((id, i): Message[] => [
      { role: "assistant", content: [{ type: "toolCall", id, name: "big", args: { n: i } }], model: ref },
      {
        role: "toolResult",
        toolCallId: id,
        toolName: "big",
        content: [{ type: "text", text: logText(i, 6000) }],
        isError: false,
      },
    ]),
  ]
  // Three turns, the current one with three steps: the previous turn is still kept.
  expect(ids([...turn("a"), ...turn("b"), ...turn("c1", "c2", "c3")])).toEqual(["a"])
  // One long turn alone: its older steps age, its last two do not.
  expect(ids(turn("s1", "s2", "s3", "s4", "s5"))).toEqual(["s1", "s2", "s3"])
  // A result an unchanged-read note points at stays while the note is there.
  const past = history(4, 6000)
  const of = past[2] as ToolResultMessage
  const note = past[6] as ToolResultMessage
  expect(ids(past, new Map([[note, { kind: "duplicate", text: "same", of }]]))).toEqual([])
})

// ---- sub-agents ----

test("a fork sends its inherited results as the parent does; a consultation sends the parent's projection", async () => {
  const dir = await tempDir()
  const mock = createMockDialect()
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, sections: () => [{ name: "identity", text: "child" }] })
  const tools = new ToolRegistry()
  tools.register(big, "test")
  const interceptors = new InterceptorRegistry()
  const past = history(2, 6000)
  const aged = past[2] as ToolResultMessage
  const root = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: dir,
    systemPrompt: "commander",
    tools,
    interceptors,
    tree,
    messages: past,
    views: new Map<Message, ContextView>([[aged, { kind: "aged", text: "STUB-1", epoch: 1 }]]),
  })
  mock.push({ text: "child done" })
  await tree.spawn(root, { prompt: "look", context: "fork" }).result()
  const forked = mock.requests.at(-1)!.messages
  expect(textOf(forked[2])).toBe("STUB-1")
  expect(textOf(forked[6])).toBe(logText(2, 6000))
  // A child's approval goes to the parent's model with the parent's history as it sends it.
  const off = interceptors.add("tool.call.before", () => ({ action: "ask", reason: "policy" }))
  mock.push(
    { toolCalls: [{ name: "big", args: { n: 1 } }] },
    { text: "APPROVE\nfine" },
    { text: "child done" },
  )
  await tree.spawn(root, { prompt: "work" }).result()
  const consult = mock.requests.find((q) => textOf(q.messages.at(-1)).includes("needs your approval"))!
  expect(textOf(consult.messages[2])).toBe("STUB-1")
  expect(JSON.stringify(consult.messages)).not.toContain(logText(1, 6000).slice(0, 500))
  off()
  // A fresh child saves its own artifacts but finds its parent's too.
  const saved = await root.artifacts.save({ text: "parent output", tool: "big" })
  tools.register(
    defineTool<{ id: string }>({
      name: "peek",
      description: "peek",
      parameters: { type: "object", properties: { id: { type: "string" } } },
      execute: async ({ id }, ctx) => {
        const found = ctx.session?.outputs?.find(id)
        return textResult(found ? `found ${found.chars} from ${found.sessionId}` : "missing")
      },
    }),
    "test",
  )
  mock.push({ toolCalls: [{ name: "peek", args: { id: saved.id } }] }, { text: "ok" })
  await tree.spawn(root, { prompt: "fresh" }).result()
  expect(textOf(mock.requests.at(-1)!.messages.at(-1))).toBe(`found 13 from ${root.sessionId}`)
  await rm(dir, { recursive: true, force: true })
  await rm(path.dirname(saved.path), { recursive: true, force: true })
})
