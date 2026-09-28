import { defineExtension, type Extension, withSection } from "@amira/api"
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
  /**
   * How long after loading a model call may wait for servers still connecting, so a prompt
   * sent right at startup (e.g. with --print) can already use their tools. Default 8000 ms.
   */
  startupWaitMs?: number
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
 * Connects to the configured MCP servers in the background (loading never waits) and
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
    // Servers belong to the host, not to a session: they live until close() or process exit
    // (stdio servers are killed by the exit hook), so later sessions keep their tools.
    const waitMs = opts.startupWaitMs ?? 8000
    const waitUntil = Date.now() + waitMs
    const pending = () => connections.filter((c) => c.state === "idle" || c.state === "connecting")
    // Waits in system.build, so the core's "deferred-tools" section, listed after it, already
    // names the tools of servers that connected meanwhile; the rest get an "mcp" note.
    api.intercept(
      "system.build",
      async (ctx, { signal }) => {
        if (pending().length) await settledWithin(started, waitUntil - Date.now(), signal)
        const note = pendingSection(pending().map((c) => c.config.name))
        if (!note) return { action: "pass" }
        return { action: "modify", value: { sections: withSection(ctx.sections, "mcp", note) } }
      },
      { timeoutMs: waitMs + 2000 },
    )
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

/** Waits for `work` at most `ms`, or until aborted, without keeping the process alive after. */
async function settledWithin(work: Promise<unknown>, ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
      onAbort = () => resolve()
      signal.addEventListener("abort", onAbort, { once: true })
    }),
  ])
  clearTimeout(timer)
  if (onAbort) signal.removeEventListener("abort", onAbort)
}

export default createMcpExtension()
