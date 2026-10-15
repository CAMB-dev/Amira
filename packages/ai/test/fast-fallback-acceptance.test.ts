import { describe, expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import type { ModelRequest, StreamEvent } from "../src/types.ts"
import { delta, events, fakeFetch, type Seen, sseResponse } from "./helpers.ts"

type Format = "http" | "sse" | "plain"
type ProviderError = { code: string; message?: string; status?: number; [key: string]: unknown }

for (const dialect of ["openai-chat", "openai-responses"] as const) {
  describe(`${dialect} fast fallback acceptance`, () => {
    function failure(format: Format, error: ProviderError, status = 429, partial = false) {
      return () => {
        // Serving/request metadata must not turn an ordinary account error into a priority error.
        const body = { error, service_tier: "priority", request: { service_tier: "priority" } }
        if (format === "http") return Response.json(body, { status })
        if (format === "plain") return Response.json(body)
        const prefix = partial
          ? dialect === "openai-chat"
            ? [delta({ content: "partial" })]
            : [{ type: "response.output_text.delta", item_id: "m", delta: "partial" }]
          : []
        return sseResponse([...prefix, { type: "error", ...body }], false)
      }
    }

    const success = () =>
      dialect === "openai-chat"
        ? sseResponse([delta({ content: "ok" }, "stop")])
        : sseResponse([
            { type: "response.output_text.delta", item_id: "m", delta: "ok" },
            { type: "response.completed", response: { status: "completed" } },
          ])

    function setup(responses: (() => Response)[], retries = 0, fastMode = true) {
      const seen: Seen[] = []
      const ai = createAi({
        providers: [
          {
            id: "test",
            dialect,
            baseUrl: "https://fake.invalid/v1",
            defaultModel: { fast: { kind: "service-tier", value: "priority" } },
          },
        ],
        retry: { retries, baseDelayMs: 0 },
        fetch: (async (url, init) => {
          const attempt: Seen = {}
          seen.push(attempt)
          const response = responses.shift()
          if (!response) throw new Error("unexpected request")
          return fakeFetch(response, attempt)(url, init)
        }) as typeof fetch,
      })
      const req: ModelRequest = {
        model: ai.model("test/model"),
        systemPrompt: "",
        messages: [],
        tools: [],
        fastMode,
      }
      return { seen, req, stream: () => events(ai.stream(req)) }
    }

    function fallbackCount(out: StreamEvent[]) {
      return out.filter((ev) => ev.type === "fast.fallback").length
    }

    for (const format of ["http", "sse", "plain"] as const) {
      test(`${format}: account RPM with priority metadata retains ordinary backoff`, async () => {
        const { seen, stream } = setup(
          [failure(format, { code: "rate_limit_exceeded", message: "Account RPM exceeded" }), success],
          1,
        )
        const out = await stream()
        expect(seen.map((s) => s.body.service_tier)).toEqual(["priority", "priority"])
        expect(fallbackCount(out)).toBe(0)
        expect(out.filter((ev) => ev.type === "retry")).toHaveLength(1)
        expect(out.at(-1)?.type).toBe("done")
      })

      test(`${format}: arbitrary error metadata is not a tier-specific message`, async () => {
        const { seen, stream } = setup(
          [
            failure(format, {
              code: "rate_limit_exceeded",
              debug: { message: "Priority capacity exhausted", service_tier: "priority" },
            }),
            success,
          ],
          1,
        )
        const out = await stream()
        expect(seen.map((s) => s.body.service_tier)).toEqual(["priority", "priority"])
        expect(fallbackCount(out)).toBe(0)
        expect(out.filter((ev) => ev.type === "retry")).toHaveLength(1)
      })

      for (const code of [
        "priority_rate_limit_exceeded",
        "priority_capacity_exceeded",
        "priority_capacity_unavailable",
        "fast_mode_rate_limit_exceeded",
        "fast_capacity_exhausted",
      ]) {
        test(`${format}: ${code} falls back once through the shared notice event`, async () => {
          const { seen, req, stream } = setup([
            failure(
              format,
              { code, message: "Request cannot be served" },
              code.includes("capacity") ? 529 : 429,
            ),
            success,
          ])
          const out = await stream()
          expect(seen.map((s) => s.body.service_tier)).toEqual(["priority", "default"])
          expect(fallbackCount(out)).toBe(1)
          expect(out.some((ev) => ev.type === "error" || ev.type === "retry")).toBe(false)
          const notice = out.findIndex((ev) => ev.type === "fast.fallback")
          expect(out[notice - 1]?.type).toBe("request.end")
          expect(out[notice + 1]?.type).toBe("request.start")
          expect(out.at(-1)?.type).toBe("done")
          expect(req.fastMode).toBe(true)
        })
      }

      test(`${format}: standard attempt never loops back into fallback`, async () => {
        const error = { code: "priority_rate_limit_exceeded", message: "Priority rate limit exceeded" }
        const { seen, stream } = setup([failure(format, error), failure(format, error)])
        const out = await stream()
        expect(seen.map((s) => s.body.service_tier)).toEqual(["priority", "default"])
        expect(fallbackCount(out)).toBe(1)
        expect(out.at(-1)).toMatchObject({ type: "error", retryable: true, error: { status: 429 } })
      })

      test(`${format}: ordinary capacity limits retain normal backoff`, async () => {
        const { seen, stream } = setup(
          [
            failure(format, { code: "overloaded_error", message: "Account capacity exhausted" }, 529),
            success,
          ],
          1,
        )
        const out = await stream()
        expect(seen.map((s) => s.body.service_tier)).toEqual(["priority", "priority"])
        expect(fallbackCount(out)).toBe(0)
        expect(out.filter((ev) => ev.type === "retry")).toHaveLength(1)
        expect(out.at(-1)?.type).toBe("done")
      })

      test(`${format}: unrecognized priority validation codes are not normalized`, async () => {
        const { seen, stream } = setup([
          failure(
            format,
            { code: "priority_rate_limit_parameter_invalid", message: "Invalid parameter" },
            400,
          ),
        ])
        const out = await stream()
        expect(seen).toHaveLength(1)
        expect(fallbackCount(out)).toBe(0)
        expect(out.at(-1)).toMatchObject({ type: "error", retryable: false })
      })

      test(`${format}: generic quota exhaustion never falls back`, async () => {
        const { seen, stream } = setup([
          failure(format, { code: "insufficient_quota", message: "Account quota exhausted" }),
        ])
        const out = await stream()
        expect(seen).toHaveLength(1)
        expect(fallbackCount(out)).toBe(0)
        expect(out.at(-1)?.type).toBe("error")
      })

      test(`${format}: validation errors never fall back`, async () => {
        const { seen, stream } = setup([
          failure(
            format,
            { code: "invalid_request_error", message: "Fast mode parameter is invalid", status: 400 },
            400,
          ),
        ])
        const out = await stream()
        expect(seen).toHaveLength(1)
        expect(fallbackCount(out)).toBe(0)
        expect(out.at(-1)).toMatchObject({ type: "error", retryable: false, error: { status: 400 } })
      })
    }

    test.each([400, 401, 403, 500, 503])("HTTP %s wins over a tier-specific code", async (status) => {
      const { seen, stream } = setup([
        failure(
          "http",
          { code: "priority_rate_limit_exceeded", message: "Priority rate limit exceeded" },
          status,
        ),
      ])
      const out = await stream()
      expect(seen).toHaveLength(1)
      expect(fallbackCount(out)).toBe(0)
      expect(out.at(-1)).toMatchObject({ type: "error", error: { status } })
    })

    test.each([400, 503])("SSE explicit status %s is not overwritten by a tier code", async (status) => {
      const { seen, stream } = setup([
        failure("sse", {
          code: "priority_rate_limit_exceeded",
          message: "Priority rate limit exceeded",
          status,
        }),
      ])
      const out = await stream()
      expect(seen).toHaveLength(1)
      expect(fallbackCount(out)).toBe(0)
      expect(out.at(-1)).toMatchObject({ type: "error", error: { status } })
    })

    test("HTTP JSON without a structured error cannot classify request metadata", async () => {
      const { seen, stream } = setup([
        () => Response.json({ service_tier: "priority", message: "Account RPM exceeded" }, { status: 429 }),
      ])
      const out = await stream()
      expect(seen).toHaveLength(1)
      expect(fallbackCount(out)).toBe(0)
      expect(out.at(-1)).toMatchObject({ type: "error", retryable: true, error: { status: 429 } })
    })

    if (dialect === "openai-responses") {
      for (const shape of ["error", "response.failed"]) {
        test(`SSE canonical ${shape} events normalize priority capacity codes`, async () => {
          const error = { code: "priority_capacity_exceeded", message: "Request cannot be served" }
          const body = shape === "error" ? { type: shape, ...error } : { type: shape, response: { error } }
          const { seen, stream } = setup([() => sseResponse([body], false), success])
          const out = await stream()
          expect(seen.map((s) => s.body.service_tier)).toEqual(["priority", "default"])
          expect(fallbackCount(out)).toBe(1)
          expect(out.at(-1)?.type).toBe("done")
        })
      }
    }

    test("SSE partial content prevents fallback and replay", async () => {
      const { seen, stream } = setup([
        failure(
          "sse",
          { code: "priority_capacity_exceeded", message: "Priority capacity exhausted" },
          529,
          true,
        ),
      ])
      const out = await stream()
      expect(seen).toHaveLength(1)
      expect(out).toContainEqual(expect.objectContaining({ type: "text.delta", text: "partial" }))
      expect(fallbackCount(out)).toBe(0)
      expect(out.at(-1)).toMatchObject({ type: "error", retryable: true, error: { status: 529 } })
    })

    test("SSE tier limits without fast mode retain ordinary retries", async () => {
      const { seen, stream } = setup(
        [
          failure("sse", { code: "priority_rate_limit_exceeded", message: "Request cannot be served" }),
          success,
        ],
        1,
        false,
      )
      const out = await stream()
      expect(seen.map((s) => s.body.service_tier)).toEqual([undefined, undefined])
      expect(fallbackCount(out)).toBe(0)
      expect(out.filter((ev) => ev.type === "retry")).toHaveLength(1)
      expect(out.at(-1)?.type).toBe("done")
    })
  })
}

for (const status of [429, 529]) {
  for (const tierSpecific of [true, false]) {
    test(`Anthropic HTTP ${status}: parsed provider message remains safe (${tierSpecific ? "fast" : "ordinary"})`, async () => {
      const seen: Seen[] = []
      const responses = [
        () =>
          Response.json(
            {
              type: "error",
              service_tier: "priority",
              error: {
                type: status === 429 ? "rate_limit_error" : "overloaded_error",
                message: tierSpecific ? "Fast mode capacity exhausted" : "Account capacity exhausted",
              },
            },
            { status },
          ),
        () =>
          Response.json({
            type: "message",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
          }),
      ]
      const ai = createAi({
        providers: [{ id: "test", dialect: "anthropic-messages", baseUrl: "https://api.anthropic.com" }],
        retry: { retries: 0 },
        fetch: (async (url, init) => {
          const attempt: Seen = {}
          seen.push(attempt)
          const response = responses.shift()
          if (!response) throw new Error("unexpected request")
          return fakeFetch(response, attempt)(url, init)
        }) as typeof fetch,
      })
      const out = await events(
        ai.stream({
          model: ai.model("test/claude-opus-5-5"),
          systemPrompt: "",
          messages: [],
          tools: [],
          fastMode: true,
        }),
      )
      expect(seen.map((s) => s.body.speed)).toEqual(tierSpecific ? ["fast", undefined] : ["fast"])
      expect(out.filter((ev) => ev.type === "fast.fallback")).toHaveLength(tierSpecific ? 1 : 0)
      expect(out.at(-1)?.type).toBe(tierSpecific ? "done" : "error")
      if (!tierSpecific)
        expect(out.at(-1)).toMatchObject({ error: { message: `HTTP ${status}: Account capacity exhausted` } })
    })
  }
}
