import { expect, test } from "bun:test"
import * as api from "@amira/api"
import "../src/index.ts"

// Core installs @amira/net as the API's network service: extensions get its guarded behaviour.

test("isPrivateAddress through the API is the host's guard", () => {
  expect(api.isPrivateAddress("127.0.0.1")).toBe(true)
  expect(api.isPrivateAddress("192.168.1.10")).toBe(true)
  expect(api.isPrivateAddress("::1")).toBe(true)
  expect(api.isPrivateAddress("8.8.8.8")).toBe(false)
  expect(api.isPrivateAddress("not an address")).toBe(true)
})

test("fetchPublic through the API refuses private addresses with the API's NetError", async () => {
  const refused = await api
    .fetchPublic("http://127.0.0.1/a.png", { maxBytes: 10, signal: new AbortController().signal })
    .catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(api.NetError)
  expect((refused as Error).message).toContain("private-network")
})

test("guardedFetch through the API checks every redirect", async () => {
  const fetch = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: "http://10.0.0.1/" },
    })) as unknown as typeof globalThis.fetch
  const refused = await api
    .guardedFetch(
      new URL("https://example.test/"),
      { fetch, resolve: async () => ["93.184.216.34"] },
      new AbortController().signal,
    )
    .catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(api.NetError)
  expect((refused as Error).message).toContain("10.0.0.1")
})
