import "../server/offline.ts"
import { expect, test } from "bun:test"
import { type AssistantMessage, addUsage, type CompactReceipt, emptyUsage, type Usage } from "@amira/ai"
import { hasUnpricedUsage } from "@amira/ai/accounting"
import { collectEvents, deferred, proxyFixture } from "./model-proxy-fixture.ts"

const number = 928374651
function aggregate(): Usage {
  return addUsage({ ...emptyUsage(), cost: number }, { ...emptyUsage(), webSearchRequests: 1 })
}
const creds = (key: string) => ({
  providers: [{ id: "p", dialect: "fixture", baseUrl: "https://provider.invalid/v1", apiKey: key }],
})

for (const sidecar of [false, true]) {
  for (const order of ["string-number", "number-string"] as const) {
    test(`${order} reconstruction includes ${sidecar ? "private accounting receipt" : "visible usage"} scalars`, async () => {
      const key = order === "string-number" ? `SENTINEL_${number}` : `${number}_SENTINEL`
      const string = order === "string-number" ? "SENTINEL_" : "_SENTINEL"
      const usage = sidecar ? aggregate() : { ...emptyUsage(), input: number }
      const fixture = proxyFixture(
        async function* (request) {
          const model = { provider: request.model.provider, model: request.model.id }
          if (order === "number-string" && sidecar) {
            yield { type: "request.end", message: { role: "assistant", content: [], model, usage } }
            yield {
              type: "done",
              message: {
                role: "assistant",
                content: [{ type: "text", text: string }],
                model,
                usage: emptyUsage(),
              },
            }
          } else {
            const message: AssistantMessage =
              order === "number-string"
                ? { role: "assistant", usage, content: [{ type: "text", text: string }], model }
                : { role: "assistant", content: [{ type: "text", text: string }], model, usage }
            yield { type: "done", message }
          }
        },
        1000,
        undefined,
        1000,
        creds(key),
      )
      try {
        await fixture.connect()
        const events = await collectEvents(fixture.proxy.stream(fixture.request))
        const last = events.at(-1)
        expect(last?.type === "error" || last?.type === "done").toBe(true)
        if (order === "string-number") {
          expect(last).toMatchObject({
            type: "error",
            retryable: false,
            message: { usage: { pricingUnknown: true, outputReported: false } },
          })
          if (last?.type === "error") expect(hasUnpricedUsage(last.message.usage!)).toBe(true)
        }
        if (last?.type === "done" && !sidecar) expect(last.message.usage?.input).toBe(number)
        const text = events
          .flatMap((event) =>
            "message" in event
              ? event.message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
              : [],
          )
          .join("")
        expect(order === "string-number" ? text + number : number + text).not.toContain(key)
        const frames = fixture.observed
          .slice(1)
          .join("")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
        const observed: string[] = []
        function scalar(value: unknown): void {
          if (typeof value === "string" || typeof value === "number") observed.push(String(value))
          else if (Array.isArray(value)) for (const child of value) scalar(child)
          else if (value && typeof value === "object") for (const child of Object.values(value)) scalar(child)
        }
        for (const frame of frames) if (frame.kind === "model.frame") scalar(frame.payload)
        expect(observed.join("")).not.toContain(key)
        for (const frame of fixture.observed) expect(frame).not.toContain(key)
      } finally {
        fixture.close()
      }
    })
  }
}

for (const value of [1e21, Number("1000000000000000128")]) {
  for (const sidecar of [false, true]) {
    test(`mixed ${sidecar ? "private" : "public"} scalar matching includes exact integer ${BigInt(value)}`, async () => {
      const key = `SENTINEL_${BigInt(value)}`
      const usage = sidecar
        ? addUsage({ ...emptyUsage(), cost: value }, { ...emptyUsage(), webSearchRequests: 1 })
        : { ...emptyUsage(), input: value }
      const fixture = proxyFixture(
        async function* (request) {
          yield {
            type: "done",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "SENTINEL_" }],
              model: { provider: request.model.provider, model: request.model.id },
              usage,
            },
          }
        },
        1000,
        undefined,
        1000,
        creds(key),
      )
      try {
        await fixture.connect()
        const terminal = (await collectEvents(fixture.proxy.stream(fixture.request))).at(-1)
        expect(terminal).toMatchObject({
          type: "error",
          message: { usage: { pricingUnknown: true, outputReported: false } },
        })
        if (terminal?.type === "error") expect(hasUnpricedUsage(terminal.message.usage!)).toBe(true)
        for (const frame of fixture.observed) {
          expect(frame).not.toContain(`"input":${value}`)
          expect(frame).not.toContain(`"knownCost":${value}`)
        }
      } finally {
        fixture.close()
      }
    })
  }
}

