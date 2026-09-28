import { expect, test } from "bun:test"
import type { StreamEvent } from "../src/types.ts"
import { delta, type ErrorEvent, events, fakeFetch, request, sseResponse, testAi } from "./helpers.ts"

async function run(res: Response | (() => Response)) {
  const ai = testAi(fakeFetch(res))
  return events(ai.stream(request(ai)))
}

const last = (evs: StreamEvent[]) => evs.at(-1)!
const terminal = (evs: StreamEvent[]) => evs.filter((e) => e.type === "done" || e.type === "error")

test("maps finish reasons to stop reasons", async () => {
  const stopOf = async (finish: string) => {
    const e = last(await run(() => sseResponse([delta({ content: "hi" }, finish)])))
    return e.type === "done" ? e.message.stopReason : `error:${(e as ErrorEvent).message.stopReason}`
  }
  expect(await stopOf("stop")).toBe("end")
  expect(await stopOf("length")).toBe("maxTokens")
  expect(await stopOf("tool_calls")).toBe("toolUse")
  expect(await stopOf("something_new")).toBe("end")
})

test("reports maxTokens when a tool call is cut off by the length limit", async () => {
  const e = last(
    await run(() =>
      sseResponse([
        delta(
          { tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: '{"p' } }] },
          "length",
        ),
      ]),
    ),
  )
  expect(e.type).toBe("done")
  if (e.type !== "done") return
  expect(e.message.stopReason).toBe("maxTokens")
  expect(e.message.content).toEqual([
    { type: "toolCall", id: "a", name: "read", args: { __invalidJson: '{"p' } },
  ])
})

test("reports toolUse for tool calls finished with stop", async () => {
  const e = last(
    await run(() =>
      sseResponse([
        delta({ tool_calls: [{ index: 0, id: "a", function: { name: "r", arguments: "{}" } }] }, "stop"),
      ]),
    ),
  )
  expect(e.type === "done" && e.message.stopReason).toBe("toolUse")
})

test("reports content_filter as an error that keeps the partial message", async () => {
  const evs = await run(() => sseResponse([delta({ content: "par" }, "content_filter")]))
  expect(terminal(evs)).toHaveLength(1)
  const e = last(evs) as ErrorEvent
  expect(e.type).toBe("error")
  expect(e.error.message).toMatch(/filtered/)
  expect(e.error.code).toBe("content_filter")
  expect(e.retryable).toBe(false)
  expect(e.message.stopReason).toBe("error")
  expect(e.message.content).toEqual([{ type: "text", text: "par" }])
})
