export type JsonRpcId = string | number

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/** Carries JSON-RPC messages to one MCP server and back. */
export interface Transport {
  /** Resolves once messages can be sent. */
  start(): Promise<void>
  send(message: JsonRpcMessage): Promise<void>
  /** Stops any work still running for a request the client gave up on. */
  cancel?(id: JsonRpcId): void
  close(): Promise<void>
  /** Set by the client before start(). */
  onmessage?: (message: JsonRpcMessage) => void
  /** Called once when the connection ends by itself, not after close(). */
  onclose?: (reason: string) => void
  /** Set after initialization; HTTP sends it as a header. */
  protocolVersion?: string
}

export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return "id" in m && !("method" in m)
}

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return "id" in m && "method" in m
}
