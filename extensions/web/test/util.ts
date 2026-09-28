import type { ToolContext, ToolResult } from "@amira/api"

export interface Call {
  url: string
  init: RequestInit
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

/** A fetch stand-in that records calls and answers from `handler`. */
export function mockFetch(handler: Handler): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ url, init })
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
