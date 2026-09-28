import type { ToolContext, ToolResult } from "@amira/api"

export interface Call {
  /** The URL as the caller meant it: a request pinned to an IP is mapped back by its Host header. */
  url: string
  /** The URL actually requested. */
  wire: string
  init: RequestInit
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

/** A fetch stand-in that records calls and answers from `handler`. */
export function mockFetch(handler: Handler): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const wire = input instanceof Request ? input.url : String(input)
    const host = (init.headers as Record<string, string> | undefined)?.host
    let url = wire
    if (host) {
      const u = new URL(wire)
      u.host = host
      url = u.href
    }
    calls.push({ url, wire, init })
    init.signal?.throwIfAborted()
    return handler(url, init)
  }
  return { fetch: fn as unknown as typeof fetch, calls }
}

/** The headers a recorded call sent. */
export const headersOf = (call: Call | undefined) => (call?.init.headers ?? {}) as Record<string, string>

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export function ctx(signal = new AbortController().signal): ToolContext {
  return { cwd: "/", toolCallId: "t1", signal, update() {} }
}

export const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("")

/** Resolves every name to a public address unless listed. */
export const publicResolver =
  (overrides: Record<string, string[]> = {}) =>
  async (host: string) =>
    overrides[host] ?? ["93.184.215.14"]
