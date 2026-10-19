import "../server/offline.ts"
import { expect, test } from "bun:test"
import { addUsage, emptyUsage, type ModelRequest } from "@amira/ai"
import { knownUsageCost } from "@amira/ai/accounting"
import { createModelBroker } from "../../src/remote/model-broker.ts"
import { done, HEADER, KEY, setup } from "./model-fixtures.ts"

test("native compaction uses local Ai, restores checkpoints and keeps physical usage receipts", async () => {
  const { ai, bindings, req, metadata } = setup()
  const usage = addUsage({ ...emptyUsage(), input: 2, cost: 0.4 }, { ...emptyUsage(), webSearchRequests: 1 })
  let received: ModelRequest | undefined
  const local = {
    ...ai,
    compact: async (
      request: ModelRequest,
      _signal?: AbortSignal,
      onProgress?: () => void,
      onUsage?: Parameters<typeof ai.compact>[3],
    ) => {
      received = request
      onProgress?.()
      await onUsage?.({ id: "one-physical-attempt", late: true, usage })
      return {
        ok: true as const,
        checkpoint: {
          dialect: "fake",
          provider: "local",
          model: req.model.id,
          host: "approved.invalid",
          kind: "checkpoint" as const,
          value: `opaque ${HEADER}`,
        },
        usage,
        method: "native",
        tried: [],
        summary: KEY,
      }
    },
  }
  const broker = createModelBroker({ ai: local, bindings })
  let progressed = 0
  const receipts: unknown[] = []
  const result = await broker.compact(
    { bindingRevision: metadata.revision, request: req },
    undefined,
    () => progressed++,
    (receipt) => {
      receipts.push(receipt)
      expect(knownUsageCost(receipt.usage!)).toBe(0.4)
    },
  )
  expect(received?.model.caps.tools).toBe("none")
  expect(progressed).toBe(1)
  expect(receipts).toHaveLength(1)
  expect(knownUsageCost(result.usage)).toBe(0.4)
  expect(result).toMatchObject({
    ok: true,
    checkpoint: { provider: "remote", kind: "checkpoint", value: "opaque [redacted]" },
    summary: "[redacted]",
  })
})

test("ordinary native compaction retains local dialect checkpoints and remote prices", async () => {
  let calls = 0
  const { broker, call, metadata } = setup({
    id: "fake",
    async *stream(req) {
      yield done(req)
    },
    compaction: {
      methods: ["native"],
      layouts: ["tail", "recent-user"],
      midTurn: true,
      official: () => true,
      async compact(_method, req, ctx, progress) {
        calls++
        expect(req.model.caps.webSearch).toBe(false)
        expect(ctx.endpoint.apiKey).toBe(KEY)
        progress?.()
        return {
          ok: true,
          value: "opaque-checkpoint",
          summary: "safe summary",
          usage: { ...emptyUsage(), input: 1_000_000 },
        }
      },
    },
  })
  expect(metadata.native).toMatchObject({
    dialect: "fake",
    methods: ["native"],
    layouts: ["tail", "recent-user"],
    midTurn: true,
  })
  const receipts: unknown[] = []
  const result = await broker.compact(call, undefined, undefined, (receipt) => {
    receipts.push(receipt)
  })
  expect(calls).toBe(1)
  expect(receipts).toHaveLength(1)
  expect(result).toMatchObject({
    ok: true,
    checkpoint: {
      provider: "remote",
      host: "approved.invalid",
      model: call.request.model.id,
      kind: "checkpoint",
    },
    usage: { cost: 12 },
  })
})
