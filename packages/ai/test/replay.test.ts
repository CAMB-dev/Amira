import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { canReplay, canReplayServerTool, forReplay, type ReplayTarget } from "../src/thinking.ts"
import type { AssistantMessage, Message, ServerToolBlock, Signature } from "../src/types.ts"
import { type DoneEvent, events, fakeFetch, type Seen, sseResponse } from "./helpers.ts"

const target: ReplayTarget = { dialect: "d", provider: "p", host: "api.p.com", model: "m", webSearch: true }

test("signed data goes back only to the same dialect, provider and host", () => {
  expect(canReplay({ dialect: "d", value: "v", host: "api.p.com" }, target, "p")).toBe(true)
  expect(canReplay({ dialect: "x", value: "v", host: "api.p.com" }, target, "p")).toBe(false)
  expect(canReplay({ dialect: "d", value: "v", host: "api.p.com" }, target, "q")).toBe(false)
  expect(canReplay({ dialect: "d", value: "v", host: "proxy.local" }, target, "p")).toBe(false)
  // Stored before hosts were kept: the provider decides.
  expect(canReplay({ dialect: "d", value: "v" }, target, "p")).toBe(true)
  expect(canReplay({ dialect: "d", value: "v" }, target, "q")).toBe(false)
})

test("a checkpoint needs its provider, host and model to match", () => {
  const cp = { dialect: "d", value: "v", kind: "checkpoint" as const, provider: "p", host: "api.p.com" }
  expect(canReplay({ ...cp, model: "m" }, target)).toBe(true)
  expect(canReplay({ ...cp, model: "m2" }, target)).toBe(false)
  expect(canReplay({ ...cp, model: "m", host: "other" }, target)).toBe(false)
  // Without a host (or model) it never replays.
  const { host: _, ...noHost } = cp
  expect(canReplay({ ...noHost, model: "m" }, target)).toBe(false)
})

test("forReplay strips what cannot go back and keeps the rest unchanged", () => {
  const reply: AssistantMessage = {
    role: "assistant",
    model: { provider: "p", model: "m" },
    content: [
      { type: "thinking", text: "here", signature: { dialect: "d", value: "s1", host: "api.p.com" } },
      { type: "thinking", text: "there", signature: { dialect: "d", value: "s2", host: "proxy.local" } },
      { type: "text", text: "out", signature: { dialect: "d", value: "id", host: "proxy.local" } },
    ],
  }
  const plain: Message = { role: "user", content: [{ type: "text", text: "hi" }] }
  const out = forReplay([plain, reply], target)
  expect(out[0]).toBe(plain)
  expect((out[1] as AssistantMessage).content).toEqual([
    reply.content[0]!,
    { type: "thinking", text: "there" },
    { type: "text", text: "out" },
  ])
  // The original is untouched; nothing to strip returns the same array.
  expect((reply.content[1] as { signature?: unknown }).signature).toBeDefined()
  const same = [plain]
  expect(forReplay(same, target)).toBe(same)
})

