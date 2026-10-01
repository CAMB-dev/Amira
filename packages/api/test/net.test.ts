import { expect, test } from "bun:test"
import * as api from "../src/index.ts"

class HostNetError extends Error {}

api.installHostNet({
  fetchPublic: async (url) => {
    if (url.includes("127.0.0.1")) throw new HostNetError(`${url}: private-network`)
    return { bytes: new Uint8Array(), contentType: "", url }
  },
  guardedFetch: async () => ({ response: new Response(), url: new URL("http://example.test/") }),
  isPrivateAddress: (ip) => ip !== "8.8.8.8",
  parseHttpUrl: (raw) => new URL(raw),
  readCapped: async () => ({ bytes: new Uint8Array(), truncated: false }),
  isNetError: (error) => error instanceof HostNetError,
})

test("isPrivateAddress is part of the public API", () => {
  expect(api.isPrivateAddress("127.0.0.1")).toBe(true)
  expect(api.isPrivateAddress("192.168.1.10")).toBe(true)
  expect(api.isPrivateAddress("::1")).toBe(true)
  expect(api.isPrivateAddress("8.8.8.8")).toBe(false)
  expect(api.isPrivateAddress("not an address")).toBe(true)
})

test("fetchPublic is part of the public API, with web_fetch's protection", async () => {
  expect(typeof api.fetchPublic).toBe("function")
  await expect(
    api.fetchPublic("http://127.0.0.1/a.png", { maxBytes: 10, signal: new AbortController().signal }),
  ).rejects.toThrow("private-network")
})
