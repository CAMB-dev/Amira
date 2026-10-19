import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import type { Dialect } from "../src/dialect.ts"
import { withAiRequestBoundary } from "../src/local.ts"
import type { ModelRequest, StreamEvent } from "../src/types.ts"
import { events, sseResponse } from "./helpers.ts"

const origin = "https://approved.invalid"
function request(ai: ReturnType<typeof createAi>, id = "m"): ModelRequest {
  return { model: ai.model(`p/${id}`), messages: [], tools: [], systemPrompt: "" }
}

function streamingAi(fetcher: typeof fetch, dialect?: Dialect) {
  return createAi({
    providers: [{ id: "p", dialect: dialect?.id ?? "openai-chat", baseUrl: origin, apiKey: "synthetic" }],
    ...(dialect ? { dialects: [dialect] } : {}),
    fetch: fetcher,
    env: {},
    retry: { retries: 1, baseDelayMs: 0 },
  })
}

test("allowed retries preserve the injected wrapper and model overrides; ordinary calls remain unscoped", async () => {
  const redirects: RequestInit["redirect"][] = []
  const bodies: unknown[] = []
  const ai = streamingAi(
    Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        redirects.push(init?.redirect)
        bodies.push(JSON.parse(String(init?.body)))
        return redirects.length === 1
          ? new Response("transient", { status: 503 })
          : sseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])
      },
      { preconnect() {} },
    ),
  )
  let opened = 0
  const injected = {
    ...ai,
    stream: (...args: Parameters<typeof ai.stream>) => {
      opened++
      return ai.stream(...args)
    },
  }
  const req = request(ai)
  req.maxTokens = 37
  req.model = { ...req.model, id: "override", maxOutput: 41 }
  const scoped = withAiRequestBoundary(injected, { origin })
  expect((await events(scoped.stream(req))).at(-1)?.type).toBe("done")
  expect(opened).toBe(1)
  expect(redirects).toEqual(["error", "error"])
  expect(bodies).toEqual([
    expect.objectContaining({ model: "override", max_tokens: 37 }),
    expect.objectContaining({ model: "override", max_tokens: 37 }),
  ])
  await events(ai.stream(req))
  expect(redirects.at(-1)).toBeUndefined()
})

for (const method of ["next", "return", "throw"] as const) {
  test(`a lazy injected stream remains scoped during iterator.${method}`, async () => {
    const seen: string[] = []
    let attempts = 0
    const ai = streamingAi(
      Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          seen.push(String(input))
          return new Response("")
        },
        { preconnect() {} },
      ),
      {
        id: "scope",
        async *stream(_req, ctx) {
          attempts++
          await ctx.fetch("https://unapproved.invalid/collect")
          yield { type: "start" }
        },
      },
    )
    const injected = {
      ...ai,
      async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
        try {
          if (method !== "next") yield { type: "start" }
        } finally {
          // createAi is invoked lazily, after construction, and possibly only during cleanup.
          yield* ai.stream(req)
        }
      },
    }
    const iterator = withAiRequestBoundary(injected, { origin }).stream(request(ai))[Symbol.asyncIterator]()
    if (method !== "next") await iterator.next()
    try {
      await iterator[method]!(undefined)
      while (!(await iterator.next()).done) {}
    } catch {}
    expect(attempts).toBe(1)
    expect(seen).toEqual([])
  })
}

test("parallel operation policies do not bleed into each other", async () => {
  const seen: string[] = []
  const ai = streamingAi(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seen.push(String(input))
        expect(init?.redirect).toBe("error")
        return new Response("")
      },
      { preconnect() {} },
    ),
    {
      id: "parallel",
      async *stream(req, ctx) {
        yield { type: "start" }
        await Promise.resolve()
        await ctx.fetch(`${req.model.id}/request`)
      },
    },
  )
  const other = "https://other-approved.invalid"
  await Promise.all(
    [origin, other].map((approved) =>
      events(withAiRequestBoundary(ai, { origin: approved }).stream(request(ai, approved))),
    ),
  )
  expect(seen.sort()).toEqual([`${origin}/request`, `${other}/request`].sort())
})

test("Request inputs cannot override redirect rejection, and redirect responses are rejected", async () => {
  let called = 0
  let redirect: RequestInit["redirect"]
  const ai = streamingAi(
    Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        called++
        redirect = init?.redirect
        return new Response("redirect", { status: 307, headers: { location: "https://unapproved.invalid" } })
      },
      { preconnect() {} },
    ),
    {
      id: "request",
      async *stream(_req, ctx) {
        await ctx.fetch(new Request(`${origin}/request`, { redirect: "follow" }), { redirect: "follow" })
        yield { type: "text.delta", text: "must not be reached" }
      },
    },
  )
  await expect(events(withAiRequestBoundary(ai, { origin }).stream(request(ai)))).rejects.toThrow(
    "approved HTTP boundary",
  )
  expect(called).toBe(1)
  expect(redirect).toBe("error")
})

for (const invalid of ["", "file:///tmp", `${origin}/path`, `${origin}?key=secret`]) {
  test(`invalid or missing HTTP approval is rejected before dispatch: ${invalid}`, () => {
    const ai = createAi({ env: {} })
    expect(() => withAiRequestBoundary(ai, { origin: invalid })).toThrow()
  })
}
