import "../server/offline.ts"
import { expect, test } from "bun:test"
import { addUsage, type CompactResult, emptyUsage, type StreamEvent } from "@amira/ai"
import {
  decodeUsageReceipt,
  encodeUsageReceipt,
  hasUnpricedUsage,
  isUsageAggregate,
  knownUsageCost,
  transferUsageAccounting,
} from "@amira/ai/accounting"
import {
  decodeCompactReceipt,
  decodeCompactResult,
  decodeModelEvent,
  decodeModelRequest,
  encodeCompactReceipt,
  encodeCompactResult,
  encodeModelEvent,
  encodeModelRequest,
} from "../../src/remote/model-codec.ts"
import { setup } from "./model-fixtures.ts"

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))

function aggregate() {
  return addUsage(
    { ...emptyUsage(), input: 3, cost: 0.12, webSearchRequests: 1, webSearchCost: 0.02 },
    { ...emptyUsage(), output: 4, webSearchRequests: 2, pricingUnknown: true, outputReported: false },
  )
}

test("usage receipts preserve hidden known money, search gaps, aggregate and coverage after JSON", () => {
  const usage = aggregate()
  expect(usage.cost).toBeUndefined()
  expect(usage.webSearchCost).toBeUndefined()
  const restored = json(usage)
  decodeUsageReceipt(restored, json(encodeUsageReceipt(usage)))
  expect(knownUsageCost(restored)).toBe(0.12)
  expect(isUsageAggregate(restored)).toBe(true)
  expect(hasUnpricedUsage(restored)).toBe(true)
  const reverse = { ...emptyUsage(), output: -4, webSearchRequests: -2 }
  transferUsageAccounting(
    { ...emptyUsage(), output: 4, webSearchRequests: 2, pricingUnknown: true, outputReported: false },
    reverse,
    -1,
  )
  const resolved = addUsage(restored, reverse)
  expect(resolved.cost).toBe(0.12)
  expect(resolved.webSearchCost).toBe(0.02)
  expect(hasUnpricedUsage(resolved)).toBe(false)
  expect(resolved.pricingUnknown).toBeUndefined()
  expect(resolved.outputReported).toBeUndefined()
  expect(Object.keys(restored)).not.toContain("aggregate")
})

test("wire codecs retain receipts for final messages, request history, compaction and late usage", () => {
  const { req } = setup()
  const usage = aggregate()
  const message = {
    role: "assistant" as const,
    model: { provider: "remote", model: "m" },
    content: [],
    usage,
  }
  const event = decodeModelEvent(json(encodeModelEvent({ type: "done", message })))
  expect(event.type === "done" && knownUsageCost(event.message.usage!)).toBe(0.12)
  req.messages.push(message)
  const history = decodeModelRequest(json(encodeModelRequest(req))).messages[1]!
  expect(history.role === "assistant" && isUsageAggregate(history.usage!)).toBe(true)
  const result: CompactResult = {
    ok: true,
    checkpoint: { dialect: "fake", value: "checkpoint", kind: "checkpoint" },
    usage,
    method: "native",
    tried: [],
  }
  expect(knownUsageCost(decodeCompactResult(json(encodeCompactResult(result))).usage)).toBe(0.12)
  const receipt = decodeCompactReceipt(
    json(encodeCompactReceipt({ id: "physical-attempt", late: true, usage })),
  )
  expect(receipt.late).toBe(true)
  expect(knownUsageCost(receipt.usage!)).toBe(0.12)
})

test("strict allowlists reject provider data, unknown variants, nested credentials and receipt path forgery", () => {
  const { req } = setup()
  expect(() =>
    encodeModelRequest({ ...req, headers: { Authorization: "secret" } } as unknown as typeof req),
  ).toThrow()
  expect(() =>
    encodeModelRequest({ ...req, model: { ...req.model, apiKey: "secret" } } as unknown as typeof req),
  ).toThrow()
  expect(() => decodeModelEvent({ value: { type: "admin", apiKey: "secret" }, usage: [] })).toThrow()
  expect(() =>
    decodeUsageReceipt(emptyUsage(), { ...encodeUsageReceipt(emptyUsage()), injected: true }),
  ).toThrow()
  expect(() =>
    decodeUsageReceipt(emptyUsage(), { ...encodeUsageReceipt(emptyUsage()), knownCost: Infinity }),
  ).toThrow()
  const wire = encodeModelEvent({
    type: "done",
    message: { role: "assistant", model: { provider: "p", model: "m" }, content: [], usage: aggregate() },
  })
  wire.usage[0]!.path = ["__proto__"]
  expect(() => decodeModelEvent(wire)).toThrow()
  let getterCalled = false
  expect(() =>
    encodeModelRequest({
      ...req,
      get headers() {
        getterCalled = true
        return {}
      },
    } as unknown as typeof req),
  ).toThrow()
  expect(getterCalled).toBe(false)
})

test("tool JSON with a property named usage is not confused with model accounting", () => {
  const { req } = setup()
  req.tools = [{ name: "test", description: "test", parameters: { usage: { type: "string" } } }]
  req.messages.push({
    role: "assistant",
    model: { provider: "remote", model: "m" },
    content: [{ type: "toolCall", id: "id", name: "test", args: { usage: { nested: true } } }],
  })
  const wire = encodeModelRequest(req)
  expect(wire.usage).toHaveLength(0)
  expect(decodeModelRequest(json(wire)).tools).toEqual(req.tools)
})

test("every StreamEvent variant has a strict round-trip", () => {
  const message = { role: "assistant" as const, model: { provider: "p", model: "m" }, content: [] }
  const error = { message: "failure", kind: "rate" as const, status: 429 }
  const events: StreamEvent[] = [
    { type: "start" },
    { type: "request.attempt", id: "attempt" },
    { type: "request.start", thinkingDisplay: "raw" },
    { type: "request.end", message },
    { type: "fast.fallback" },
    { type: "content.start", index: 0 },
    { type: "text.delta", text: "text" },
    { type: "thinking.start", index: 1 },
    { type: "thinking.delta", text: "thought" },
    { type: "thinking.end", index: 1 },
    { type: "toolCall.delta", id: "changing", index: 0, name: "tool", argsDelta: "{}" },
    { type: "done", message },
    { type: "error", error, message, retryable: false, retryAfterMs: 4 },
    {
      type: "serverTool",
      block: {
        type: "serverTool",
        id: "hosted",
        name: "web_search",
        input: { query: "q" },
        status: "done",
        sources: [{ url: "https://source.invalid" }],
        signature: { dialect: "fake", value: "opaque", host: "approved.invalid" },
      },
    },
    { type: "retry", attempt: 1, maxRetries: 2, delayMs: 5, error },
  ]
  for (const event of events) expect(decodeModelEvent(json(encodeModelEvent(event)))).toEqual(event)
})
