import path from "node:path"
import { type ExtensionAPI, textResult } from "@amira/api"
import { McpClient, type McpTool } from "./client.ts"
import type { ServerConfig } from "./config.ts"
import { HttpTransport } from "./http.ts"
import { StdioTransport } from "./stdio.ts"
import { mcpToolName, toolDescription, toolSchema, toToolResult } from "./tools.ts"

export type ServerState = "idle" | "connecting" | "ready" | "failed" | "closed"

export interface ServerOptions {
  /** Time allowed for spawning, the handshake and listing tools. Default 60 s (npx may download). */
  connectTimeoutMs: number
  /** Default time a tool call may take, unless the server config sets `timeout`. Default 10 min. */
  toolTimeoutMs: number
}

/** One configured MCP server: its connection and the deferred tools it registered. */
export class ServerConnection {
  readonly config: ServerConfig
  state: ServerState = "idle"
  error: string | undefined
  toolNames: string[] = []

  #api: ExtensionAPI
  #opts: ServerOptions
  #client: McpClient | undefined
  #unregister: (() => void)[] = []
  #refreshing: Promise<void> = Promise.resolve()
  /** The tool list changed while connecting; list it again once ready. */
  #stale = false

  constructor(config: ServerConfig, api: ExtensionAPI, opts: ServerOptions) {
    this.config = config
    this.#api = api
    this.#opts = opts
  }

  /** Connects and registers the server's tools. Never throws; failures are reported. */
  async start(): Promise<void> {
    if (this.state !== "idle") return
    this.state = "connecting"
    const transport = this.#transport()
    const client = new McpClient(transport)
    this.#client = client
    client.onClose((reason) => this.#lost(reason))
    client.onToolsChanged(() => {
      if (this.#is("connecting")) this.#stale = true
      else this.#queueRefresh()
    })
    const deadline = AbortSignal.timeout(this.#opts.connectTimeoutMs)
    try {
      await Promise.race([
        client.connect({ timeoutMs: this.#opts.connectTimeoutMs }),
        new Promise((_, reject) =>
          deadline.addEventListener("abort", () =>
            reject(new Error(`timed out after ${this.#opts.connectTimeoutMs / 1000}s while connecting`)),
          ),
        ),
      ])
      const tools = await client.listTools({ timeoutMs: this.#opts.connectTimeoutMs })
      // close() or a lost connection may have happened meanwhile.
      if (!this.#is("connecting")) return
      this.#register(tools)
      this.state = "ready"
      if (this.#stale) this.#queueRefresh()
    } catch (err) {
      if (!this.#is("connecting")) return void client.close()
      const tail = transport instanceof StdioTransport ? transport.stderrTail : ""
      this.#failed(`${err instanceof Error ? err.message : String(err)}${tail ? `\n${tail}` : ""}`)
      void client.close()
    }
  }

  /** Reads the state without the narrowing TypeScript keeps across awaits. */
  #is(state: ServerState): boolean {
    return this.state === state
  }

  async close(): Promise<void> {
    if (this.state === "closed") return
    this.state = "closed"
    this.#unregisterAll()
    await this.#client?.close()
  }

  #transport() {
    const c = this.config
    if (c.type === "http") return new HttpTransport(c.url, c.headers)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v
    return new StdioTransport(
      {
        argv: [c.command, ...c.args],
        cwd: c.cwd ? path.resolve(this.#api.cwd, c.cwd) : this.#api.cwd,
        env: { ...env, ...c.env },
      },
      { openPipe: this.#api.openPipe },
    )
  }

  #register(tools: McpTool[]) {
    this.#unregisterAll()
    const server = this.config.name
    const seen = new Set<string>()
    for (const tool of tools) {
      if (!tool?.name) continue
      const name = mcpToolName(server, tool.name)
      if (seen.has(name)) {
        this.#api.reportError(
          `MCP server "${server}": skipped tool "${tool.name}", its name clashes as ${name}`,
        )
        continue
      }
      seen.add(name)
      try {
        this.#unregister.push(
          this.#api.registerTool({
            name,
            description: toolDescription(server, tool),
            parameters: toolSchema(tool),
            exposure: "deferred",
            concurrency: tool.annotations?.readOnlyHint === true ? "parallel" : "serial",
            execute: (args, ctx) => this.#call(tool.name, args, ctx.signal),
          }),
        )
      } catch (err) {
        this.#api.reportError(`MCP server "${server}": ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.toolNames = [...seen]
  }

  async #call(tool: string, args: Record<string, unknown>, signal: AbortSignal) {
    const client = this.#client
    if (!client || this.state !== "ready") {
      return textResult(
        `MCP server "${this.config.name}" is not connected${this.error ? `: ${this.error}` : ""}.`,
        true,
      )
    }
    const timeoutMs = this.config.timeoutMs ?? this.#opts.toolTimeoutMs
    try {
      return toToolResult(await client.callTool(tool, args, { timeoutMs, signal }))
    } catch (err) {
      if (signal.aborted) throw err
      return textResult(
        `MCP tool "${tool}" failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      )
    }
  }

  #queueRefresh() {
    this.#stale = false
    this.#refreshing = this.#refreshing.then(() => this.#refresh())
  }

  async #refresh() {
    if (this.state !== "ready" || !this.#client) return
    try {
      this.#register(await this.#client.listTools({ timeoutMs: this.#opts.connectTimeoutMs }))
      this.#api.requestRender()
    } catch (err) {
      this.#api.reportError(
        `MCP server "${this.config.name}": could not refresh its tools: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  #lost(reason: string) {
    if (this.state === "closed" || this.state === "failed") return
    this.#failed(this.state === "ready" ? `disconnected: ${reason}` : reason)
  }

  #failed(error: string) {
    this.state = "failed"
    this.error = error
    this.#unregisterAll()
    this.#api.reportError(`MCP server "${this.config.name}" (${this.config.source}) failed: ${error}`)
  }

  #unregisterAll() {
    for (const off of this.#unregister.splice(0)) off()
    this.toolNames = []
  }
}
