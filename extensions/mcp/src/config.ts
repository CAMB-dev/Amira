import { readFileSync } from "node:fs"
import path from "node:path"
import type { SettingsLayer, SettingsLayerScope } from "@amira/api"

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

export type McpSettingLayer = Pick<SettingsLayer, "scope" | "file"> & { value: unknown }

/**
 * Files holding `mcpServers`, lowest precedence first: a later file's entry replaces an earlier
 * one of the same name. Amira's own settings (the same layers the settings loader merges, D35)
 * win over the Claude Code style `.mcp.json`.
 */
export function mcpConfigFiles(cwd: string, home: string): string[] {
  return [
    path.join(cwd, ".mcp.json"),
    path.join(home, "settings.json"),
    path.join(cwd, ".amira", "settings.json"),
    path.join(cwd, ".amira", "settings.local.json"),
  ]
}

/** The user settings key listing project directories whose own MCP servers may run. */
export const TRUST_KEY = "mcpTrustedProjects"

/**
 * Parses the host-provided settings layers. `.mcp.json` remains a separate MCP convention, so
 * it is read here and prepended; Amira's settings files are never read by this path.
 *
 * Project files come with whatever repository was cloned, so unless the project (or a parent
 * directory) is listed under `mcpTrustedProjects` in the user settings, their stdio servers are
 * not started and their HTTP entries get no environment variables; each skipped server is
 * reported as a problem saying how to trust the project.
 */
export function readMcpSettings(
  layers: readonly McpSettingLayer[],
  trustedLayers: readonly McpSettingLayer[],
  cwd: string,
  home: string,
  env: Record<string, string | undefined> = process.env,
): McpConfig {
  const problems: string[] = []
  const legacyFile = path.join(cwd, ".mcp.json")
  const legacy = readJson(legacyFile, problems)
  const all = [...layers]
  const legacyServers = legacy?.mcpServers
  if (legacyServers !== undefined) {
    all.unshift({ scope: "project", file: legacyFile, value: legacyServers })
  }
  const trusted = trustedLayers.find((layer) => layer.scope === "user")
  return parseLayeredServers(
    all,
    cwd,
    trusted?.value,
    trusted?.file ?? path.join(home, "settings.json"),
    env,
    problems,
  )
}

/**
 * Compatibility reader for callers that are not hosted by Amira. The extension itself uses
 * `readMcpSettings`, so the host remains responsible for locating and parsing Amira settings.
 */
export function readMcpConfig(
  cwd: string,
  home: string,
  env: Record<string, string | undefined> = process.env,
): McpConfig {
  const problems: string[] = []
  const userFile = path.join(home, "settings.json")
  let trusted: unknown
  const layers: McpSettingLayer[] = []
  for (const file of mcpConfigFiles(cwd, home)) {
    const json = readJson(file, problems)
    if (samePath(file, userFile)) trusted = json?.[TRUST_KEY]
    const servers = (json as { mcpServers?: unknown } | undefined)?.mcpServers
    if (servers === undefined) continue
    layers.push({ scope: scopeForFile(file, cwd, home), file, value: servers })
  }
  return parseLayeredServers(layers, cwd, trusted, userFile, env, problems)
}

function parseLayeredServers(
  layers: readonly McpSettingLayer[],
  cwd: string,
  trustedProjects: unknown,
  trustFile: string,
  env: Record<string, string | undefined>,
  problems: string[],
): McpConfig {
  const byName = new Map<string, { server: ServerConfig; scope: SettingsLayerScope }>()
  const trusted = isTrusted(cwd, trustedProjects)
  for (const layer of layers) {
    const fromProject = layer.scope === "project" || layer.scope === "project-local"
    const open = !fromProject || trusted
    const parsed = parseServers(layer.value, layer.file, open ? env : {})
    problems.push(...parsed.problems)
    for (const name of parsed.disabled ?? []) byName.delete(name)
    for (const server of parsed.servers) {
      if (!open && server.type === "stdio") {
        problems.push(
          `${layer.file}: not starting MCP server "${server.name}" (${[server.command, ...server.args].join(" ")}): this project is not trusted. To allow it, add ${JSON.stringify(path.resolve(cwd))} to "${TRUST_KEY}" in ${trustFile}`,
        )
        continue
      }
      // An untrusted project cannot redirect a server the user configured.
      const previous = byName.get(server.name)
      if (!open && (previous?.scope === "user" || previous?.scope === "flags")) continue
      byName.delete(server.name)
      byName.set(server.name, { server, scope: layer.scope })
    }
  }
  return { servers: [...byName.values()].map(({ server }) => server), problems }
}

function scopeForFile(file: string, cwd: string, home: string): SettingsLayerScope {
  if (samePath(file, path.join(home, "settings.json"))) return "user"
  if (samePath(file, path.join(cwd, ".amira", "settings.local.json"))) return "project-local"
  return "project"
}

function readJson(file: string, problems: string[]): Record<string, unknown> | undefined {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  try {
    const json: unknown = JSON.parse(text)
    return json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : undefined
  } catch (err) {
    problems.push(`${file}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/** Whether `cwd` is one of the trusted directories or inside one. */
export function isTrusted(cwd: string, list: unknown): boolean {
  if (!Array.isArray(list)) return false
  const dir = norm(cwd)
  return list.some((entry) => {
    if (typeof entry !== "string" || !entry) return false
    const root = norm(entry)
    return dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  })
}

function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b)
}

function norm(p: string): string {
  const r = path.resolve(p)
  return process.platform === "win32" ? r.toLowerCase() : r
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