test("known equivalent fractional renderings cannot bypass mixed scalar checks", async () => {
  const decimal = "0.1000000000000000055511151231257827021181583404541015625"
  const key = `SENTINEL_${decimal}`
  const fixture = proxyFixture(
    async function* (request) {
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "SENTINEL_" }],
          model: { provider: request.model.provider, model: request.model.id },
          usage: { ...emptyUsage(), cost: Number(decimal) },
        },
      }
    },
    1000,
    undefined,
    1000,
    creds(key),
  )
  try {
    await fixture.connect()
    expect((await collectEvents(fixture.proxy.stream(fixture.request))).at(-1)).toMatchObject({
      type: "error",
      message: { usage: { pricingUnknown: true, outputReported: false } },
    })
    expect(fixture.observed.slice(1).join("")).not.toContain('"cost":0.1')
  } finally {
    fixture.close()
  }
})

test("a returned compact string cannot be completed by a late private receipt number", async () => {
  const received = deferred<CompactReceipt>()
  const key = `SENTINEL_${number}`
  const fixture = proxyFixture(
    async function* () {},
    1000,
    {
      methods: ["native"],
      layouts: ["tail"],
      midTurn: true,
      official: () => true,
      async compact() {
        return { ok: true, value: "unused", usage: emptyUsage() }
      },
    },
    1000,
    creds(key),
  )
  let lateUsage: Parameters<typeof fixture.ai.compact>[3]
  fixture.ai.compact = async (_request, _signal, _progress, onUsage) => {
    lateUsage = onUsage
    return {
      ok: true,
      checkpoint: { dialect: "fixture", value: "checkpoint" },
      summary: "SENTINEL_",
      method: "native",
      usage: emptyUsage(),
      tried: [],
    }
  }
  try {
    await fixture.connect()
    expect(
      await fixture.proxy.compact(fixture.request, undefined, undefined, (receipt) => {
        received.resolve(receipt)
      }),
    ).toMatchObject({ ok: true, summary: "SENTINEL_" })
    expect(lateUsage).toBeDefined()
    await lateUsage?.({ id: "late-attempt", late: true, usage: aggregate() })
    expect(await received.promise).not.toHaveProperty("usage")
    const frames = fixture.observed.slice(1).join("")
    expect(frames).not.toContain(`"knownCost":${number}`)
    expect(frames).not.toContain(key)
  } finally {
    fixture.close()
  }
})

test("mixed private accounting in native compaction fails closed and remains incomplete", async () => {
  const key = `SENTINEL_${number}`
  const fixture = proxyFixture(
    async function* () {},
    1000,
    {
      methods: ["native"],
      layouts: ["tail"],
      midTurn: true,
      official: () => true,
      async compact() {
        return { ok: true, value: "checkpoint", summary: "SENTINEL_", usage: aggregate() }
      },
    },
    1000,
    creds(key),
  )
  try {
    await fixture.connect()
    const result = await fixture.proxy.compact(fixture.request)
    expect(result).toMatchObject({
      ok: false,
      usageIncomplete: true,
      usage: { pricingUnknown: true, outputReported: false },
    })
    expect(hasUnpricedUsage(result.usage)).toBe(true)
    expect(result.ok ? (result.summary ?? "") : result.error).not.toContain("SENTINEL_")
    for (const frame of fixture.observed) expect(frame).not.toContain(key)
  } finally {
    fixture.close()
  }
})
