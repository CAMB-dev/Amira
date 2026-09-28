import { expect, test } from "bun:test"
import { collect } from "../src/dialect.ts"
import type { StreamEvent } from "../src/types.ts"
import { delta, events, fakeFetch, request, sseResponse, testAi } from "./helpers.ts"

async function run(chunks: unknown[]) {
  const ai = testAi(fakeFetch(() => sseResponse(chunks)))
  return events(ai.stream(request(ai)))
}

async function message(chunks: unknown[]) {
  const ai = testAi(fakeFetch(() => sseResponse(chunks)))
  return collect(ai.stream(request(ai)))
}

const fn = (name: string | undefined, args: string) => ({
  ...(name !== undefined ? { name } : {}),
  arguments: args,
})
type ToolDelta = Extract<StreamEvent, { type: "toolCall.delta" }>

test("keeps two index-less calls in one chunk apart", async () => {
  const msg = await message([
    delta({
      tool_calls: [
        { id: "a", type: "function", function: fn("read", '{"p":1}') },
        { id: "b", type: "function", function: fn("bash", '{"c":2}') },
      ],
    }),
    delta({}, "tool_calls"),
  ])
  expect(msg.content).toEqual([
    { type: "toolCall", id: "a", name: "read", args: { p: 1 } },
    { type: "toolCall", id: "b", name: "bash", args: { c: 2 } },
  ])
})

test("keeps index-less calls in consecutive chunks apart", async () => {
  const msg = await message([
    delta({ tool_calls: [{ id: "a", type: "function", function: fn("read", '{"p":1}') }] }),
    delta({ tool_calls: [{ id: "b", type: "function", function: fn("bash", '{"c":2}') }] }),
    delta({}, "tool_calls"),
  ])
  expect(msg.content).toEqual([
    { type: "toolCall", id: "a", name: "read", args: { p: 1 } },
    { type: "toolCall", id: "b", name: "bash", args: { c: 2 } },
  ])
})

test("continues an index-less call across chunks that omit or repeat the id", async () => {
  const msg = await message([
    delta({ tool_calls: [{ id: "a", function: fn("read", '{"p"') }] }),
    delta({ tool_calls: [{ function: fn(undefined, ":1") }] }),
    delta({ tool_calls: [{ id: "a", function: fn(undefined, "}") }] }),
    delta({}, "tool_calls"),
  ])
  expect(msg.content).toEqual([{ type: "toolCall", id: "a", name: "read", args: { p: 1 } }])
})

test("keeps first-seen order when indexes arrive out of order", async () => {
  const msg = await message([
    delta({ tool_calls: [{ index: 1, id: "b", function: fn("bash", "{}") }] }),
    delta({ tool_calls: [{ index: 0, id: "a", function: fn("read", "{}") }] }),
    delta({}, "tool_calls"),
  ])
  expect(msg.content.map((b) => (b.type === "toolCall" ? b.id : ""))).toEqual(["b", "a"])
})

test("does not duplicate a name repeated on every delta", async () => {
  const msg = await message([
    delta({ tool_calls: [{ index: 0, id: "a", function: fn("read", '{"p"') }] }),
    delta({ tool_calls: [{ index: 0, id: "a", function: fn("read", ":1}") }] }),
    delta({}, "tool_calls"),
  ])
  expect(msg.content).toEqual([{ type: "toolCall", id: "a", name: "read", args: { p: 1 } }])
})

test("joins a name streamed in pieces", async () => {
  const msg = await message([
    delta({ tool_calls: [{ index: 0, id: "a", function: fn("read_", "") }] }),
    delta({ tool_calls: [{ index: 0, function: fn("file", "{}") }] }),
    delta({}, "tool_calls"),
  ])
  expect(msg.content).toEqual([{ type: "toolCall", id: "a", name: "read_file", args: {} }])
})

test("reports a stable index while the id moves from placeholder to real", async () => {
  const evs = await run([
    delta({ tool_calls: [{ index: 0, function: fn("read", '{"p"') }] }),
    delta({ tool_calls: [{ index: 0, id: "real", function: fn(undefined, ":1}") }] }),
    delta({ tool_calls: [{ index: 0, id: "other", function: fn(undefined, "") }] }),
    delta({ tool_calls: [{ index: 1, id: "b", function: fn("bash", "{}") }] }),
    delta({}, "tool_calls"),
  ])
  const deltas = evs.filter((e): e is ToolDelta => e.type === "toolCall.delta")
  expect(deltas[0]?.id).toMatch(/^call_[0-9a-f]{8}_0$/)
  expect(deltas.map((d) => [d.index, d.id])).toEqual([
    [0, deltas[0]!.id],
    [0, "real"],
    [0, "real"],
    [1, "b"],
  ])
  const done = evs.at(-1)
  expect(
    done?.type === "done" && done.message.content.map((b) => (b.type === "toolCall" ? b.id : "")),
  ).toEqual(["real", "b"])
})
