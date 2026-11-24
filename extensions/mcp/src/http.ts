import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

/**
 * MCP Streamable HTTP transport backed by the official `@modelcontextprotocol/sdk`.
 */
export class HttpTransport extends StreamableHTTPClientTransport {
  constructor(url: string, headers: Record<string, string> = {}) {
    super(new URL(url), Object.keys(headers).length ? { requestInit: { headers } } : undefined)
  }
}
