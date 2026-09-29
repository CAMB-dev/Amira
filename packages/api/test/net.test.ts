import { expect, test } from "bun:test"
import * as api from "../src/index.ts"

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
