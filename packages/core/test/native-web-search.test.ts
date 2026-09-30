import { expect, test } from "bun:test"
import { createAi, type ServerToolBlock, type TextBlock } from "@amira/ai"
import { type AnyEvent, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"

// The agent with the real openai-responses dialect over a fake server: a hosted search is
// shown but never run here, and never answered with a function_call_output.

const sse = (events: Record<string, unknown>[]) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })

const searchItem = {
  id: "ws_1",
  type: "web_search_call",
  status: "completed",
  action: { type: "search", query: "bun latest" },
}
const url = "https://bun.com/blog"
const TEXT = "Bun 2 is out ([bun.com](https://bun.com/blog))."

function search(index: number) {
  return [
    {
      type: "response.output_item.added",
      output_index: index,
      item: { id: "ws_1", type: "web_search_call", status: "in_progress" },
    },
    { type: "response.web_search_call.in_progress", item_id: "ws_1", output_index: index },
    { type: "response.web_search_call.searching", item_id: "ws_1", output_index: index },
    { type: "response.web_search_call.completed", item_id: "ws_1", output_index: index },
    { type: "response.output_item.done", output_index: index, item: searchItem },
  ]
}

function message(index: number, text: string, annotations: unknown[] = []) {
  return [
    {
      type: "response.output_text.delta",
      item_id: `msg_${index}`,
      output_index: index,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: index,
      item: {
        id: `msg_${index}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations }],
      },
    },
  ]
}

const call = (index: number) => [
  {
    type: "response.output_item.done",
    output_index: index,
    item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "echo", arguments: '{"text":"a"}' },
  },
]

const completed = {
  type: "response.completed",
  response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
}

function setup(replies: Record<string, unknown>[][], baseUrl = "https://api.openai.com/v1") {
  const bodies: any[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string))
    return sse(replies[bodies.length - 1] ?? [...message(0, "ok"), completed])
  }) as unknown as typeof fetch
  const ai = createAi({
    fetch: fetchImpl,
    retry: { retries: 0 },
    providers: [{ id: "oa", dialect: "openai-responses", baseUrl, defaultModel: { contextWindow: 128_000 } }],
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const agent = new Agent({ ai, model: ai.model("oa/gpt-5"), cwd: process.cwd(), systemPrompt: "sys", bus })
  const ran: string[] = []
  agent.tools.register(
    defineTool({
      name: "web_search",
      description: "client search",
      parameters: { type: "object" },
      supersededBy: "webSearch",
      execute: async () => {
        ran.push("web_search")
        return textResult("client results")
      },
    }),
    "test",
  )
  agent.tools.register(
    defineTool<{ text: string }>({
      name: "echo",
      description: "echo",
      parameters: { type: "object" },
      execute: async (p) => {
        ran.push("echo")
        return textResult(`echo: ${p.text}`)
      },
    }),
    "test",
  )
  return { agent, bus, events, bodies, ran }
}

const citation = { type: "url_citation", url, title: "Bun blog", start_index: 13, end_index: 45 }

test("a hosted search is shown, not run, and the reply after it keeps its citations", async () => {
  const { agent, bus, events, bodies, ran } = setup([
    [...search(0), ...message(1, TEXT, [citation]), completed],
  ])
  const r = await agent.prompt("what is new in bun?")
  await bus.flush()
  expect(r.reason).toBe("done")
  expect(r.steps).toBe(1)
  // The client web_search is hidden; the hosted one is offered; the local tool stays.
  const tools = bodies[0].tools as { type: string; name?: string }[]
  expect(tools.map((t) => t.name ?? t.type)).toEqual(["echo", "web_search"])
  expect(tools.find((t) => t.name === "web_search")).toBeUndefined()
  expect(tools.at(-1)).toEqual({ type: "web_search" })
  expect(ran).toEqual([])
  expect(events.some((e) => e.type === "tool.execute.start")).toBe(false)
  const deltas = events.flatMap((e) =>
    e.type === "message.delta" && e.data.kind === "serverTool" ? [e.data.block.status] : [],
  )
  expect(deltas).toEqual(["running", "done"])
  const reply = agent.messages[1]
  if (reply?.role !== "assistant") throw new Error("expected the reply")
  const [first, second] = reply.content as [ServerToolBlock, TextBlock]
  expect(first.type).toBe("serverTool")
  expect(first.signature?.host).toBe("api.openai.com")
  expect(second.citations).toEqual([{ url, title: "Bun blog", start: 13, end: 45 }])
  // The follow-up replays the search as its item, with no output for it.
  await agent.prompt("and before that?")
  const input = bodies[1].input as { type?: string }[]
  expect(input.filter((i) => i.type === "web_search_call")).toEqual([searchItem])
  expect(input.some((i) => i.type === "function_call_output")).toBe(false)
})

test("a local tool call next to a hosted search still runs, and only it gets an output", async () => {
  const { agent, bodies, ran } = setup([
    [...search(0), ...call(1), completed],
    [...message(0, "done"), completed],
  ])
  const r = await agent.prompt("search then echo")
  expect(r).toEqual({ reason: "done", steps: 2 })
  expect(ran).toEqual(["echo"])
  const input = bodies[1].input as { type?: string; call_id?: string }[]
  expect(input.map((i) => i.type ?? "assistant")).toEqual([
    "message",
    "web_search_call",
    "function_call",
    "function_call_output",
  ])
  expect(input.at(-1)?.call_id).toBe("call_1")
})

test("models without the hosted search get the client web_search tool", async () => {
  const { agent, bodies } = setup([[...message(0, "hi"), completed]], "http://localhost:8317/v1")
  await agent.prompt("hi")
  const tools = bodies[0].tools as { type: string; name?: string }[]
  expect(tools.map((t) => t.name ?? t.type)).toEqual(["web_search", "echo"])
  const preview = await agent.preview()
  expect(preview.tools.map((t) => t.name)).toEqual(["web_search", "echo"])
})
