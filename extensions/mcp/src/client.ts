import {
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type Transport,
} from "./transport.ts"

export const PROTOCOL_VERSION = "2025-06-18"

export interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: { title?: string; readOnlyHint?: boolean; [k: string]: unknown }
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string; description?: string }
  | {
      type: "resource"
      resource: { uri: string; mimeType?: string; text?: string; blob?: string }
    }

export interface McpCallResult {
  content?: McpContent[]
  structuredContent?: unknown
  isError?: boolean
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
  }
}

export interface RequestOptions {
  timeoutMs: number
  signal?: AbortSignal
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

/** A JSON-RPC session with one MCP server over any transport. */
export class McpClient {
  readonly transport: Transport
  serverInfo: { name?: string; version?: string } | undefined
  instructions: string | undefined
  /** Set when the connection ends, with the reason. */
  closedReason: string | undefined

  #nextId = 1
  #pending = new Map<JsonRpcId, Pending>()
  #onToolsChanged: (() => void) | undefined
  #onClose: ((reason: string) => void) | undefined

  constructor(transport: Transport) {
    this.transport = transport
    transport.onmessage = (m) => this.#onMessage(m)
    transport.onclose = (reason) => this.#fail(reason)
  }

  onToolsChanged(handler: () => void): void {
    this.#onToolsChanged = handler
  }

  /** Called when the connection ends by itself (e.g. the server process died). */
  onClose(handler: (reason: string) => void): void {
    this.#onClose = handler
  }

  /** Starts the transport and performs the initialize handshake. */
  async connect(opts: RequestOptions): Promise<void> {
    await this.transport.start()
    const result = (await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "amira", version: "0.1.0" },
      },
      opts,
    )) as {
      protocolVersion?: string
      serverInfo?: { name?: string; version?: string }
      instructions?: string
    }
    this.transport.protocolVersion = result?.protocolVersion ?? PROTOCOL_VERSION
    this.serverInfo = result?.serverInfo
    this.instructions = result?.instructions
    await this.notify("notifications/initialized")
  }

  async listTools(opts: RequestOptions): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    do {
      const page = (await this.request("tools/list", cursor ? { cursor } : {}, opts)) as {
        tools?: McpTool[]
        nextCursor?: string
      }
      tools.push(...(page?.tools ?? []))
      cursor = page?.nextCursor || undefined
    } while (cursor)
    return tools
  }

  async callTool(name: string, args: Record<string, unknown>, opts: RequestOptions): Promise<McpCallResult> {
    return (await this.request("tools/call", { name, arguments: args }, opts)) as McpCallResult
  }

  /** Sends a request; on timeout or abort the server is told to cancel it. */
  request(method: string, params: unknown, opts: RequestOptions): Promise<unknown> {
    if (this.closedReason) return Promise.reject(new McpError(`connection closed: ${this.closedReason}`))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        clearTimeout(timer)
        opts.signal?.removeEventListener("abort", onAbort)
        this.#pending.delete(id)
      }
      const giveUp = (reason: string) => {
        if (!this.#pending.has(id)) return
        cleanup()
        this.transport.cancel?.(id)
        void this.notify("notifications/cancelled", { requestId: id, reason }).catch(() => {})
        reject(new McpError(reason))
      }
      const onAbort = () => giveUp("aborted")
      this.#pending.set(id, {
        resolve: (v) => {
          cleanup()
          resolve(v)
        },
        reject: (e) => {
          cleanup()
          reject(e)
        },
      })
      if (opts.signal?.aborted) return giveUp("aborted")
      opts.signal?.addEventListener("abort", onAbort, { once: true })
      timer = setTimeout(
        () => giveUp(`${method} timed out after ${formatMs(opts.timeoutMs)}`),
        opts.timeoutMs,
      )
      this.transport.send({ jsonrpc: "2.0", id, method, params }).catch((err) => {
        this.#pending.get(id)?.reject(new McpError(err instanceof Error ? err.message : String(err)))
      })
    })
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }
    await this.transport.send(msg)
  }

  async close(): Promise<void> {
    this.#fail("closed by the client", false)
    await this.transport.close()
  }

  #onMessage(m: JsonRpcMessage) {
    if (isResponse(m)) {
      const p = this.#pending.get(m.id)
      if (!p) return
      if (m.error) p.reject(new McpError(m.error.message || "unknown error", m.error.code))
      else p.resolve(m.result)
      return
    }
    if (isRequest(m)) {
      // We declare no client capabilities, so only ping is answered.
      const reply =
        m.method === "ping"
          ? { jsonrpc: "2.0" as const, id: m.id, result: {} }
          : {
              jsonrpc: "2.0" as const,
              id: m.id,
              error: { code: -32601, message: `method not found: ${m.method}` },
            }
      void this.transport.send(reply).catch(() => {})
      return
    }
    if (m.method === "notifications/tools/list_changed") this.#onToolsChanged?.()
  }

  #fail(reason: string, notify = true) {
    if (this.closedReason) return
    this.closedReason = reason
    for (const p of [...this.#pending.values()]) p.reject(new McpError(`connection closed: ${reason}`))
    if (notify) this.#onClose?.(reason)
  }
}

function formatMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`
}
