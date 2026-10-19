import "../server/offline.ts"
import { expect, test } from "bun:test"
import { addUsage, type CompactReceipt, emptyUsage } from "@amira/ai"
import { hasUnpricedUsage, knownUsageCost } from "@amira/ai/accounting"
import { collectEvents, deferred, proxyFixture, secret } from "./model-proxy-fixture.ts"

const usage = addUsage(
  { ...emptyUsage(), input: 10, output: 2, cost: 0.25, webSearchRequests: 1, webSearchCost: 0.05 },
  { ...emptyUsage(), webSearchRequests: 1, outputReported: false },
)

test("native compaction progress, checkpoint, receipts and aggregate money survive the real wire", async () => {
  let compactions = 0
  const fixture = proxyFixture(
    async function* () {
      yield { type: "start" }
      throw new Error("No stream fallback expected")
    },
    1000,
    {
      methods: ["native"],
      layouts: ["tail"],
      midTurn: true,
      official: () => true,
      async compact(_method, request, context, progress) {
        compactions++
        expect(context.endpoint.apiKey).toBe(secret)
        expect(request.model.caps.webSearch).toBe(false)
        progress?.()
        return { ok: true, value: "checkpoint", summary: "summary", usage }
      },
    },
  )
  const receipts: CompactReceipt[] = []
  let progress = 0
  try {
    await fixture.connect()
    const request = {
      ...fixture.request,
      model: { ...fixture.request.model, caps: { ...fixture.request.model.caps, webSearch: false } },
    }
    const result = await fixture.proxy.compact(
      request,
      undefined,
      () => progress++,
      (receipt) => {
        receipts.push(receipt)
      },
    )
    expect(result.ok).toBe(true)
    expect(compactions).toBe(1)
    expect(progress).toBe(1)
    expect(receipts).toHaveLength(1)
    expect(knownUsageCost(result.usage)).toBe(knownUsageCost(usage))
    expect(hasUnpricedUsage(result.usage)).toBe(true)
    expect(knownUsageCost(receipts[0]!.usage!)).toBe(knownUsageCost(usage))
    if (result.ok)
      expect(result.checkpoint).toMatchObject({ value: "checkpoint", kind: "checkpoint", provider: "p" })
    for (const frame of fixture.observed) expect(frame).not.toContain(secret)
  } finally {
    fixture.close()
  }
})

test("concurrent root, child, title and consultation calls use one route with independent call cursors", async () => {
  const seen: string[] = []
  const fixture = proxyFixture(async function* (request) {
    seen.push(request.systemPrompt)
    yield { type: "text.delta", text: request.systemPrompt }
    yield {
      type: "done",
      message: {
        role: "assistant",
        model: { provider: "p", model: "m" },
        content: [{ type: "text", text: request.systemPrompt }],
        usage,
        stopReason: "end",
      },
    }
  })
  try {
    await fixture.connect()
    const sources = ["root", "child", "auto-title", "consult-parent"]
    const results = await Promise.all(
      sources.map((systemPrompt) =>
        collectEvents(fixture.proxy.stream({ ...fixture.request, systemPrompt })),
      ),
    )
    expect(seen.sort()).toEqual(sources.sort())
    for (const events of results) {
      const terminal = events.at(-1)
      expect(terminal?.type).toBe("done")
      if (terminal?.type === "done") {
        expect(knownUsageCost(terminal.message.usage!)).toBe(knownUsageCost(usage))
        expect(hasUnpricedUsage(terminal.message.usage!)).toBe(true)
      }
    }
  } finally {
    fixture.close()
  }
})

test("accepted native compaction resumes, rather than starting a second physical request", async () => {
  const started = deferred()
  const release = deferred()
  let compactions = 0
  const fixture = proxyFixture(async function* () {}, 1000, {
    methods: ["native"],
    layouts: ["tail"],
    midTurn: true,
    official: () => true,
    async compact() {
      compactions++
      started.resolve()
      await release.promise
      return { ok: true, value: "checkpoint", usage: emptyUsage() }
    },
  })
  try {
    const connection = await fixture.connect()
    const work = fixture.proxy.compact(fixture.request)
    await started.promise
    connection.close()
    await connection.closed
    release.resolve()
    await fixture.connect()
    expect((await work).ok).toBe(true)
    expect(compactions).toBe(1)
  } finally {
    release.resolve()
    fixture.close()
  }
})

test("cancelled compact receipt replay consumes buffered progress cursors without applying effects", async () => {
  const started = deferred()
  const progress = deferred()
  const progressed = deferred()
  const release = deferred()
  const receipt = deferred<CompactReceipt>()
  const fixture = proxyFixture(async function* () {}, 1000, {
    methods: ["native"],
    layouts: ["tail"],
    midTurn: true,
    official: () => true,
    async compact(_method, _request, _context, onProgress) {
      started.resolve()
      await progress.promise
      onProgress?.()
      progressed.resolve()
      await release.promise
      return { ok: true, value: "late", usage: { ...emptyUsage(), cost: 0.3 } }
    },
  })
  let effects = 0
  try {
    const connection = await fixture.connect()
    const controller = new AbortController()
    const work = fixture.proxy.compact(
      fixture.request,
      controller.signal,
      () => effects++,
      (value) => {
        receipt.resolve(value)
      },
    )
    await started.promise
    connection.close()
    await connection.closed
    progress.resolve()
    await progressed.promise
    controller.abort()
    expect(await work).toMatchObject({ ok: false, aborted: true })
    await fixture.connect()
    release.resolve()
    expect(await receipt.promise).toMatchObject({ late: true, usage: { cost: 0.3 } })
    expect(effects).toBe(0)
  } finally {
    progress.resolve()
    release.resolve()
    fixture.close()
  }
})

test("late physical compaction receipts survive result ACK and reconnect without double charging", async () => {
  const release = deferred()
  const received = deferred<CompactReceipt>()
  let compactions = 0
  const fixture = proxyFixture(
    async function* () {},
    1000,
    {
      methods: ["native"],
      layouts: ["tail"],
      midTurn: true,
      official: () => true,
      async compact() {
        compactions++
        await release.promise
        return { ok: true, value: "late-checkpoint", usage: { ...emptyUsage(), cost: 0.2 } }
      },
    },
    10,
  )
  const receipts: CompactReceipt[] = []
  try {
    const connection = await fixture.connect()
    const result = await fixture.proxy.compact(fixture.request, undefined, undefined, (receipt) => {
      receipts.push(receipt)
      received.resolve(receipt)
    })
    expect(result).toMatchObject({ ok: false, timedOut: true })
    connection.close()
    await connection.closed
    release.resolve()
    await fixture.connect()
    expect(await received.promise).toMatchObject({ late: true, usage: { cost: 0.2 } })
    expect(receipts).toHaveLength(1)
    expect(compactions).toBe(1)
    for (const frame of fixture.observed) expect(frame).not.toContain(secret)
  } finally {
    release.resolve()
    fixture.close()
  }
})
