import { expect, test } from "bun:test"
import { fetchPublic } from "../src/index.ts"

const publicDns = async (host: string) => (host === "intranet.test" ? ["192.168.1.20"] : ["93.184.215.14"])

function net(handler: (url: string) => Response) {
  const calls: string[] = []
  const fetch = (async (input: string | URL | Request) => {
    calls.push(String(input))
    return handler(String(input))
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

test("private and local addresses are refused before anything is requested, redirects too", async () => {
  const n = net((url) =>
    url.includes("93.184")
      ? new Response(null, { status: 302, headers: { location: "http://10.0.0.1/x.png" } })
      : new Response("inside"),
  )
  const get = (url: string) =>
    fetchPublic(url, {
      maxBytes: 1000,
      signal: new AbortController().signal,
      fetch: n.fetch,
      resolve: publicDns,
    })
  for (const u of [
    "http://127.0.0.1/a.png",
    "http://localhost:8080/a.png",
    "http://[::1]/a.png",
    "http://169.254.169.254/latest/meta-data",
    "http://intranet.test/a.png",
  ])
    await expect(get(u)).rejects.toThrow("private-network")
  expect(n.calls).toEqual([])
  await expect(get("https://cdn.test/a.png")).rejects.toThrow("private-network")
  expect(n.calls).toEqual(["https://93.184.215.14/a.png"])
})

test("only the types asked for, a 2xx answer, within the size limit, no credentials", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])
  const n = net((url) => {
    if (url.endsWith("/page")) return new Response("<html>", { headers: { "content-type": "text/html" } })
    if (url.endsWith("/huge.png"))
      return new Response(new Uint8Array(5000), { headers: { "content-type": "image/png" } })
    if (url.endsWith("/missing.png")) return new Response("no", { status: 404 })
    return new Response(png, { headers: { "content-type": "image/png" } })
  })
  const get = (url: string) =>
    fetchPublic(url, {
      maxBytes: 1000,
      signal: new AbortController().signal,
      types: /^image\//,
      headers: { accept: "image/png" },
      fetch: n.fetch,
      resolve: publicDns,
    })
  expect(await get("https://cdn.test/a.png")).toEqual({
    bytes: png,
    contentType: "image/png",
    url: "https://cdn.test/a.png",
  })
  await expect(get("https://cdn.test/page")).rejects.toThrow("not an accepted type (text/html)")
  await expect(get("https://cdn.test/huge.png")).rejects.toThrow("too large")
  await expect(get("https://cdn.test/missing.png")).rejects.toThrow("HTTP 404")
  await expect(get("https://u:p@cdn.test/a.png")).rejects.toThrow("credentials")
  await expect(get("file:///etc/passwd")).rejects.toThrow("only http and https")
})
