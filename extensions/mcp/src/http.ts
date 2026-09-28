import { isRequest, type JsonRpcId, type JsonRpcMessage, type Transport } from "./transport.ts"

/**
 * MCP's streamable HTTP transport: every message is POSTed; replies come back as JSON or as
 * an SSE stream. The optional GET stream for unsolicited server messages is not opened.
 */
export class HttpTransport implements Transport {
  onmessage?: (message: JsonRpcMessage) => void
  onclose?: (reason: string) => void
  protocolVersion?: string

  #url: string
  #headers: Record<string, string>
  #sessionId: string | undefined
  #closed = new AbortController()
  #requests = new Map<JsonRpcId, AbortController>()

  constructor(url: string, headers: Record<string, string> = {}) {
    this.#url = url
    this.#headers = headers
  }

  async start(): Promise<void> {}

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.#closed.signal.aborted) throw new Error("the server connection is closed")
    const request = isRequest(message) ? message : undefined
    const abort = new AbortController()
    if (request) this.#requests.set(request.id, abort)
    const signal = AbortSignal.any([abort.signal, this.#closed.signal])
    try {
      const res = await fetch(this.#url, {
        method: "POST",
        headers: this.#requestHeaders(),
        body: JSON.stringify(message),
        signal,
      })
      const sid = res.headers.get("mcp-session-id")
      if (sid) this.#sessionId = sid
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).trim().slice(0, 500)
        const error = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${body ? `: ${body}` : ""}`
        if (request) this.#reply(request.id, error)
        else throw new Error(error)
        return
      }
      if (!request || res.status === 202 || res.status === 204) {
        await res.body?.cancel().catch(() => {})
        return
      }
      const type = res.headers.get("content-type") ?? ""
      if (type.includes("text/event-stream")) {
        // Read the stream in the background: send() only covers delivering the request.
        void this.#readEvents(res, request.id).finally(() => this.#requests.delete(request.id))
        return
      }
      const body = (await res.json()) as JsonRpcMessage | JsonRpcMessage[]
      this.#requests.delete(request.id)
      for (const m of Array.isArray(body) ? body : [body]) this.onmessage?.(m)
    } catch (err) {
      if (request) this.#requests.delete(request.id)
      if (signal.aborted) return
      if (!request) throw err
      this.#reply(request.id, err instanceof Error ? err.message : String(err))
    }
  }

  cancel(id: JsonRpcId): void {
    this.#requests.get(id)?.abort()
    this.#requests.delete(id)
  }

  async close(): Promise<void> {
    if (this.#closed.signal.aborted) return
    this.#closed.abort()
    if (!this.#sessionId) return
    // Ends the server-side session; best effort.
    await fetch(this.#url, {
      method: "DELETE",
      headers: this.#requestHeaders(),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {})
  }

  #requestHeaders(): Record<string, string> {
    return {
      ...this.#headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.#sessionId ? { "mcp-session-id": this.#sessionId } : {}),
      ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
    }
  }

  /** A failed POST becomes an error response, so the waiting request fails with the reason. */
  #reply(id: JsonRpcId, message: string) {
    this.onmessage?.({ jsonrpc: "2.0", id, error: { code: -32000, message } })
  }

  async #readEvents(res: Response, id: JsonRpcId) {
    let answered = false
    try {
      for await (const data of sseData(res.body!)) {
        let msg: JsonRpcMessage
        try {
          msg = JSON.parse(data)
        } catch {
          continue
        }
        if ("id" in msg && msg.id === id && !("method" in msg)) answered = true
        this.onmessage?.(msg)
      }
    } catch {}
    if (!answered && !this.#closed.signal.aborted && this.#requests.has(id)) {
      this.#reply(id, "the server closed the response stream without answering")
    }
  }
}

/** Yields the data of each event in a text/event-stream body. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  let data: string[] = []
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let nl = buffer.indexOf("\n")
    while (nl >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "")
      buffer = buffer.slice(nl + 1)
      if (line === "") {
        if (data.length) yield data.join("\n")
        data = []
      } else if (line.startsWith("data:")) {
        data.push(line.slice(line.startsWith("data: ") ? 6 : 5))
      }
      nl = buffer.indexOf("\n")
    }
  }
  if (data.length) yield data.join("\n")
}
