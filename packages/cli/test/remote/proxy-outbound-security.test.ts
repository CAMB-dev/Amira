import "../server/offline.ts"
import { expect, test } from "bun:test"
import { addUsage, emptyUsage, type StreamEvent } from "@amira/ai"
import { collectEvents, deferred, proxyFixture, secret } from "./model-proxy-fixture.ts"

for (const type of ["done", "error", "request.end"] as const) {
  for (const mixed of [false, true]) {
    test(`${type} masks credentials reconstructed across ${mixed ? "text and thinking" : "text"} message blocks`, async () => {
      const fixture = proxyFixture(async function* (request) {
        const message = {
          role: "assistant" as const,
          model: { provider: request.model.provider, model: request.model.id },
          content: [
            { type: "text" as const, text: secret.slice(0, 12) },
            { type: mixed ? ("thinking" as const) : ("text" as const), text: secret.slice(12) },
          ],
          usage: emptyUsage(),
        }
        if (type === "error") yield { type, message, error: { message: "failed" }, retryable: false }
        else yield { type, message }
        if (type === "request.end")
          yield { type: "done", message: { ...message, content: [{ type: "text", text: "safe" }] } }
      })
      try {
        await fixture.connect()
        const events = await collectEvents(fixture.proxy.stream(fixture.request))
        expect(events.some((event) => event.type === type)).toBe(true)
        for (const event of events) {
          if (!("message" in event)) continue
          expect(event.message.content).toHaveLength(type === "request.end" && event.type === "done" ? 1 : 2)
          expect(
            event.message.content
              .flatMap((block) => (block.type === "text" || block.type === "thinking" ? [block.text] : []))
              .join(""),
          ).not.toContain(secret)
        }
        for (const frame of fixture.observed) expect(frame).not.toContain(secret)
        const frames = fixture.observed
          .slice(1)
          .join("")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
        for (const frame of frames) {
          const blocks = frame.payload?.data?.value?.message?.content ?? []
          expect(blocks.map((block: { text?: string }) => block.text ?? "").join("")).not.toContain(secret)
        }
      } finally {
        fixture.close()
      }
    })
  }
}

const numericKey = "928374651"
const credentials = {
  providers: [{ id: "p", dialect: "fixture", baseUrl: "https://provider.invalid/v1", apiKey: numericKey }],
}
for (const hidden of [false, true]) {
  test(`numeric credentials in ${hidden ? "private accounting sidecars" : "visible usage"} fail closed before the model frame is sent`, async () => {
    const usage = hidden
      ? addUsage({ ...emptyUsage(), cost: Number(numericKey) }, { ...emptyUsage(), webSearchRequests: 1 })
      : { ...emptyUsage(), input: Number(numericKey) }
    const fixture = proxyFixture(
      async function* (request) {
        yield {
          type: "done",
          message: {
            role: "assistant",
            model: { provider: request.model.provider, model: request.model.id },
            content: [{ type: "text", text: "safe" }],
            usage,
          },
        }
      },
      1000,
      undefined,
      1000,
      credentials,
    )
    try {
      await fixture.connect()
      const events = await collectEvents(fixture.proxy.stream(fixture.request))
      expect(events.at(-1)).toMatchObject({
        type: "error",
        retryable: false,
        message: { usage: { pricingUnknown: true, outputReported: false } },
      })
      for (const frame of fixture.observed) expect(frame).not.toContain(numericKey)
    } finally {
      fixture.close()
    }
  })
}

test("unsafe numeric compaction usage and receipt sidecars become an incomplete terminal failure", async () => {
  const fixture = proxyFixture(
    async function* () {},
    1000,
    {
      methods: ["native"],
      layouts: ["tail"],
      midTurn: true,
      official: () => true,
      async compact() {
        return { ok: true, value: "checkpoint", usage: { ...emptyUsage(), input: Number(numericKey) } }
      },
    },
    1000,
    credentials,
  )
  const receipts: unknown[] = []
  try {
    await fixture.connect()
    const result = await fixture.proxy.compact(fixture.request, undefined, undefined, (receipt) => {
      receipts.push(receipt)
    })
    expect(result).toMatchObject({
      ok: false,
      usageIncomplete: true,
      usage: { pricingUnknown: true, outputReported: false },
    })
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).not.toHaveProperty("usage")
    for (const frame of fixture.observed) expect(frame).not.toContain(numericKey)
  } finally {
    fixture.close()
  }
})

