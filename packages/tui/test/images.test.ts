import { expect, test } from "bun:test"
import { remoteImageFetch } from "../src/images.ts"

const publicDns = async (host: string) => (host === "intranet.test" ? ["192.168.1.20"] : ["93.184.215.14"])

function net(handler: (url: string) => Response) {
  const calls: string[] = []
  const fetch = (async (input: string | URL | Request) => {
    calls.push(String(input))
    return handler(String(input))
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const opts = (maxBytes = 1000) => ({ maxBytes, signal: new AbortController().signal })

test("private and local addresses are refused before anything is requested, redirects too", async () => {
  const n = net((url) =>
    url.includes("93.184")
      ? new Response(null, { status: 302, headers: { location: "http://10.0.0.1/x.png" } })
      : new Response("inside"),
  )
  const get = remoteImageFetch({ fetch: n.fetch, resolve: publicDns })
  for (const u of [
    "http://127.0.0.1/a.png",
    "http://localhost:8080/a.png",
    "http://[::1]/a.png",
    "http://169.254.169.254/latest/meta-data",
    "http://intranet.test/a.png",
  ])
    await expect(get(new URL(u), opts())).rejects.toThrow("private-network")
  expect(n.calls).toEqual([])
  await expect(get(new URL("https://cdn.test/a.png"), opts())).rejects.toThrow("private-network")
  expect(n.calls).toEqual(["https://93.184.215.14/a.png"])
})

test("only image types, within the size limit", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])
  const n = net((url) => {
    if (url.endsWith("/page")) return new Response("<html>", { headers: { "content-type": "text/html" } })
    if (url.endsWith("/huge.png"))
      return new Response(new Uint8Array(5000), { headers: { "content-type": "image/png" } })
    if (url.endsWith("/missing.png")) return new Response("no", { status: 404 })
    return new Response(png, { headers: { "content-type": "image/png" } })
  })
  const get = remoteImageFetch({ fetch: n.fetch, resolve: publicDns })
  expect(await get(new URL("https://cdn.test/a.png"), opts())).toEqual({
    bytes: png,
    contentType: "image/png",
  })
  await expect(get(new URL("https://cdn.test/page"), opts())).rejects.toThrow("not an image (text/html)")
  await expect(get(new URL("https://cdn.test/huge.png"), opts())).rejects.toThrow("too large")
  await expect(get(new URL("https://cdn.test/missing.png"), opts())).rejects.toThrow("HTTP 404")
  await expect(get(new URL("https://u:p@cdn.test/a.png"), opts())).rejects.toThrow("credentials")
})
