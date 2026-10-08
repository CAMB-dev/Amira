import { expect, test } from "bun:test"

test("the public net exports stay stable", async () => {
  expect(Object.keys(await import("../src/index.ts")).sort()).toEqual([
    "NetError",
    "USER_AGENT",
    "assertPublicHost",
    "dnsResolver",
    "fetchPublic",
    "guardedFetch",
    "isPrivateAddress",
    "parseHttpUrl",
    "readCapped",
    "setUserAgentVersion",
  ])
})
