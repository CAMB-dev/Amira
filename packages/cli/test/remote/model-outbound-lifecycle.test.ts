import "../server/offline.ts"
import { expect, test } from "bun:test"
import type { StreamEvent } from "@amira/ai"
import { ModelOutboundFilter, type ModelOutboundItem } from "../../src/remote/model-outbound-filter.ts"

const key = "SENTINEL_LANE_SECRET"
const event = (value: StreamEvent): ModelOutboundItem => ({ kind: "event", value })
const deltas = (
  items: ModelOutboundItem[],
  type: "text.delta" | "thinking.delta" | "toolCall.delta",
  id?: string,
) =>
  items
    .flatMap((item) => {
      if (item.kind !== "event" || item.value.type !== type) return []
      if (item.value.type === "toolCall.delta")
        return id === undefined || item.value.id === id ? [item.value.argsDelta] : []
      return item.value.type === "text.delta" || item.value.type === "thinking.delta" ? [item.value.text] : []
    })
    .join("")

test("a completed thinking lane cannot block a long ordinary answer", () => {
  const filter = new ModelOutboundFilter([key], { maxItems: 16 })
  const output = filter.push(event({ type: "thinking.delta", text: "ordinary reasoning" }))
  output.push(...filter.push(event({ type: "thinking.end" })))
  for (let index = 0; index < 80; index++)
    output.push(...filter.push(event({ type: "text.delta", text: "ordinary answer chunk ".repeat(3) })))
  expect(deltas(output, "text.delta").length).toBeGreaterThan(3000)
  output.push(...filter.flush())
  expect(deltas(output, "text.delta")).toBe("ordinary answer chunk ".repeat(240))
})

test("a request.end message is closed locally, not a blocker for retry output", () => {
  const filter = new ModelOutboundFilter([key], { maxItems: 16 })
  const output = filter.push(
    event({
      type: "request.end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "failed attempt" }],
        model: { provider: "p", model: "m" },
      },
    }),
  )
  for (let index = 0; index < 80; index++)
    output.push(...filter.push(event({ type: "text.delta", text: "retried answer chunk ".repeat(3) })))
  expect(deltas(output, "text.delta").length).toBeGreaterThan(3000)
})

test("unindexed tools preserve independent argument lanes with unrelated interleaving", () => {
  const filter = new ModelOutboundFilter([key])
  const output = filter.push(event({ type: "toolCall.delta", id: "a", argsDelta: key.slice(0, 9) }))
  output.push(...filter.push(event({ type: "toolCall.delta", id: "b", argsDelta: "unrelated" })))
  output.push(...filter.push(event({ type: "toolCall.delta", id: "a", argsDelta: key.slice(9) })))
  output.push(...filter.flush())
  expect(deltas(output, "toolCall.delta", "a")).not.toContain(key)
})

for (const type of ["done", "error", "request.end"] as const) {
  test(`${type} preserves both combined and per-type content masks`, () => {
    const filter = new ModelOutboundFilter([key])
    const message = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: key.slice(0, 9) },
        { type: "thinking" as const, text: "unrelated" },
        { type: "text" as const, text: key.slice(9) },
      ],
      model: { provider: "p", model: "m" },
    }
    const value: StreamEvent =
      type === "error" ? { type, message, error: { message: "failed" }, retryable: false } : { type, message }
    const output = [...filter.push(event(value)), ...filter.flush()]
    for (const item of output) {
      if (item.kind === "event" && "message" in item.value)
        expect(
          item.value.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
        ).not.toContain(key)
    }
  })
}

test("continuing flush masks new fields that complete an old published prefix", () => {
  const filter = new ModelOutboundFilter([key])
  const output = [...filter.push(event({ type: "text.delta", text: key.slice(0, 9) })), ...filter.flush()]
  output.push(...filter.push(event({ type: "thinking.delta", text: key.slice(9) })), ...filter.flush())
  expect(
    output
      .flatMap((item) =>
        item.kind === "event" && (item.value.type === "text.delta" || item.value.type === "thinking.delta")
          ? [item.value.text]
          : [],
      )
      .join(""),
  ).not.toContain(key)
})
