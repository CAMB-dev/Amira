import { type AgentStatusState, type CommandContext, type CommandDefinition, clip, plural } from "@amira/api"
import type { ServerConnection, ServerState } from "./server.ts"

const SUBCOMMANDS = {
  reconnect: "Reconnect one MCP server, or all failed/configured servers",
  details: "Show full status, tools and error details for one server",
}

function statusState(state: ServerState): AgentStatusState {
  if (state === "ready") return "done"
  if (state === "connecting" || state === "idle") return "working"
  if (state === "failed") return "failed"
  return "stopped"
}

function serverSummary(c: ServerConnection, sep = "·"): string {
  const head = `${c.config.type} ${sep} ${plural(c.toolNames.length, "tool")}`
  if (c.state === "failed" && c.error) {
    const first = c.error.split("\n")[0]?.trim() ?? c.error
    return `${head} ${sep} ${clip(first, 64)}`
  }
  return `${head} ${sep} ${c.config.source}`
}

function serverDetails(c: ServerConnection): string {
  const endpoint = c.config.type === "http" ? c.config.url : [c.config.command, ...c.config.args].join(" ")
  const lines = [
    `MCP server: ${c.config.name} (${c.state})`,
    `Transport:  ${c.config.type} (${endpoint})`,
    `Source:     ${c.config.source}`,
    `Tools:      ${c.toolNames.length ? `${c.toolNames.length} (${c.toolNames.join(", ")})` : "none"}`,
  ]
  if (c.error) lines.push("", "Error:", c.error)
  return lines.join("\n")
}

async function reconnectServers(ctx: CommandContext, targets: ServerConnection[]): Promise<void> {
  if (!targets.length) {
    ctx.print("No matching MCP servers to reconnect.")
    return
  }
  await Promise.all(targets.map((c) => c.reconnect()))
  const lines = targets.map((c) =>
    c.state === "ready"
      ? `${c.config.name}: ready (${plural(c.toolNames.length, "tool")})`
      : `${c.config.name}: ${c.state}${c.error ? ` — ${clip(c.error.split("\n")[0]!, 80)}` : ""}`,
  )
  const failed = targets.some((c) => c.state !== "ready")
  ctx.print(lines.join("\n"), failed ? "warning" : "info")
}

/** `/mcp`: inspect configured MCP servers, view details/stderr, and reconnect without reloading. */
export function mcpCommand(getConnections: () => Map<string, ServerConnection>): CommandDefinition {
  return {
    name: "mcp",
    description: "Show MCP server status, details, or reconnect servers",
    args: {
      hint: "[reconnect [name]|details <name>]",
      complete(prefix) {
        const names = [...getConnections().keys()]
        const m = /^(\S+)\s+/.exec(prefix)
        if (m) {
          const sub = m[1]!
          if (sub === "reconnect" || sub === "details") {
            return names.map((name) => {
              const c = getConnections().get(name)!
              return {
                value: `${sub} ${name}`,
                description: `${c.state} · ${plural(c.toolNames.length, "tool")}`,
              }
            })
          }
          return []
        }
        return [
          ...Object.entries(SUBCOMMANDS).map(([value, description]) => ({ value, description })),
          ...names.map((name) => {
            const c = getConnections().get(name)!
            return { value: name, description: `${c.state} · ${plural(c.toolNames.length, "tool")}` }
          }),
        ]
      },
    },
    async run(args, ctx) {
      const connections = getConnections()
      const list = [...connections.values()]
      const [sub, name, ...rest] = args.trim().split(/\s+/).filter(Boolean)
      if (!sub) {
        if (!list.length) {
          ctx.print(
            'No MCP servers configured. Add entries under "mcpServers" in settings.json or .mcp.json.',
          )
          return
        }
        const sep = ctx.glyphs?.().separator ?? "·"
        if (ctx.frontend !== "tui") {
          ctx.print(
            list.map((c) => `${c.config.name} (${c.state}) ${sep} ${serverSummary(c, sep)}`).join("\n"),
          )
          return
        }
        const options = list.map((c) => c.config.name)
        const pick = await ctx.ui.choose("MCP servers", options, {
          sections: [
            {
              at: 0,
              choose: "details",
              keys: [
                { key: "r", label: "reconnect" },
                { key: "d", label: "details" },
              ],
            },
          ],
          optionStatuses: list.map((c) => statusState(c.state)),
          descriptions: list.map((c) => serverSummary(c, sep)),
          live: () => {
            const current = options.map((n) => getConnections().get(n)).filter(Boolean) as ServerConnection[]
            return {
              optionStatuses: current.map((c) => statusState(c.state)),
              descriptions: current.map((c) => serverSummary(c, sep)),
            }
          },
          signal: ctx.signal,
        })
        if (!pick) return
        const chosen = connections.get(pick.option)
        if (!chosen) return
        if (pick.key === "r") return reconnectServers(ctx, [chosen])
        ctx.print(serverDetails(chosen), chosen.state === "failed" ? "warning" : "info")
        return
      }
      if (sub === "reconnect") {
        if (rest.length) throw new Error("Usage: /mcp reconnect [name]")
        if (name) {
          const target = connections.get(name)
          if (!target) throw new Error(`No MCP server named "${name}".`)
          return reconnectServers(ctx, [target])
        }
        const failed = list.filter((c) => c.state === "failed" || c.state === "closed")
        return reconnectServers(ctx, failed.length ? failed : list)
      }
      if (sub === "details") {
        if (!name || rest.length) throw new Error("Usage: /mcp details <name>")
        const target = connections.get(name)
        if (!target) throw new Error(`No MCP server named "${name}".`)
        ctx.print(serverDetails(target), target.state === "failed" ? "warning" : "info")
        return
      }
      if (!name && connections.has(sub)) {
        const target = connections.get(sub)!
        ctx.print(serverDetails(target), target.state === "failed" ? "warning" : "info")
        return
      }
      throw new Error("Usage: /mcp [reconnect [name]|details <name>]")
    },
  }
}
