import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { listModels, testConnection } from "../src/probe.ts"
import { events, fakeFetch, request, type Seen, sseResponse } from "./helpers.ts"

test("request headers expand the live injected environment without changing provider configs", async () => {
  const env: Record<string, string | undefined> = { TOKEN: "first-secret", EMPTY: "" }
  const headers = {
    Authorization: `Bearer \${TOKEN}`,
    "X-Defaults": `\${UNSET:-fallback}/\${EMPTY:-empty}/\${UNSET}/\${EMPTY}`,
    "X-Literal": "plain value",
    "X-Multiple": `\${TOKEN}/\${TOKEN:-unused}`,
  }
  const original = structuredClone(headers)
  const provider = { id: "test", dialect: "openai-chat", baseUrl: "http://test/v1", headers }
  const seen: Seen = {}
  const ai = createAi({ env, providers: [provider], fetch: fakeFetch(() => sseResponse([]), seen) })
  const send = async (token: string) => {
    expect((await events(ai.stream(request(ai)))).at(-1)?.type).toBe("done")
    const expected = {
      Authorization: `Bearer ${token}`,
      "X-Defaults": "fallback/empty//",
      "X-Literal": "plain value",
      "X-Multiple": `${token}/${token}`,
    }
    expect(ai.providerEndpoint("test").headers).toEqual(expected)
    for (const [name, value] of Object.entries(expected)) {
      expect(new Headers(seen.headers).get(name)).toBe(value)
    }
    expect(JSON.stringify(seen.headers)).not.toContain("${")
    expect(provider.headers).toEqual(original)
    expect(ai.providers()[0]?.headers).toEqual(original)
    expect(JSON.stringify(ai.providers())).not.toContain(token)
  }
  await send("first-secret")
  env.TOKEN = "rotated-secret"
  await send("rotated-secret")
  delete env.TOKEN
  expect((await events(ai.stream(request(ai)))).at(-1)?.type).toBe("done")
  expect(new Headers(seen.headers).get("authorization")).toBe("Bearer")
  expect(ai.providerEndpoint("test").headers?.Authorization).toBe("Bearer ")
  expect(headers).toEqual(original)
})

test("an injected environment never falls back to process.env for headers", async () => {
  const variable = process.env.PATH ? "PATH" : "Path"
  expect(process.env[variable]).toBeTruthy()
  const seen: Seen = {}
  const ai = createAi({
    env: {},
    providers: [
      {
        id: "test",
        dialect: "openai-chat",
        baseUrl: "http://test/v1",
        headers: { "X-Isolated": `\${${variable}:-isolated}`, "X-Missing": `\${${variable}}` },
      },
    ],
    fetch: fakeFetch(() => sseResponse([]), seen),
  })
  expect((await events(ai.stream(request(ai)))).at(-1)?.type).toBe("done")
  expect(new Headers(seen.headers).get("x-isolated")).toBe("isolated")
  expect(new Headers(seen.headers).get("x-missing")).toBe("")
})

test("provider endpoints stay single-pass when resolved header values are handed to probes", async () => {
  const headers = { Authorization: `Bearer \${TOKEN}` }
  const env = { TOKEN: `secret-\${NESTED:-literal}`, NESTED: "must-not-expand" }
  const ai = createAi({
    env,
    providers: [{ id: "test", dialect: "openai-chat", baseUrl: "http://test/v1", headers }],
  })
  const endpoint = ai.providerEndpoint("test")
  const expected = `Bearer ${env.TOKEN}`
  expect(endpoint.headers).toEqual({ Authorization: expected })
  const seen: Seen = {}
  const fetchImpl = fakeFetch(() => sseResponse([]), seen)
  expect((await testConnection(endpoint, "m", { fetch: fetchImpl })).ok).toBe(true)
  expect(new Headers(seen.headers).get("authorization")).toBe(expected)
  const listFetch = (async (_url: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(expected)
    return Response.json({ data: [{ id: "m" }] })
  }) as typeof fetch
  expect(await listModels(endpoint, { fetch: listFetch })).toEqual([{ id: "m" }])
  expect(ai.providers()[0]?.headers).toEqual(headers)
})
