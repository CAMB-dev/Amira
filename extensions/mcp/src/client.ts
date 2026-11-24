import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  McpError as SdkMcpError,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { StdioTransport } from "./stdio.ts"

export const PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION

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

/** A JSON-RPC session with one MCP server, backed by the official `@modelcontextprotocol/sdk`. */
export class McpClient {
  readonly transport: Transport
  serverInfo: { name?: string; version?: string } | undefined
  instructions: string | undefined
  /** Set when the connection ends, with the reason. */
  closedReason: string | undefined

  #sdk: Client
  #connected = false
  #closing = false
  #onToolsChanged: (() => void) | undefined
  #onClose: ((reason: string) => void) | undefined

  constructor(transport: Transport) {
    this.transport = transport
    this.#sdk = new Client({ name: "amira", version: "0.1.0" }, { capabilities: {} })
    this.#sdk.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.#onToolsChanged?.()
    })
    this.#sdk.onclose = () => {
      if (this.#closing) return
      const reason =
        this.transport instanceof StdioTransport && this.transport.closeReason
          ? this.transport.closeReason
          : "transport closed"
      this.#markClosed(reason, this.#connected)
    }
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
    if (this.closedReason) throw new McpError(`connection closed: ${this.closedReason}`)
    try {
      await this.#sdk.connect(this.transport, { timeout: opts.timeoutMs, signal: opts.signal })
      this.#connected = true
      this.serverInfo = this.#sdk.getServerVersion()
      this.instructions = this.#sdk.getInstructions()
    } catch (err) {
      throw this.#wrapError("initialize", err, opts)
    }
  }

  async listTools(opts: RequestOptions): Promise<McpTool[]> {
    if (this.closedReason) throw new McpError(`connection closed: ${this.closedReason}`)
    const tools: McpTool[] = []
    let cursor: string | undefined
    try {
      do {
        const page = await this.#sdk.listTools(cursor ? { cursor } : undefined, {
          timeout: opts.timeoutMs,
          signal: opts.signal,
        })
        tools.push(...((page.tools ?? []) as McpTool[]))
        cursor = page.nextCursor || undefined
      } while (cursor)
      return tools
    } catch (err) {
      throw this.#wrapError("tools/list", err, opts)
    }
  }

  async callTool(name: string, args: Record<string, unknown>, opts: RequestOptions): Promise<McpCallResult> {
    if (this.closedReason) throw new McpError(`connection closed: ${this.closedReason}`)
    try {
      return (await this.#sdk.callTool({ name, arguments: args }, undefined, {
        timeout: opts.timeoutMs,
        signal: opts.signal,
      })) as McpCallResult
    } catch (err) {
      throw this.#wrapError("tools/call", err, opts)
    }
  }

  async close(): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    this.#markClosed("closed by the client", false)
    if (this.transport instanceof StreamableHTTPClientTransport && this.transport.sessionId) {
      await this.transport.terminateSession().catch(() => {})
    }
    await this.#sdk.close().catch(() => {})
  }

  #markClosed(reason: string, notify: boolean) {
    if (this.closedReason) return
    this.closedReason = reason
    if (notify) this.#onClose?.(reason)
  }

  #wrapError(method: string, err: unknown, opts: RequestOptions): McpError {
    if (err instanceof McpError) return err
    if (opts.signal?.aborted) return new McpError("aborted")
    if (err instanceof StreamableHTTPError) {
      const prefix = err.code !== undefined && err.code > 0 ? `HTTP ${err.code}: ` : ""
      return new McpError(`${prefix}${err.message}`, err.code)
    }
    if (err instanceof SdkMcpError) {
      if (err.code === ErrorCode.RequestTimeout) {
        return new McpError(`${method} timed out after ${formatMs(opts.timeoutMs)}`, err.code)
      }
      if (err.code === ErrorCode.ConnectionClosed) {
        return new McpError(`connection closed: ${this.closedReason ?? err.message}`, err.code)
      }
      return new McpError(err.message, err.code)
    }
    return new McpError(err instanceof Error ? err.message : String(err))
  }
}

function formatMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`
}
