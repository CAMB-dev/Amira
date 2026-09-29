import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { describeModelError, isContextOverflow, modelErrorKind, providerMessage } from "../src/errors.ts"
import { events } from "./helpers.ts"

test("sorts failures into auth, rate, server, network, context, config and other", () => {
  expect(modelErrorKind({ message: "HTTP 401: nope", status: 401 })).toBe("auth")
  expect(modelErrorKind({ message: "HTTP 403: nope", status: 403 })).toBe("auth")
  expect(modelErrorKind({ message: "HTTP 429: slow down", status: 429 })).toBe("rate")
  expect(modelErrorKind({ message: "Overloaded", status: 529 })).toBe("server")
  expect(modelErrorKind({ message: "request failed: Unable to connect" })).toBe("network")
  expect(modelErrorKind({ message: "stream failed: socket closed" })).toBe("network")
  expect(modelErrorKind({ message: "no model selected", code: "no_model" })).toBe("config")
  expect(modelErrorKind({ message: "HTTP 400: bad tool schema", status: 400 })).toBe("other")
  const overflow = {
    message: `HTTP 400: {"error":{"message":"This model's maximum context length is 128000 tokens.","code":"context_length_exceeded"}}`,
    status: 400,
    code: "context_length_exceeded",
  }
  expect(modelErrorKind(overflow)).toBe("context")
  expect(
    isContextOverflow({ message: "prompt is too long: 210000 tokens > 200000 maximum", status: 400 }),
  ).toBe(true)
  // A rate limit that mentions tokens is still a rate limit.
  expect(isContextOverflow({ message: "too many tokens per minute", status: 429 })).toBe(false)
})

test("reads a failure as one line, the next step and the provider's raw answer", () => {
  const auth = describeModelError(
    {
      message: `HTTP 401: {"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}`,
      status: 401,
      host: "api.deepseek.com",
    },
    { provider: "deepseek" },
  )
  expect(auth).toEqual({
    kind: "auth",
    summary: "The API key was rejected by api.deepseek.com (HTTP 401)",
    hint: "Set a new key with /provider key deepseek",
    detail: `HTTP 401: {"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}`,
  })
  const rate = describeModelError({ message: "HTTP 429: busy", status: 429, host: "x.io", retries: 3 })
  expect(rate.summary).toBe("Rate limited by x.io (HTTP 429), retried 3 times")
  expect(rate.hint).toContain("Try again in a moment")
  const net = describeModelError({ message: "request failed: Unable to connect", host: "10.0.0.2:8080" })
  expect(net.summary).toBe("Cannot reach 10.0.0.2:8080: Unable to connect")
  expect(net.detail).toBeUndefined()
  const ctx = describeModelError({ message: "HTTP 400: maximum context length exceeded", status: 400 })
  expect(ctx.kind).toBe("context")
  expect(ctx.hint).toContain("/compact")
  const other = describeModelError({ message: `HTTP 400: {"error":{"message":"bad schema"}}`, status: 400 })
  expect(other.summary).toBe("Model request failed (HTTP 400): bad schema")
  expect(other.detail).toContain('"bad schema"')
  expect(
    describeModelError({ message: "no model selected; pick one with /model", code: "no_model" }),
  ).toEqual({
    kind: "config",
    summary: "No model selected; pick one with /model",
  })
})

test("takes the message out of a JSON error body", () => {
  expect(providerMessage(`HTTP 400: {"error":{"message":"m1"}}`)).toBe("m1")
  expect(providerMessage(`HTTP 400: [{"error":{"message":"m2"}}]`)).toBe("m2")
  expect(providerMessage(`HTTP 400: {"error":"m3"}`)).toBe("m3")
  expect(providerMessage("HTTP 502: <html>bad gateway</html>")).toBe("<html>bad gateway</html>")
  expect(providerMessage("plain")).toBe("plain")
})

test("errors from the client carry their kind, the host and how often they were retried", async () => {
  let n = 0
  const ai = createAi({
    retry: { retries: 2, baseDelayMs: 1 },
    fetch: (async () => {
      n++
      return new Response("busy", { status: 429 })
    }) as unknown as typeof fetch,
    providers: [{ id: "p", dialect: "openai-chat", baseUrl: "http://api.example.com/v1" }],
  })
  const evs = await events(ai.stream({ model: ai.model("p/m"), systemPrompt: "", messages: [], tools: [] }))
  expect(n).toBe(3)
  const retries = evs.filter((e) => e.type === "retry")
  expect(retries.map((e) => e.type === "retry" && e.error.kind)).toEqual(["rate", "rate"])
  const last = evs.at(-1)
  expect(last).toMatchObject({
    type: "error",
    error: { status: 429, kind: "rate", host: "api.example.com", retries: 2 },
  })
})