test("late numeric native-compaction receipts remain incomplete without leaking after the result", async () => {
  const release = deferred()
  const received = deferred<unknown>()
  const fixture = proxyFixture(
    async function* () {},
    1000,
    {
      methods: ["native"],
      layouts: ["tail"],
      midTurn: true,
      official: () => true,
      async compact() {
        await release.promise
        return { ok: true, value: "late", usage: { ...emptyUsage(), input: Number(numericKey) } }
      },
    },
    10,
    credentials,
  )
  try {
    await fixture.connect()
    expect(
      await fixture.proxy.compact(fixture.request, undefined, undefined, (receipt) => {
        received.resolve(receipt)
      }),
    ).toMatchObject({ ok: false, timedOut: true })
    release.resolve()
    const receipt = await received.promise
    expect(receipt).toMatchObject({ late: true })
    expect(receipt).not.toHaveProperty("usage")
    for (const frame of fixture.observed) expect(frame).not.toContain(numericKey)
  } finally {
    release.resolve()
    fixture.close()
  }
})

for (const compact of [false, true]) {
  for (const hidden of [false, true]) {
    test(`scientific-notation ${compact ? "compaction" : "stream"} ${hidden ? "accounting sidecar" : "usage"} cannot reconstruct a decimal credential`, async () => {
      const key = "1000000000000000000000"
      const usage = hidden
        ? addUsage({ ...emptyUsage(), cost: Number(key) }, { ...emptyUsage(), webSearchRequests: 1 })
        : { ...emptyUsage(), input: Number(key) }
      const fixture = proxyFixture(
        async function* (request) {
          yield {
            type: "done",
            message: {
              role: "assistant",
              content: [],
              model: { provider: request.model.provider, model: request.model.id },
              usage,
            },
          }
        },
        1000,
        {
          methods: ["native"],
          layouts: ["tail"],
          midTurn: true,
          official: () => true,
          async compact() {
            return { ok: true, value: "checkpoint", usage }
          },
        },
        1000,
        { providers: [{ ...credentials.providers[0]!, apiKey: key }] },
      )
      try {
        await fixture.connect()
        if (compact)
          expect(await fixture.proxy.compact(fixture.request)).toMatchObject({
            ok: false,
            usageIncomplete: true,
          })
        else
          expect((await collectEvents(fixture.proxy.stream(fixture.request))).at(-1)).toMatchObject({
            type: "error",
            message: { usage: { pricingUnknown: true, outputReported: false } },
          })
        function assertNumbers(value: unknown): void {
          if (typeof value === "number") expect(value.toFixed(0)).not.toBe(key)
          if (value && typeof value === "object")
            for (const child of Object.values(value)) assertNumbers(child)
        }
        assertNumbers(JSON.parse(fixture.observed[0]!))
        for (const frame of fixture.observed.slice(1).join("").split("\n").filter(Boolean))
          assertNumbers(JSON.parse(frame))
      } finally {
        fixture.close()
      }
    })
  }
}

for (const compact of [false, true]) {
  test(`schema-owned enum collisions produce incomplete ${compact ? "compact" : "stream"} failures`, async () => {
    const usage = { ...emptyUsage(), input: 17, output: 2, speed: "standard" as const }
    const fixture = proxyFixture(
      async function* (request) {
        yield {
          type: "done",
          message: {
            role: "assistant",
            model: { provider: request.model.provider, model: request.model.id },
            content: [],
            usage,
          },
        }
      },
      1000,
      {
        methods: ["native"],
        layouts: ["tail"],
        midTurn: true,
        official: () => true,
        async compact() {
          return { ok: true, value: "checkpoint", usage }
        },
      },
      1000,
      {
        providers: [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: exact adjacent environment substitutions
          { ...credentials.providers[0]!, apiKey: secret, headers: { "X-Private": "${PREFIX}${TOKEN}" } },
        ],
        env: { PREFIX: "standard", TOKEN: "SENTINEL_SCHEMA_COLLISION" },
      },
    )
    try {
      await fixture.connect()
      if (compact)
        expect(await fixture.proxy.compact(fixture.request)).toMatchObject({
          ok: false,
          usageIncomplete: true,
          usage: { pricingUnknown: true, outputReported: false },
        })
      else
        expect((await collectEvents(fixture.proxy.stream(fixture.request))).at(-1)).toMatchObject({
          type: "error",
          message: { usage: { pricingUnknown: true, outputReported: false } },
        })
      for (const frame of fixture.observed) {
        expect(frame).not.toContain("standard")
        expect(frame).not.toContain("SENTINEL_SCHEMA_COLLISION")
      }
    } finally {
      fixture.close()
    }
  })
}

test("a numeric tool argument echo is rejected, not coerced into an executable different argument", async () => {
  const fixture = proxyFixture(
    async function* (request) {
      yield {
        type: "done",
        message: {
          role: "assistant",
          model: { provider: request.model.provider, model: request.model.id },
          content: [{ type: "toolCall", id: "t1", name: "write", args: { number: Number(numericKey) } }],
        },
      }
    },
    1000,
    undefined,
    1000,
    credentials,
  )
  try {
    await fixture.connect()
    const events: StreamEvent[] = await collectEvents(fixture.proxy.stream(fixture.request))
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: false })
    for (const frame of fixture.observed) expect(frame).not.toContain(numericKey)
  } finally {
    fixture.close()
  }
})
