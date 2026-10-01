import { expect, test } from "bun:test"

// A private copy of the module, so installing a stand-in host here cannot replace the real one
// that core installs for other test files sharing this process.
const isolated = "../src/net.ts?net-test"
const net = (await import(isolated)) as typeof import("../src/net.ts")

class HostNetError extends Error {}

const signal = new AbortController().signal

test("the network helpers fail clearly before the host installs them", async () => {
  expect(() => net.isPrivateAddress("127.0.0.1")).toThrow("host network service has not been installed")
  expect(() => net.parseHttpUrl("https://example.test/")).toThrow("has not been installed")
  await expect(net.fetchPublic("https://example.test/", { maxBytes: 10, signal })).rejects.toThrow(
    "has not been installed",
  )
  await expect(net.guardedFetch(new URL("https://example.test/"), {}, signal)).rejects.toThrow(
    "has not been installed",
  )
  await expect(net.readCapped(new Response("x"), 10)).rejects.toThrow("has not been installed")
})

test("the helpers call the installed host and keep its refusals as the API's NetError", async () => {
  net.installHostNet({
    fetchPublic: async (url) => {
      if (url.includes("127.0.0.1")) throw new HostNetError(`${url}: private-network`)
      if (url.includes("boom")) throw new TypeError("boom")
      return { bytes: new Uint8Array([1]), contentType: "image/png", url }
    },
    guardedFetch: async (start) => ({ response: new Response("ok"), url: start }),
    isPrivateAddress: (ip) => ip !== "8.8.8.8",
    parseHttpUrl: (raw) => {
      if (!raw.startsWith("http")) throw new HostNetError("not an http URL")
      return new URL(raw)
    },
    readCapped: async () => ({ bytes: new Uint8Array(), truncated: true }),
    isNetError: (error) => error instanceof HostNetError,
  })

  expect(net.isPrivateAddress("127.0.0.1")).toBe(true)
  expect(net.isPrivateAddress("8.8.8.8")).toBe(false)
  expect((await net.fetchPublic("https://a.test/x.png", { maxBytes: 10, signal })).contentType).toBe(
    "image/png",
  )
  expect((await net.guardedFetch(new URL("https://a.test/"), {}, signal)).url.href).toBe("https://a.test/")
  expect((await net.readCapped(new Response("x"), 1)).truncated).toBe(true)

  const refused = await net
    .fetchPublic("http://127.0.0.1/a.png", { maxBytes: 10, signal })
    .catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(net.NetError)
  expect((refused as Error).message).toBe("http://127.0.0.1/a.png: private-network")
  expect((refused as Error).cause).toBeInstanceOf(HostNetError)
  expect(() => net.parseHttpUrl("ftp://x")).toThrow(net.NetError)

  // Anything else is passed through as it is.
  await expect(net.fetchPublic("https://boom.test/", { maxBytes: 10, signal })).rejects.toBeInstanceOf(
    TypeError,
  )
})
