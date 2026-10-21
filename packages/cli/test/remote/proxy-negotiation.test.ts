import "../server/offline.ts"
import { expect, test } from "bun:test"
import { emptyUsage } from "@amira/ai"
import { collectEvents, deferred, proxyFixture } from "./model-proxy-fixture.ts"

const message = {
  role: "assistant" as const,
  model: { provider: "p", model: "m" },
  content: [{ type: "text" as const, text: "completed" }],
  stopReason: "end" as const,
}
const opens = (sent: string[]) =>
  sent
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((frame) => frame.kind === "request" && frame.op === "model.open")

for (const operation of ["stream", "compact"] as const)
  for (const approved of [false, true])
    test(`never-attempted ${operation} checks newly negotiated ${approved ? "approved" : "declined"} metadata after admission`, async () => {
      let attempts = 0
      const fixture = proxyFixture(
        async function* () {
          attempts++
          yield { type: "done", message }
        },
        1000,
        {
          methods: ["native"],
          layouts: ["tail"],
          midTurn: true,
          official: () => true,
          async compact() {
            attempts++
            return { ok: true, value: "checkpoint", usage: emptyUsage() }
          },
        },
      )
      try {
        const metadata = fixture.broker.metadata([fixture.request.model])
        fixture.proxy.bindMetadata(
          metadata.map((item) => ({ ...item, revision: "old", available: !approved })),
        )
        const work =
          operation === "stream"
            ? collectEvents(fixture.proxy.stream(fixture.request))
            : fixture.proxy.compact(fixture.request)
        const server = await fixture.connect(false, { paused: true })
        await Bun.sleep(0)
        expect(opens(fixture.sent)).toHaveLength(0)
        fixture.proxy.bindMetadata(metadata.map((item) => ({ ...item, available: approved })))
        fixture.proxy.admit(server)
        const result = await work
        if (operation === "stream") {
          expect(result).toEqual(
            expect.arrayContaining([
              expect.objectContaining(
                approved
                  ? { type: "done" }
                  : {
                      type: "error",
                      error: expect.objectContaining({ code: "model_binding_rejected", kind: "config" }),
                    },
              ),
            ]),
          )
        } else
          expect(result).toMatchObject(
            approved
              ? { ok: true }
              : { ok: false, failure: { code: "model_binding_rejected", kind: "config" } },
          )
        expect(attempts).toBe(approved ? 1 : 0)
        expect(opens(fixture.sent)).toHaveLength(approved ? 1 : 0)
        if (approved)
          expect(opens(fixture.sent)[0].params).toMatchObject({
            revision: metadata[0]!.revision,
            resume: false,
          })
      } finally {
        fixture.close()
      }
    })

for (const replaceProcess of [false, true])
  test(`attempted stream keeps its id and revision after negotiation with ${replaceProcess ? "fresh" : "retained"} local process`, async () => {
    const release = deferred()
    let attempts = 0
    const fixture = proxyFixture(async function* () {
      attempts++
      yield { type: "text.delta", text: "partial ".repeat(40) }
      yield { type: "text.delta", text: "more ".repeat(40) }
      await release.promise
      yield { type: "done", message }
    })
    try {
      const original = await fixture.connect()
      const iterator = fixture.proxy.stream(fixture.request)[Symbol.asyncIterator]()
      while ((await iterator.next()).value?.type !== "text.delta") {}
      original.close()
      await original.closed
      const server = await fixture.connect(replaceProcess, { paused: true })
      fixture.proxy.bindMetadata(
        fixture.broker
          .metadata([fixture.request.model])
          .map((item) => ({ ...item, revision: "new-process-revision" })),
      )
      fixture.proxy.admit(server)
      release.resolve()
      const rest = []
      while (true) {
        const next = await iterator.next()
        if (next.done) break
        rest.push(next.value)
      }
      expect(rest.at(-1)).toMatchObject(
        replaceProcess
          ? { type: "error", error: { code: "proxy_broker_lost" }, retryable: false }
          : { type: "done" },
      )
      expect(attempts).toBe(1)
      const calls = opens(fixture.sent)
      expect(calls).toHaveLength(2)
      expect(calls[1].params).toMatchObject({
        callId: calls[0].params.callId,
        revision: calls[0].params.revision,
        resume: true,
      })
    } finally {
      release.resolve()
      fixture.close()
    }
  })

test("a fenced attachment cannot open the replacement model admission gate", async () => {
  const fixture = proxyFixture(async function* () {
    yield { type: "done", message }
  })
  try {
    const old = await fixture.connect(false, { paused: true })
    const work = collectEvents(fixture.proxy.stream(fixture.request))
    const current = await fixture.connect(false, { paused: true })
    fixture.proxy.admit(old)
    await Bun.sleep(0)
    expect(opens(fixture.sent)).toHaveLength(0)
    fixture.proxy.admit(current)
    expect((await work).at(-1)?.type).toBe("done")
    expect(opens(fixture.sent)).toHaveLength(1)
  } finally {
    fixture.close()
  }
})
