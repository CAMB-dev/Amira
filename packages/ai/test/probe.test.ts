import { describe, expect, test } from "bun:test"
import { createCatalog } from "../src/catalog.ts"
import { listModels, ProbeError, redact, testConnection } from "../src/probe.ts"
import { delta, sseResponse } from "./helpers.ts"

interface Call {
  url: string
  headers: Record<string, string>
  body?: any
}

/** A fetch answering by URL, recording each call. */
function routes(handler: (url: string, call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const f = (async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      ...(init.body ? { body: JSON.parse(init.body as string) } : {}),
    }
    calls.push(call)
    return handler(url, call)
  }) as unknown as typeof fetch
  return { fetch: f, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const KEY = "sk-test-0123456789abcdef"

describe("listModels", () => {
  test("OpenAI-compatible: GET {baseUrl}/models with a bearer key; limits when listed", async () => {
    const { fetch, calls } = routes(() =>
      json({
        data: [
          { id: "deepseek-chat", object: "model" },
          {
            id: "or/model",
            name: "Some Model",
            context_length: 200000,
            top_provider: { max_completion_tokens: 8000 },
          },
          { id: "deepseek-chat" },
          { nope: 1 },
        ],
      }),
    )
    const models = await listModels(
      { dialect: "openai-chat", baseUrl: "https://api.deepseek.com/", apiKey: KEY },
      { fetch },
    )
    expect(models).toEqual([
      { id: "deepseek-chat" },
      { id: "or/model", name: "Some Model", contextWindow: 200000, maxOutput: 8000 },
    ])
    expect(calls[0]!.url).toBe("https://api.deepseek.com/models")
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
  })

  test("Anthropic: /v1/models with its headers, following pages", async () => {
    const { fetch, calls } = routes((url) =>
      url.includes("after_id")
        ? json({ data: [{ id: "claude-b" }], has_more: false })
        : json({ data: [{ id: "claude-a", display_name: "Claude A" }], has_more: true, last_id: "claude-a" }),
    )
    const models = await listModels(
      { dialect: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic", apiKey: KEY },
      { fetch },
    )
    expect(models).toEqual([{ id: "claude-a", name: "Claude A" }, { id: "claude-b" }])
    expect(calls[0]!.url).toBe("https://api.deepseek.com/anthropic/v1/models?limit=1000")
    expect(calls[1]!.url).toContain("after_id=claude-a")
    expect(calls[0]!.headers["x-api-key"]).toBe(KEY)
    expect(calls[0]!.headers["anthropic-version"]).toBeDefined()
    // A base URL that ends in /v1 is not doubled.
    const again = routes(() => json({ data: [] }))
    await listModels({ dialect: "anthropic-messages", baseUrl: "https://x/v1" }, { fetch: again.fetch })
    expect(again.calls[0]!.url).toBe("https://x/v1/models?limit=1000")
  })

  test("Gemini: only models that generate content, with their limits, the key in a header", async () => {
    const { fetch, calls } = routes((url) =>
      url.includes("pageToken")
        ? json({ models: [{ name: "models/gemini-lite", supportedGenerationMethods: ["generateContent"] }] })
        : json({
            models: [
              {
                name: "models/gemini-pro",
                displayName: "Gemini Pro",
                inputTokenLimit: 1048576,
                outputTokenLimit: 65536,
                supportedGenerationMethods: ["generateContent", "countTokens"],
              },
              { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
            ],
            nextPageToken: "p2",
          }),
    )
    const models = await listModels(
      { dialect: "google-gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: KEY },
      { fetch },
    )
    expect(models).toEqual([
      { id: "gemini-pro", name: "Gemini Pro", contextWindow: 1048576, maxOutput: 65536 },
      { id: "gemini-lite" },
    ])
    expect(calls[0]!.headers["x-goog-api-key"]).toBe(KEY)
    expect(calls.every((c) => !c.url.includes(KEY))).toBe(true)
  })

  test("errors say what went wrong and never carry the key", async () => {
    const echo = routes(() => json({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401))
    const err = await listModels(
      { dialect: "openai-chat", baseUrl: "https://h.example", apiKey: KEY },
      { fetch: echo.fetch },
    ).catch((e) => e)
    expect(err).toBeInstanceOf(ProbeError)
    expect(err.kind).toBe("auth")
    expect(err.message).toContain("rejected by h.example (HTTP 401)")
    expect(err.message).not.toContain("0123456789")

    const missing = routes(() => new Response("not here", { status: 404 }))
    const e404 = await listModels(
      { dialect: "openai-chat", baseUrl: "https://h.example/wrong" },
      { fetch: missing.fetch },
    ).catch((e) => e)
    expect(e404.kind).toBe("not_found")
    expect(e404.message).toContain("is the base URL right?")

    const down = routes(() => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:1")))
    const eNet = await listModels(
      { dialect: "openai-chat", baseUrl: "http://localhost:1/v1" },
      { fetch: down.fetch },
    ).catch((e) => e)
    expect(eNet.kind).toBe("network")
    expect(eNet.message).toBe("cannot reach localhost:1: connect ECONNREFUSED 127.0.0.1:1")

    const html = routes(() => new Response("<html>", { status: 200 }))
    expect(
      (
        await listModels({ dialect: "openai-chat", baseUrl: "https://h" }, { fetch: html.fetch }).catch(
          (e) => e,
        )
      ).kind,
    ).toBe("format")
    const other = await listModels({ dialect: "mock", baseUrl: "x" }).catch((e) => e)
    expect(other.kind).toBe("unsupported")
  })

  test("a server that never answers times out", async () => {
    const hang = routes(
      (_url, _call) =>
        new Promise<Response>(() => {
          // Never settles; the abort signal ends it.
        }),
    )
    // The route ignores the signal, so give fetch one that honours it.
    const f = ((url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason))
        void hang.fetch(url, init)
      })) as unknown as typeof fetch
    const e = await listModels(
      { dialect: "openai-chat", baseUrl: "https://slow.example" },
      { fetch: f, timeoutMs: 30 },
    ).catch((x) => x)
    expect(e.kind).toBe("timeout")
    expect(e.message).toContain("no answer from slow.example")
  })
})

describe("testConnection", () => {
  const ep = { dialect: "openai-chat", baseUrl: "https://api.deepseek.com", apiKey: KEY }

  test("OK with the latency; the request is tiny", async () => {
    const { fetch, calls } = routes(() =>
      sseResponse([
        delta({ content: "OK" }),
        { ...delta({}, "stop"), usage: { prompt_tokens: 3, completion_tokens: 1 } },
      ]),
    )
    const r = await testConnection(ep, "deepseek-chat", { fetch })
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/^OK: deepseek-chat answered in \d+ ms$/)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://api.deepseek.com/chat/completions")
    expect(calls[0]!.body.max_tokens).toBe(16)
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
  })

  test("401, 404, network errors and timeouts read clearly", async () => {
    const bad = await testConnection(ep, "deepseek-chat", {
      fetch: routes(() => json({ error: { message: `Authentication Fails, key ${KEY}` } }, 401)).fetch,
    })
    expect(bad).toMatchObject({ ok: false, failure: "auth", status: 401 })
    expect(bad.message).toContain("the API key was rejected by api.deepseek.com (HTTP 401)")
    expect(bad.message).not.toContain(KEY)

    const missing = await testConnection(ep, "nope", {
      fetch: routes(() => json({ error: { message: "x" } }, 404)).fetch,
    })
    expect(missing.message).toBe('HTTP 404 from api.deepseek.com: wrong base URL, or no model "nope" there')

    const down = await testConnection({ ...ep, baseUrl: "https://down.example/v1" }, "m", {
      fetch: routes(() => Promise.reject(new Error("getaddrinfo ENOTFOUND down.example"))).fetch,
    })
    expect(down).toMatchObject({ ok: false, failure: "network" })
    expect(down.message).toBe("cannot reach down.example: getaddrinfo ENOTFOUND down.example")

    const slow = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      )) as unknown as typeof fetch
    const late = await testConnection(ep, "m", { fetch: slow, timeoutMs: 30 })
    expect(late).toMatchObject({ ok: false, failure: "timeout" })
    expect(late.message).toContain("no answer from api.deepseek.com within")
  })
})

test("redact hides the key and the parts error bodies echo", () => {
  expect(redact(`bad key ${KEY}`, KEY)).toBe("bad key ***")
  expect(redact("key sk-test-...abcdef was wrong", KEY)).toBe("key ***...*** was wrong")
  expect(redact("nothing", undefined)).toBe("nothing")
})

test("the catalog lists its providers", () => {
  const c = createCatalog({ deepseek: { models: { "deepseek-chat": {} } }, junk: 1 })
  expect(c.providers?.()).toEqual(["deepseek"])
})
