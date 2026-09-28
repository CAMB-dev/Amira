import { readFileSync } from "node:fs"
import path from "node:path"

interface Common {
  name: string
  /** The file the entry came from. */
  source: string
  /** Milliseconds a tool call may take. */
  timeoutMs?: number
}

export type ServerConfig =
  | (Common & { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string })
  | (Common & { type: "http"; url: string; headers: Record<string, string> })

export interface McpConfig {
  servers: ServerConfig[]
  /** Unreadable files and invalid entries, as messages. */
  problems: string[]
  /** Names marked `"disabled": true`; they also switch off entries from earlier files. */
  disabled?: string[]
}

/**
 * Files holding `mcpServers`, lowest precedence first: a later file's entry replaces an earlier
 * one of the same name. Amira's own settings win over the Claude Code style `.mcp.json`.
 */
export function mcpConfigFiles(cwd: string, home: string): string[] {
  return [
    path.join(cwd, ".mcp.json"),
    path.join(home, "settings.json"),
    path.join(cwd, ".amira", "settings.json"),
  ]
}

/**
 * A deliberately tiny reader for the `mcpServers` of these files; a full settings loader can
 * replace it by handing parsed entries to `parseServers`.
 */
export function readMcpConfig(
  cwd: string,
  home: string,
  env: Record<string, string | undefined> = process.env,
): McpConfig {
  const byName = new Map<string, ServerConfig>()
  const problems: string[] = []
  for (const file of mcpConfigFiles(cwd, home)) {
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (err) {
      problems.push(`${file}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const servers = (json as { mcpServers?: unknown } | null)?.mcpServers
    if (servers === undefined) continue
    const parsed = parseServers(servers, file, env)
    problems.push(...parsed.problems)
    for (const name of parsed.disabled ?? []) byName.delete(name)
    for (const s of parsed.servers) {
      byName.delete(s.name)
      byName.set(s.name, s)
    }
  }
  return { servers: [...byName.values()], problems }
}

export function parseServers(
  raw: unknown,
  source: string,
  env: Record<string, string | undefined> = process.env,
): McpConfig {
  const servers: ServerConfig[] = []
  const problems: string[] = []
  const disabled: string[] = []
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { servers, problems: [`${source}: "mcpServers" must be an object`] }
  }
  for (const [name, value] of Object.entries(raw)) {
    const r = parseServer(name, value, source, env)
    if (typeof r === "string") problems.push(`${source}: MCP server "${name}": ${r}`)
    else if (r) servers.push(r)
    else disabled.push(name)
  }
  return { servers, problems, disabled }
}

function parseServer(
  name: string,
  v: unknown,
  source: string,
  env: Record<string, string | undefined>,
): ServerConfig | string | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "must be an object"
  const o = v as Record<string, unknown>
  if (o.disabled === true) return undefined
  const x = (s: string) => expand(s, env)
  const common: Common = { name, source }
  if (o.timeout !== undefined) {
    if (typeof o.timeout !== "number" || o.timeout <= 0) return '"timeout" must be a positive number of ms'
    common.timeoutMs = o.timeout
  }
  const type = o.type ?? (typeof o.url === "string" ? "http" : "stdio")
  if (type === "stdio") {
    if (typeof o.command !== "string" || !o.command) return '"command" is required'
    if (o.args !== undefined && !isStringArray(o.args)) return '"args" must be an array of strings'
    const vars = stringRecord(o.env)
    if (vars === undefined) return '"env" must map names to strings'
    return {
      ...common,
      type: "stdio",
      command: x(o.command),
      args: ((o.args as string[] | undefined) ?? []).map(x),
      env: Object.fromEntries(Object.entries(vars).map(([k, val]) => [k, x(val)])),
      ...(typeof o.cwd === "string" ? { cwd: x(o.cwd) } : {}),
    }
  }
  if (type === "http" || type === "streamable-http" || type === "streamableHttp") {
    if (typeof o.url !== "string" || !o.url) return '"url" is required'
    const headers = stringRecord(o.headers)
    if (headers === undefined) return '"headers" must map names to strings'
    return {
      ...common,
      type: "http",
      url: x(o.url),
      headers: Object.fromEntries(Object.entries(headers).map(([k, val]) => [k, x(val)])),
    }
  }
  if (type === "sse") return 'the legacy "sse" transport is not supported; use "http" (streamable HTTP)'
  return `unknown type "${String(type)}"`
}

/** Expands `${VAR}` and `${VAR:-default}`, as Claude Code does in .mcp.json. */
export function expand(s: string, env: Record<string, string | undefined>): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, n: string, d?: string) => {
    const val = env[n]
    return val !== undefined && val !== "" ? val : (d ?? "")
  })
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string")
}

function stringRecord(v: unknown): Record<string, string> | undefined {
  if (v === undefined) return {}
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") return undefined
    out[k] = val
  }
  return out
}
