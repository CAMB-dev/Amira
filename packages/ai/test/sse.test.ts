import { expect, test } from "bun:test"
import { parseSSE } from "../src/sse.ts"

function streamOf(chunks: string[], onCancel?: () => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch))
      c.close()
    },
    cancel() {
      onCancel?.()
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

test("supports CR-only line endings", async () => {
  expect(await all(["data: a\r\rdata: b\r\r"])).toEqual([{ data: "a" }, { data: "b" }])
})

test("holds back a CR at a chunk boundary until the next chunk", async () => {
  expect(await all(["data: a\r", "\n\r", "\ndata: b\r\n\r\n"])).toEqual([{ data: "a" }, { data: "b" }])
  expect(await all(["data: a\r", "\r", "data: b\r", "\r"])).toEqual([{ data: "a" }, { data: "b" }])
})

test("sends an unterminated trailing line through the line handler", async () => {
  expect(await all(["data:   x"])).toEqual([{ data: "  x" }])
  expect(await all(["event: e\ndata: x\nevent: f"])).toEqual([{ event: "f", data: "x" }])
  expect(await all(["data: x\n: comment"])).toEqual([{ data: "x" }])
})

test("skips a leading BOM", async () => {
  expect(await all(["﻿data: a\n\n"])).toEqual([{ data: "a" }])
})

test("accepts data without a space and strips only one space", async () => {
  expect(await all(["data:a\n\n", "data:  b\n\n"])).toEqual([{ data: "a" }, { data: " b" }])
})

test("ignores comment keep-alives", async () => {
  expect(await all([": OPENROUTER PROCESSING\n\n", ": OPENROUTER PROCESSING\ndata: x\n\n"])).toEqual([
    { data: "x" },
  ])
})

test("cancels the body when the consumer stops early", async () => {
  let cancelled = false
  const s = streamOf(["data: 1\n\n", "data: 2\n\n"], () => {
    cancelled = true
  })
  for await (const m of parseSSE(s)) if (m.data === "1") break
  expect(cancelled).toBe(true)
})

test("does not cancel a fully read body", async () => {
  let cancelled = false
  const s = streamOf(["data: 1\n\n"], () => {
    cancelled = true
  })
  const out = []
  for await (const m of parseSSE(s)) out.push(m)
  expect(out).toHaveLength(1)
  expect(cancelled).toBe(false)
})

test("parses a large event split into many chunks in linear time", async () => {
  const size = 4 * 1024 * 1024
  const text = `data: ${"x".repeat(size)}\n\n`
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += 16384) chunks.push(text.slice(i, i + 16384))
  const t0 = performance.now()
  const msgs = await all(chunks)
  expect(msgs[0]?.data.length).toBe(size)
  expect(performance.now() - t0).toBeLessThan(2000)
})
