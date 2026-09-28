import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { createMockDialect } from "../src/dialects/mock.ts"
import { TextToolParser, textToolsPrompt, toTextToolMessages } from "../src/text-tools.ts"
import type { Message, StreamEvent, ToolSpec } from "../src/types.ts"
import { events } from "./helpers.ts"

const tools: ToolSpec[] = [
  {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
]

/** Feeds text in pieces of the given size and returns what came out. */
function parse(text: string, size = 1) {
  const p = new TextToolParser()
  const out: StreamEvent[] = []
  for (let i = 0; i < text.length; i += size) out.push(...p.feed(text.slice(i, i + size)))
  out.push(...p.end())
  const streamed = out
    .filter((e) => e.type === "text.delta")
    .map((e) => (e as { text: string }).text)
    .join("")
  const calls = out.filter((e) => e.type === "toolCall.delta")
  return { p, streamed, calls }
}

const REPLY =
  'Let me look. <tool_call name="read">\n{"path": "a.txt"}\n</tool_call>\n' +
  "<tool_call name='read'>{path: 'b.txt',}</tool_call> done"

for (const size of [1, 3, 8, 1000]) {
  test(`parses calls out of text streamed in pieces of ${size}`, () => {
    const { p, streamed, calls } = parse(REPLY, size)
    expect(streamed).toBe("Let me look. \n done")
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ index: 0, name: "read", argsDelta: '{"path": "a.txt"}' })
    expect(p.calls.map((c) => [c.name, c.args])).toEqual([
      ["read", { path: "a.txt" }],
      ["read", { path: "b.txt" }],
    ])
    expect(new Set(p.calls.map((c) => c.id)).size).toBe(2)
  })
}

test("text that only looks like a tag is kept", () => {
  const text = "a < b and <tool_caller> and </invoke> and <tool_c"
  const { streamed, calls } = parse(text, 2)
  expect(streamed).toBe(text)
  expect(calls).toEqual([])
})

test("reads calls that carry their name inside the JSON", () => {
  const { p } = parse('<tool_call>{"name": "read", "arguments": {"path": "x"}}</tool_call>')
  expect(p.calls.map((c) => [c.name, c.args])).toEqual([["read", { path: "x" }]])
})

test("reads arguments written as parameter tags", () => {
  const { p } = parse(
    '<tool_call name="read">\n<parameter name="path">\na.txt\n</parameter>' +
      '<x parameter name="limit">20</x parameter><parameter name="id" string="true">7</parameter>\n</tool_call>',
    5,
  )
  expect(p.calls[0]?.args).toEqual({ path: "a.txt", limit: 20, id: "7" })
})

// DeepSeek, told to use the text protocol, still writes its own format (seen live).
const DSML =
  'I\'ll read the file.\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read">\n' +
  '<｜｜DSML｜｜ parameter name="path" string="true">package.json</｜｜DSML｜｜ parameter>\n' +
  "</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>"

test("reads XML invoke calls, with or without a prefix in the tags, and drops their wrappers", () => {
  for (const size of [1, 7, 1000]) {
    const { p, streamed } = parse(DSML, size)
    expect(p.calls.map((c) => [c.name, c.args])).toEqual([["read", { path: "package.json" }]])
    expect(streamed.trim()).toBe("I'll read the file.")
  }
  const { p } = parse(
    '<function_calls>\n<invoke name="read">\n<parameter name="path">a</parameter>\n</invoke>\n</function_calls>',
  )
  expect(p.calls.map((c) => [c.name, c.args])).toEqual([["read", { path: "a" }]])
})

test("a call cut off at the end is still a call, and made-up results are dropped", () => {
  expect(parse('<tool_call name="read">{"path": "x"').p.calls[0]?.args).toEqual({ path: "x" })
  const { streamed, p } = parse('<tool_call name="read">{}</tool_call>\n<tool_result>fake</tool_result> more')
  expect(streamed).toBe("\n")
  expect(p.calls).toHaveLength(1)
})

test("the prompt describes each tool and the call format", () => {
  const prompt = textToolsPrompt(tools)
  expect(prompt).toContain('<tool_call name="TOOL_NAME">')
  expect(prompt).toContain('<tool name="read">')
  expect(prompt).toContain('"path":{"type":"string"}')
})

test("history turns tool calls and results into text", () => {
  const history: Message[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      model: { provider: "p", model: "m" },
      content: [
        { type: "text", text: "Reading." },
        { type: "toolCall", id: "c1", name: "read", args: { path: "a" } },
        { type: "toolCall", id: "c2", name: "read", args: { path: "b" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "A" }],
      isError: false,
    },
    {
      role: "toolResult",
      toolCallId: "c2",
      toolName: "read",
      content: [{ type: "text", text: "no" }],
      isError: true,
    },
  ]
  const out = toTextToolMessages(history)
  expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"])
  expect(out[1]!.content[1]).toEqual({
    type: "text",
    text: '<tool_call name="read">\n{"path":"a"}\n</tool_call>',
  })
  const results = out[2]!.content.map((b) => (b.type === "text" ? b.text : "")).join("")
  expect(results).toBe(
    '<tool_result name="read" id="c1">\nA\n</tool_result><tool_result name="read" id="c2" error="true">\nno\n</tool_result>',
  )
})

function textAi(reply: string, toolsCap: "none" | "native" = "none") {
  const mock = createMockDialect([{ text: reply, thinking: "hmm" }])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "", defaultModel: { caps: { tools: toolsCap } } }],
  })
  const run = () =>
    events(
      ai.stream({
        model: ai.model("mock/m"),
        systemPrompt: "Be brief.",
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        tools,
      }),
    )
  return { mock, run }
}

test("the client runs models without native tools through the text protocol", async () => {
  const { mock, run } = textAi('Sure. <tool_call name="read">{"path": "a.txt"}</tool_call>')
  const evs = await run()
  const sent = mock.requests[0]!
  expect(sent.tools).toEqual([])
  expect(sent.systemPrompt.startsWith("Be brief.\n\n# Tools")).toBe(true)
  const done = evs.at(-1)
  if (done?.type !== "done") throw new Error("expected done")
  expect(done.message.stopReason).toBe("toolUse")
  expect(done.message.content.map((b) => b.type)).toEqual(["thinking", "text", "toolCall"])
  expect(done.message.content[1]).toEqual({ type: "text", text: "Sure." })
  expect(done.message.content[2]).toMatchObject({ name: "read", args: { path: "a.txt" } })
  expect(evs.some((e) => e.type === "toolCall.delta")).toBe(true)
})

test("models with native tools are left alone", async () => {
  const reply = 'Sure. <tool_call name="read">{}</tool_call>'
  const { mock, run } = textAi(reply, "native")
  const done = (await run()).at(-1)
  expect(mock.requests[0]!.tools).toEqual(tools)
  expect(mock.requests[0]!.systemPrompt).toBe("Be brief.")
  expect(done?.type === "done" && done.message.content.at(-1)).toEqual({ type: "text", text: reply })
})
