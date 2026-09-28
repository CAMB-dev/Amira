import { defineExtension, type Extension } from "@amira/api"
import { type McpConfig, readMcpConfig } from "./config.ts"
import { ServerConnection, type ServerOptions, type ServerState } from "./server.ts"

export { McpClient, type McpTool, PROTOCOL_VERSION } from "./client.ts"
export { expand, mcpConfigFiles, parseServers, readMcpConfig, type ServerConfig } from "./config.ts"
export { HttpTransport } from "./http.ts"
export { StdioTransport } from "./stdio.ts"
export { mcpToolName, toToolResult } from "./tools.ts"

export interface McpExtensionOptions extends Partial<ServerOptions> {
  /** Use these servers instead of reading the settings files. */
  config?: McpConfig
}

export interface ServerStatus {
  name: string
  state: ServerState
  error?: string
  tools: string[]
}

export type McpExtension = Extension & {
  /** Resolves once every server has connected or failed. */
  settled(): Promise<void>
  servers(): ServerStatus[]
  close(): Promise<void>
}

/** The note shown to the model while servers are still connecting. */
export function pendingSection(names: string[]): string {
  if (!names.length) return ""
  return `# MCP servers\nStill connecting: ${names.join(", ")}. Their tools will be listed under "Deferred tools" once ready.`
}

/**
 * Connects to the configured MCP servers in the background (startup never waits) and
 * registers their tools as deferred `mcp__<server>__<tool>` tools. A failing server is
 * reported as extension.error and leaves the others alone.
 */
export function createMcpExtension(opts: McpExtensionOptions = {}): McpExtension {
  let connections: ServerConnection[] = []
  let started: Promise<unknown> = Promise.resolve()
  const ext = defineExtension((api) => {
    const config = opts.config ?? readMcpConfig(api.cwd, api.home)
    for (const p of config.problems) api.reportError(p)
    if (!config.servers.length) return
    const serverOpts: ServerOptions = {
      connectTimeoutMs: opts.connectTimeoutMs ?? 60_000,
      toolTimeoutMs: opts.toolTimeoutMs ?? 600_000,
    }
    connections = config.servers.map((s) => new ServerConnection(s, api, serverOpts))
    started = new Promise((resolve) => {
      setTimeout(() => resolve(Promise.all(connections.map((c) => c.start()))), 0)
    })
    api.on("session.end", () => void Promise.all(connections.map((c) => c.close())))
    // Until named prompt sections land, the note is appended as its own block here.
    api.intercept("context.build", (ctx) => {
      const pending = connections.filter((c) => c.state === "idle" || c.state === "connecting")
      const note = pendingSection(pending.map((c) => c.config.name))
      if (!note) return { action: "pass" }
      return { action: "modify", value: { ...ctx, systemPrompt: `${ctx.systemPrompt.trimEnd()}\n\n${note}` } }
    })
  })
  return Object.assign(ext, {
    settled: async () => {
      await started
    },
    servers: () =>
      connections.map((c) => ({
        name: c.config.name,
        state: c.state,
        tools: [...c.toolNames],
        ...(c.error ? { error: c.error } : {}),
      })),
    close: async () => {
      await Promise.all(connections.map((c) => c.close()))
    },
  })
}

export default createMcpExtension()
