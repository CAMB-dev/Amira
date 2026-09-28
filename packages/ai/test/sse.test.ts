import { expect, test } from "bun:test"
import { parseSSE } from "../src/sse.ts"

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch))
      c.close()
    },
  })
}

async function all(chunks: string[]) {
  const out = []
  for await (const m of parseSSE(streamOf(chunks))) out.push(m)
  return out
}

test("parses events split across chunks and CRLF line endings", async () => {
  const msgs = await all([
    'data: {"a"',
    ":1}\r\n\r",
    "\nevent: ping\ndata: x\n\n: comment\n",
    "data: [DONE]\n\n",
  ])
  expect(msgs).toEqual([{ data: '{"a":1}' }, { event: "ping", data: "x" }, { data: "[DONE]" }])
})

test("joins multi-line data and flushes a trailing event without a blank line", async () => {
  const msgs = await all(["data: one\ndata: two\n\ndata: tail"])
  expect(msgs).toEqual([{ data: "one\ntwo" }, { data: "tail" }])
})

test("handles multi-byte characters split across chunks", async () => {
  const bytes = new TextEncoder().encode("data: 你好\n\n")
  const s = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.slice(0, 8))
      c.enqueue(bytes.slice(8))
      c.close()
    },
  })
  const out = []
  for await (const m of parseSSE(s)) out.push(m)
  expect(out).toEqual([{ data: "你好" }])
})
