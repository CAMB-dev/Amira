import "../server/offline.ts"
import { expect, test } from "bun:test"
import { emptyUsage } from "@amira/ai"
import { OutboundObserver } from "./model-outbound-observer.ts"
import { collectEvents, proxyFixture, secret } from "./model-proxy-fixture.ts"

for (const interleaved of [false, true]) {
  test(`remote deltas cannot reconstruct credentials across ${interleaved ? "text with unrelated interleaved thinking" : "text and thinking"}`, async () => {
    const fixture = proxyFixture(async function* (request) {
      yield { type: "text.delta", text: secret.slice(0, 12) }
      if (interleaved) yield { type: "thinking.delta", text: "unrelated thinking" }
      yield { type: interleaved ? "text.delta" : "thinking.delta", text: secret.slice(12) }
      yield {
        type: "done",
        message: {
          role: "assistant",
          model: { provider: request.model.provider, model: request.model.id },
          content: [{ type: "text", text: "safe final answer" }],
          usage: emptyUsage(),
        },
      }
    })
    try {
      await fixture.connect()
      const events = await collectEvents(fixture.proxy.stream(fixture.request))
      expect(events.at(-1)?.type).toBe("done")
      const deltas = events.filter((event) => event.type === "text.delta" || event.type === "thinking.delta")
      expect(deltas.map((event) => event.type)).toEqual(
        interleaved ? ["text.delta", "thinking.delta", "text.delta"] : ["text.delta", "thinking.delta"],
      )
      expect(deltas.map((event) => event.text).join("")).not.toContain(secret)
      for (const lane of ["text.delta", "thinking.delta"])
        expect(
          deltas
            .filter((event) => event.type === lane)
            .map((event) => event.text)
            .join(""),
        ).not.toContain(secret)
      for (const frame of fixture.observed) expect(frame).not.toContain(secret)
    } finally {
      fixture.close()
    }
  })
}

test("an unrepresentable cross-field tool key produces a sanitized terminal instead of silently dropping events", async () => {
  const fixture = proxyFixture(async function* (request) {
    yield { type: "text.delta", text: secret.slice(0, 12) }
    yield {
      type: "serverTool",
      block: {
        type: "serverTool",
        id: "",
        name: "",
        input: { [secret.slice(12)]: "" },
        status: "done",
      },
    }
    yield {
      type: "done",
      message: {
        role: "assistant",
        model: { provider: request.model.provider, model: request.model.id },
        content: [{ type: "text", text: "safe final answer" }],
        usage: emptyUsage(),
      },
    }
  })
  try {
    await fixture.connect()
    const events = await collectEvents(fixture.proxy.stream(fixture.request))
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: false })
    expect(events.at(-1)).toHaveProperty("message.usage.outputReported", false)
    const observer = new OutboundObserver(fixture.bindings.resolve(fixture.request.model).secrets)
    for (const event of events) observer.observe({ kind: "event", value: event })
    for (const frame of fixture.observed) expect(frame).not.toContain(secret)
  } finally {
    fixture.close()
  }
})
