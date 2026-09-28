// A tiny MCP server for tests. `bun server.ts stdio`, or `bun server.ts http|http-sse`, which
// prints the listening URL on its first stdout line. `stdio-stubborn` keeps running after
// stdin ends, so only a kill stops it. FIXTURE_PID_FILE receives the server's pid.
import { writeFileSync, writeSync } from "node:fs"

type Msg = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: any; result?: any; error?: any }
type Send = (m: Msg) => void

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

const baseTools = [
  {
    name: "echo",
    description: "Echoes the text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "add",
    description: "Adds two numbers.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  { name: "image", description: "Returns a tiny PNG.", inputSchema: { type: "object", properties: {} } },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
  {
    name: "slow",
    description: "Waits, then answers.",
    inputSchema: { type: "object", properties: { ms: { type: "number" } } },
  },
  {
    name: "cancelled",
    description: "Lists cancelled request ids.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "resources",
    description: "Returns resource content.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "structured",
    description: "Returns only structured content.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "env",
    description: "Reads an environment variable.",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
  },
  {
    name: "pinged",
    description: "Whether the client answered our ping.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "change_tools",
    description: "Adds a tool and announces it.",
    inputSchema: { type: "object", properties: {} },
  },
  { name: "crash", description: "Exits the process.", inputSchema: { type: "object", properties: {} } },
  {
    name: "my.dotted tool",
    description: "Name needs sanitizing.",
    inputSchema: { type: "object", properties: {} },
  },
]

const text = (t: string, isError = false) => ({
  content: [{ type: "text", text: t }],
  ...(isError ? { isError } : {}),
})

export type Handler = (m: Msg, send: Send) => Promise<void>

/** A server's message handler, with its own state. */
export function createHandler(): Handler {
  // Answers the last tools/list page, then at once adds a tool and announces it.
  let lateTool = process.env.FIXTURE_LATE_TOOL === "1"
  const cancelled: (string | number)[] = []
  let extraTool = false
  let pinged = false

  const tools = () =>
    extraTool
      ? [...baseTools, { name: "extra", description: "Added later.", inputSchema: { type: "object" } }]
      : baseTools

  async function callTool(name: string, args: any, send: Send): Promise<any> {
    switch (name) {
      case "echo":
        return text(`echo: ${args.text}`)
      case "add":
        return text(String(args.a + args.b))
      case "image":
        return {
          content: [
            { type: "text", text: "a pixel" },
            { type: "image", data: PNG, mimeType: "image/png" },
          ],
        }
      case "fail":
        return text("it failed", true)
      case "slow":
        await Bun.sleep(args.ms ?? 1000)
        return text("slow done")
      case "cancelled":
        return text(JSON.stringify(cancelled))
      case "resources":
        return {
          content: [
            {
              type: "resource",
              resource: { uri: "file:///a.txt", mimeType: "text/plain", text: "file body" },
            },
            {
              type: "resource_link",
              uri: "file:///b.bin",
              name: "b.bin",
              mimeType: "application/octet-stream",
            },
            { type: "audio", data: "AAAA", mimeType: "audio/wav" },
          ],
        }
      case "structured":
        return { structuredContent: { value: 42 } }
      case "env":
        return text(process.env[args.name] ?? "(unset)")
      case "pinged":
        return text(String(pinged))
      case "change_tools":
        extraTool = true
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
        return text("changed")
      case "crash":
        writeSync(2, "crashing on purpose\n")
        process.exit(3)
        break
      case "my.dotted tool":
        return text("dotted")
    }
    throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 })
  }

  /** Handles one incoming message; responses and notifications go to `send`. */
  return async function handle(m: Msg, send: Send): Promise<void> {
    if (m.method === undefined) {
      if (m.id === "srv-ping") pinged = true
      return
    }
    if (m.method === "notifications/cancelled") {
      cancelled.push(m.params.requestId)
      return
    }
    if (m.id === undefined) {
      if (m.method === "notifications/initialized") send({ jsonrpc: "2.0", id: "srv-ping", method: "ping" })
      return
    }
    const reply = (result: any) => send({ jsonrpc: "2.0", id: m.id, result })
    const fail = (code: number, message: string) =>
      send({ jsonrpc: "2.0", id: m.id, error: { code, message } })
    switch (m.method) {
      case "initialize":
        return reply({
          protocolVersion: m.params.protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "fixture", version: "1.0.0" },
        })
      case "tools/list": {
        // Pages of five, to exercise pagination.
        const start = Number(m.params?.cursor ?? 0)
        const all = tools()
        const next = start + 5 < all.length ? String(start + 5) : undefined
        reply({ tools: all.slice(start, start + 5), ...(next ? { nextCursor: next } : {}) })
        if (lateTool && !next) {
          lateTool = false
          extraTool = true
          send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
        }
        return
      }
      case "tools/call":
        try {
          const result = await callTool(m.params.name, m.params.arguments ?? {}, send)
          if (!cancelled.includes(m.id!)) reply(result)
        } catch (err: any) {
          fail(err.code ?? -32603, err.message)
        }
        return
      default:
        return fail(-32601, `method not found: ${m.method}`)
    }
  }
}

