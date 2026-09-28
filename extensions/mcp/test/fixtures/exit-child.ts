// Connects to a stubborn fixture server started through a launcher, then exits without
// closing it, leaving the cleanup to the transport's exit hook. Usage: bun exit-child.ts <pidfile>
import path from "node:path"
import { McpClient } from "../../src/client.ts"
import { StdioTransport } from "../../src/stdio.ts"
import { launcherArgv } from "./launcher.ts"

const server = path.join(import.meta.dir, "server.ts")
const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v
const client = new McpClient(
  new StdioTransport({
    argv: launcherArgv([process.execPath, server, "stdio-stubborn"]),
    cwd: import.meta.dir,
    env: { ...env, FIXTURE_PID_FILE: process.argv[2] ?? "" },
  }),
)
await client.connect({ timeoutMs: 60_000 })
process.exit(0)