test("a search item, a checkpoint and reasoning are filtered together, each by its own rule", () => {
  const search: ServerToolBlock = {
    type: "serverTool",
    id: "ws_1",
    name: "web_search",
    input: { type: "search", query: "q" },
    status: "done",
    signature: { dialect: "d", value: "item", host: "api.p.com" },
  }
  const checkpoint: Signature = {
    dialect: "d",
    value: "cp",
    kind: "checkpoint",
    provider: "p",
    host: "api.p.com",
    model: "m",
  }
  const summary: Message = {
    role: "user",
    content: [{ type: "text", text: "summary", signature: checkpoint }],
  }
  const reply: AssistantMessage = {
    role: "assistant",
    model: { provider: "p", model: "m" },
    content: [
      { type: "thinking", text: "why", signature: { dialect: "d", value: "s", host: "api.p.com" } },
      search,
      { type: "text", text: "found" },
    ],
  }
  const history: Message[] = [summary, reply]
  const stripped = (out: Message[]) =>
    out.flatMap((m) => m.content.map((b) => ("signature" in b && b.signature ? "signed" : "plain")))
  // Same endpoint and model: everything goes back as it is.
  expect(forReplay(history, target)).toBe(history)
  // Another model at the same endpoint: only the checkpoint is tied to a model.
  expect(stripped(forReplay(history, { ...target, model: "m2" }))).toEqual([
    "plain",
    "signed",
    "signed",
    "plain",
  ])
  // The search no longer offered: only its item is left out.
  expect(stripped(forReplay(history, { ...target, webSearch: false }))).toEqual([
    "signed",
    "signed",
    "plain",
    "plain",
  ])
  // Another host or provider: nothing goes back.
  for (const t of [
    { ...target, host: "proxy.local" },
    { ...target, provider: "q" },
  ]) {
    expect(stripped(forReplay(history, t))).toEqual(["plain", "plain", "plain", "plain"])
  }
  expect(canReplayServerTool(search, target, "p")).toBe(true)
  expect(canReplayServerTool(search, target, "q")).toBe(false)
  expect(canReplayServerTool({ ...search, signature: { dialect: "d", value: "item" } }, target, "p")).toBe(
    false,
  )
})

const reasoningStream = () =>
  sseResponse([
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", summary: [{ text: "why" }], encrypted_content: "ENC" },
    },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, delta: "ok" },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ])

test("replies record the host their signatures came from, and go back only there", async () => {
  const seen: Seen = {}
  const ai = createAi({
    retry: { retries: 0 },
    fetch: fakeFetch(reasoningStream, seen),
    providers: [
      { id: "official", dialect: "openai-responses", baseUrl: "https://api.openai.com/v1" },
      { id: "proxy", dialect: "openai-responses", baseUrl: "http://localhost:8317/v1" },
    ],
  })
  const official = ai.model("official/gpt")
  const evs = await events(ai.stream({ model: official, systemPrompt: "", messages: [], tools: [] }))
  const reply = (evs.at(-1) as DoneEvent).message
  const thinking = reply.content.find((b) => b.type === "thinking")!
  expect(thinking.signature?.host).toBe("api.openai.com")

  const history: Message[] = [{ role: "user", content: [{ type: "text", text: "q" }] }, reply]
  await events(ai.stream({ model: official, systemPrompt: "", messages: history, tools: [] }))
  expect(seen.body.input.some((i: { type?: string }) => i.type === "reasoning")).toBe(true)

  // The same dialect on another provider: the reasoning goes as text, never as encrypted content.
  await events(ai.stream({ model: ai.model("proxy/gpt"), systemPrompt: "", messages: history, tools: [] }))
  expect(seen.body.input.some((i: { type?: string }) => i.type === "reasoning")).toBe(false)
  expect(JSON.stringify(seen.body.input)).toContain("<thinking>\\nwhy\\n</thinking>")
  expect(JSON.stringify(seen.body.input)).not.toContain("ENC")
  expect(ai.canReplay(thinking.signature!, ai.model("proxy/gpt"), "official")).toBe(false)
  expect(ai.canReplay(thinking.signature!, official, "official")).toBe(true)
})

test("the same provider id at a new host no longer replays", async () => {
  const seen: Seen = {}
  const ai = createAi({
    retry: { retries: 0 },
    fetch: fakeFetch(reasoningStream, seen),
    providers: [{ id: "p", dialect: "openai-responses", baseUrl: "http://moved.example/v1" }],
  })
  const history: Message[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      model: { provider: "p", model: "gpt" },
      content: [
        {
          type: "thinking",
          text: "old",
          signature: { dialect: "openai-responses", value: '{"encrypted_content":"E"}', host: "old.example" },
        },
        { type: "text", text: "a" },
      ],
    },
  ]
  await events(ai.stream({ model: ai.model("p/gpt"), systemPrompt: "", messages: history, tools: [] }))
  expect(JSON.stringify(seen.body.input)).not.toContain('"E"')
})