export function startHttpServer(sse: boolean): { url: string; stop(): void } {
  const handle = createHandler()
  const sessions = new Set<string>()
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 })
      const sid = req.headers.get("mcp-session-id")
      if (req.method === "DELETE") {
        if (sid) sessions.delete(sid)
        return new Response(null, { status: 200 })
      }
      if (req.method !== "POST") return new Response(null, { status: 405 })
      if (
        url.searchParams.get("token") === "required" &&
        req.headers.get("authorization") !== "Bearer secret"
      ) {
        return new Response("unauthorized", { status: 401 })
      }
      const m = (await req.json()) as Msg
      const headers: Record<string, string> = {}
      if (m.method === "initialize") {
        const id = crypto.randomUUID()
        sessions.add(id)
        headers["mcp-session-id"] = id
      } else if (!sid || !sessions.has(sid)) {
        return new Response("missing or unknown session", { status: 400 })
      } else if (m.method !== undefined && m.id !== undefined && !req.headers.get("mcp-protocol-version")) {
        return new Response("missing protocol version header", { status: 400 })
      }
      if (m.id === undefined || m.method === undefined) {
        await handle(m, () => {})
        return new Response(null, { status: 202, headers })
      }
      if (!sse) {
        const out: Msg[] = []
        await handle(m, (r) => void out.push(r))
        const answer = out.find((r) => r.id === m.id && r.method === undefined)
        if (!answer) return new Response(null, { status: 202, headers })
        return Response.json(answer, { headers })
      }
      const stream = new ReadableStream<string>({
        async start(controller) {
          controller.enqueue(": comment line\n\n")
          await handle(m, (r) => controller.enqueue(`event: message\ndata: ${JSON.stringify(r)}\n\n`))
          controller.close()
        },
      })
      return new Response(stream, { headers: { ...headers, "content-type": "text/event-stream" } })
    },
  })
  return { url: `http://localhost:${server.port}/mcp`, stop: () => server.stop(true) }
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "stdio"
  if (process.env.FIXTURE_PID_FILE) writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid))
  if (mode === "stdio" || mode === "stdio-stubborn") {
    const handle = createHandler()
    const out: Send = (m) => writeSync(1, `${JSON.stringify(m)}\n`)
    writeSync(1, "this line is not JSON-RPC and must be ignored\n")
    let buf = ""
    const decoder = new TextDecoder()
    for await (const chunk of Bun.stdin.stream()) {
      buf += decoder.decode(chunk, { stream: true })
      let nl = buf.indexOf("\n")
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) void handle(JSON.parse(line), out)
        nl = buf.indexOf("\n")
      }
    }
    if (mode === "stdio-stubborn") setInterval(() => {}, 1000)
    else process.exit(0)
  } else {
    process.stdout.write(`${startHttpServer(mode === "http-sse").url}\n`)
  }
}
