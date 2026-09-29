import { expect, test } from "bun:test"
import { guardedFetch, NetError, parseHttpUrl } from "../src/index.ts"

const resolve = async (host: string) => (host === "inside.test" ? ["10.0.0.7"] : ["93.184.215.14"])

function recorder(handler: (url: string) => Response) {
  const calls: { url: string; host?: string }[] = []
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    const host = (init.headers as Record<string, string> | undefined)?.host
    calls.push(host ? { url, host } : { url })
    return handler(url)
  }
  return { fetch: fn as unknown as typeof fetch, calls }
}

test("connects to the checked address, keeping the name in Host", async () => {
  const net = recorder(() => new Response("ok"))
  const got = await guardedFetch(
    parseHttpUrl("https://example.test/a.png"),
    { fetch: net.fetch, resolve },
    new AbortController().signal,
  )
  expect(await got.response.text()).toBe("ok")
  expect(net.calls).toEqual([{ url: "https://93.184.215.14/a.png", host: "example.test" }])
})

test("private addresses are refused, directly and after a redirect", async () => {
  const net = recorder((url) =>
    url.includes("93.184")
      ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } })
      : new Response("secret"),
  )
  const signal = new AbortController().signal
  for (const u of ["http://localhost/x", "http://169.254.169.254/latest", "http://inside.test/"]) {
    const err = await guardedFetch(parseHttpUrl(u), { fetch: net.fetch, resolve }, signal).catch((e) => e)
    expect(err).toBeInstanceOf(NetError)
    expect(err.message).toContain("private-network")
  }
  const hint = await guardedFetch(
    parseHttpUrl("http://public.test/"),
    { fetch: net.fetch, resolve, privateHint: "try elsewhere" },
    signal,
  ).catch((e) => e)
  expect(hint.message).toBe(
    "refusing to fetch 127.0.0.1: it is a local or private-network address (try elsewhere)",
  )
  // Only the public hop was requested.
  expect(net.calls.map((c) => c.url)).toEqual(["http://93.184.215.14/"])
})

test("only plain http(s) URLs", () => {
  expect(() => parseHttpUrl("file:///etc/passwd")).toThrow("only http and https")
  expect(() => parseHttpUrl("https://u:p@x.test/")).toThrow("credentials")
})
