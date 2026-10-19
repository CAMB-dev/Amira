import "../server/offline.ts"
import { expect, test } from "bun:test"
import { type CompactReceipt, emptyUsage, type StreamEvent } from "@amira/ai"
import { decodeModelEvent } from "../../src/remote/model-codec.ts"
import { deferred } from "./model-proxy-fixture.ts"
import { transportFixture } from "./model-transport-fixture.ts"

const done: StreamEvent = {
  type: "done",
  message: { role: "assistant", model: { provider: "p", model: "m" }, content: [], stopReason: "end" },
}

test("explicit abort beats buffered deltas and a successful stream terminal", async () => {
  const buffered = deferred()
  const controller = new AbortController()
  const fixture = transportFixture(async function* () {
    yield { type: "text.delta", text: "first ".repeat(30) }
    yield { type: "text.delta", text: "second ".repeat(30) }
    yield done
  })
  try {
    await fixture.connectTransport({
      received(frame) {
        if (frame.kind === "model.frame") {
          const payload = frame.payload as { kind: string; data: unknown }
          if (payload.kind === "stream" && decodeModelEvent(payload.data).type === "done") buffered.resolve()
        }
      },
    })
    const iterator = fixture.proxy.stream(fixture.request, controller.signal)[Symbol.asyncIterator]()
    let first: IteratorResult<StreamEvent>
    do {
      first = await iterator.next()
    } while (!first.done && first.value.type !== "text.delta")
    expect(first.value).toMatchObject({ type: "text.delta" })
    await buffered.promise
    controller.abort()
    expect((await iterator.next()).value).toMatchObject({
      type: "error",
      error: { code: "proxy_cancelled" },
      message: { stopReason: "aborted" },
    })
    expect((await iterator.next()).done).toBe(true)
  } finally {
    fixture.close()
  }
})

test("explicit abort beats a buffered successful compact terminal", async () => {
  const controller = new AbortController()
  const receipts: CompactReceipt[] = []
  const fixture = transportFixture(async function* () {}, 1000, {
    methods: ["native"],
    layouts: ["tail"],
    midTurn: true,
    official: () => true,
    async compact() {
      return { ok: true, value: "discarded", usage: { ...emptyUsage(), cost: 0.4 } }
    },
  })
  try {
    await fixture.connectTransport({
      received(frame) {
        if (frame.kind === "model.frame" && (frame.payload as { kind: string }).kind === "compact")
          controller.abort()
      },
    })
    const result = await fixture.proxy.compact(fixture.request, controller.signal, undefined, (receipt) => {
      receipts.push(receipt)
    })
    expect(result).toMatchObject({ ok: false, aborted: true, failure: { code: "proxy_cancelled" } })
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.usage?.cost).toBe(0.4)
  } finally {
    fixture.close()
  }
})

test("cancelled compact still accounts for late physical receipts without applying buffered progress", async () => {
  const controller = new AbortController()
  const receipt = deferred<CompactReceipt>()
  const release = deferred()
  let effects = 0
  const fixture = transportFixture(async function* () {}, 1000, {
    methods: ["native"],
    layouts: ["tail"],
    midTurn: true,
    official: () => true,
    async compact(_method, _request, _context, progress) {
      progress?.()
      progress?.()
      await release.promise
      return { ok: true, value: "late", usage: { ...emptyUsage(), cost: 0.7 } }
    },
  })
  try {
    await fixture.connectTransport()
    const result = await fixture.proxy.compact(
      fixture.request,
      controller.signal,
      () => {
        effects++
        controller.abort()
      },
      (value) => {
        receipt.resolve(value)
      },
    )
    expect(result).toMatchObject({ ok: false, aborted: true })
    expect(effects).toBe(1)
    release.resolve()
    expect(await receipt.promise).toMatchObject({ late: true, usage: { cost: 0.7 } })
  } finally {
    release.resolve()
    fixture.close()
  }
})
