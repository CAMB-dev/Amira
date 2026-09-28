import {
  type CommandCandidate,
  type CommandContext,
  type CommandDefinition,
  defineExtension,
  type EventMap,
  type ExtensionAPI,
  type ShellMode,
  type StoredSessionInfo,
} from "@amira/api"
import { contextReport, costByModel, costReport, formatCost, formatTokens, table } from "./format.ts"
import { providerCommand } from "./provider-command.ts"

export {
  contextReport,
  costByModel,
  costReport,
  estimateTokens,
  formatCost,
  formatTokens,
  table,
} from "./format.ts"
export { draftFromValues, modelDescription, providerFormSpec } from "./provider-form.ts"

const SHELLS: ShellMode[] = ["auto", "bash", "powershell"]

/** "3m ago", "5h ago", "2d ago"; the date after a month. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`
  return new Date(ms).toISOString().slice(0, 10)
}

const oneLine = (s: string, max = 60) => {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** How a stored session reads in a picker: "<id>  3m ago  12 msgs  first words". */
export function sessionLabel(s: StoredSessionInfo, now = Date.now()): string {
  return `${s.id}  ${ago(s.updatedAt, now)}  ${s.messageCount} msgs  ${oneLine(s.firstUserText || "(empty)", 50)}`
}

/** The first word of a picker label, which is the id it stands for. */
const idOf = (label: string) => label.split(/\s/, 1)[0]!

/** Candidates "<word> <rest>" for a two-level argument such as "/tools disable <name>". */
function subcommandCandidates(
  prefix: string,
  subs: Record<string, { description: string; values?: () => CommandCandidate[] }>,
): CommandCandidate[] {
  const m = /^(\S+)\s+/.exec(prefix)
  const sub = m ? subs[m[1]!] : undefined
  if (m && sub?.values) return sub.values().map((c) => ({ ...c, value: `${m[1]} ${c.value}` }))
  return Object.entries(subs).map(([value, s]) => ({ value, description: s.description }))
}

/**
 * The built-in slash commands (D55), registered through the same API as any extension's (D27).
 * They act on the session through `ctx.session`, which the host provides.
 */
export default defineExtension((api: ExtensionAPI) => {
  // Git facts per session, for /status; workspace.changed follows every session.start.
  const workspace = new Map<string, EventMap["workspace.changed"]>()
  const waiting = new Set<() => void>()
  api.on("workspace.changed", (e) => {
    workspace.set(e.sessionId, e.data)
    for (const wake of waiting) wake()
  })
  /** The git facts arrive in the background after session.start; right at startup, wait a little. */
  const workspaceOf = async (sessionId: string, signal: AbortSignal) => {
    const deadline = Date.now() + 2000
    while (!workspace.has(sessionId) && Date.now() < deadline && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          waiting.delete(wake)
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(wake, deadline - Date.now())
        waiting.add(wake)
      })
    }
    return workspace.get(sessionId)
  }

  const add = (c: CommandDefinition) => api.registerCommand(c)

  add({
    name: "help",
    aliases: ["?", "h"],
    description: "List the slash commands and skills",
    run(_args, ctx) {
      // Grouped by where they come from, this extension's first; descriptions can be wordy.
      const all = ctx.commands()
      const own = all.find((c) => c.name === "help")?.source
      const sources = [...new Set(all.map((c) => c.source))].sort(
        (a, b) => Number(b === own) - Number(a === own),
      )
      const groups = sources.map((source) => {
        const rows = all
          .filter((c) => c.source === source)
          .map((c) => [
            `/${c.name}${c.aliases.length ? ` (${c.aliases.map((a) => `/${a}`).join(", ")})` : ""}${c.hint ? ` ${c.hint}` : ""}`,
            oneLine(c.description, 70),
          ])
        return `${source === own ? "Commands" : `From ${source}`}:\n${table(rows)}`
      })
      // Skills run with a $, not a slash; they can be many.
      const skills = ctx.skills()
      groups.push(
        skills.length
          ? `Skills ($ runs a skill: $<name> [arguments]):\n${table(skills.map((s) => [`$${s.name}`, oneLine(s.description, 70)]))}`
          : "Skills: none found ($ runs a skill: $<name> [arguments]).",
      )
      const aliases = ctx.aliases()
      if (aliases.length) {
        const rows = aliases.map((a) => [`/${a.name}`, `→ /${oneLine(a.expansion, 70)}`])
        groups.push(`Aliases from settings (commandAliases):\n${table(rows)}`)
      }
      ctx.print(groups.join("\n\n"))
    },
  })

  add({
    name: "quit",
    aliases: ["exit", "q"],
    description: "Leave Amira",
    run(_args, ctx) {
      ctx.quit()
    },
  })

  add({
    name: "clear",
    aliases: ["new", "reset"],
    description: "Start a new session with an empty conversation",
    async run(_args, ctx) {
      await ctx.session.newSession()
      ctx.print(`Started a new session (${ctx.session.info().id}).`)
    },
  })

  add({
    name: "model",
    description: "Switch the model, or pick one",
    args: {
      hint: "[provider/model]",
      complete: (_prefix, ctx) => {
        const current = modelRef(ctx.session.info().model)
        return ctx.session.models().map((value) => ({
          value,
          ...(value === current ? { description: "current" } : {}),
        }))
      },
    },
    async run(args, ctx) {
      let ref = args
      if (!ref) {
        const current = modelRef(ctx.session.info().model)
        const picked = await ctx.ui.select(`Model (now ${current})`, ctx.session.models(), {
          signal: ctx.signal,
        })
        if (!picked) {
          ctx.print(`Model: ${current}. Pass one to switch: /model provider/model`)
          return
        }
        ref = picked
      }
      ctx.session.setModel(ref)
      ctx.print(`Model: ${modelRef(ctx.session.info().model)}`)
    },
  })

  add({
    name: "status",
    description: "Show the model, session, context use, cost and workspace",
    async run(_args, ctx) {
      const info = ctx.session.info()
      const ws = await workspaceOf(info.id, ctx.signal)
      const rows = costByModel(ctx.session.replies())
      const priced = rows.filter((r) => r.cost !== undefined)
      const cost = priced.length ? formatCost(priced.reduce((n, r) => n + (r.cost ?? 0), 0)) : "unknown"
      const provider = ctx.session.providers().find((p) => p.id === info.model.provider)
      const git = !ws
        ? "unknown"
        : ws.repoRoot
          ? `${ws.branch ?? (ws.head ? `detached at ${ws.head.slice(0, 7)}` : "no branch")}${ws.isWorktree ? " (worktree)" : ""} in ${ws.repoRoot}`
          : "not a git repository"
      const context =
        info.contextTokens !== undefined
          ? `${formatTokens(info.contextTokens)} of ${formatTokens(info.contextWindow)} tokens (${Math.round((info.contextTokens / info.contextWindow) * 100)}%)`
          : `window ${formatTokens(info.contextWindow)} tokens; nothing sent yet`
      ctx.print(
        table([
          ["Model", modelRef(info.model)],
          [
            "Provider",
            provider ? `${provider.id} (${provider.dialect}, ${provider.baseUrl})` : info.model.provider,
          ],
          ["Session", `${info.id}${info.busy ? " (turn running)" : ""}`],
          ...(info.file ? [["Session file", info.file]] : []),
          ["Context", context],
          ["Cost", cost],
          ["Shell", info.shell],
          ["Directory", info.cwd],
          ["Git", git],
        ]),
      )
    },
  })

  add({
    name: "compact",
    description: "Summarize older messages now to free context",
    args: { hint: "[instructions]" },
    // Frontends show the outcome from compact.end and compact.failed, like an automatic one.
    async run(args, ctx) {
      await ctx.session.compact(args || undefined)
    },
  })

  add({
    name: "resume",
    aliases: ["continue"],
    description: "Switch to another session of this directory",
    args: {
      hint: "[session id]",
      complete: (_prefix, ctx) =>
        ctx.session.sessions().map((s) => ({
          value: s.id,
          description: `${ago(s.updatedAt)} · ${oneLine(s.firstUserText || "(empty)", 40)}`,
        })),
    },
    async run(args, ctx) {
      let id = args
      if (!id) {
        const current = ctx.session.info().id
        const sessions = ctx.session.sessions().filter((s) => s.id !== current)
        if (!sessions.length) {
          ctx.print("No other sessions in this directory.")
          return
        }
        const now = Date.now()
        const picked = await ctx.ui.select(
          "Resume which session?",
          sessions.slice(0, 50).map((s) => sessionLabel(s, now)),
          { signal: ctx.signal },
        )
        if (!picked) {
          ctx.print(
            `Recent sessions:\n${sessions
              .slice(0, 10)
              .map((s) => sessionLabel(s, now))
              .join("\n")}`,
          )
          return
        }
        id = idOf(picked)
      }
      await ctx.session.resume(id)
      ctx.print(`Resumed session ${id} (${ctx.session.messages().length} messages).`)
    },
  })

  add({
    name: "shell",
    description: "Show or set which shell tools the model gets",
    args: {
      hint: "[auto|bash|powershell]",
      complete: () =>
        SHELLS.map((value) => ({
          value,
          description: value === "auto" ? "every shell tool this system has" : `only the ${value} tool`,
        })),
    },
    run(args, ctx) {
      if (args) ctx.session.setShell(args as ShellMode)
      const shell = ctx.session.info().shell
      const on = ctx.session
        .tools()
        .filter((t) => (t.name === "bash" || t.name === "powershell") && t.enabled)
        .map((t) => t.name)
      ctx.print(`Shell: ${shell} (tools: ${on.join(", ") || "none"})`)
    },
  })

  const toolNames = (ctx: { session: CommandContext["session"] }, enabled: boolean) => () =>
    ctx.session
      .tools()
      .filter((t) => t.enabled !== enabled)
      .map((t) => ({ value: t.name, description: t.source }))

  add({
    name: "tools",
    description: "List tools; enable or disable one for this session",
    args: {
      hint: "[enable|disable <name>]",
      complete: (prefix, ctx) =>
        subcommandCandidates(prefix, {
          disable: { description: "hide a tool from the model", values: toolNames(ctx, false) },
          enable: { description: "give a disabled tool back", values: toolNames(ctx, true) },
        }),
    },
    run(args, ctx) {
      const [sub, name, ...rest] = args.split(/\s+/).filter(Boolean)
      if (sub) {
        if ((sub !== "enable" && sub !== "disable") || !name || rest.length) {
          throw new Error("usage: /tools [enable|disable <name>]")
        }
        ctx.session.setToolEnabled(name, sub === "enable")
        ctx.print(`${sub === "enable" ? "Enabled" : "Disabled"} ${name} for this session.`)
        return
      }
      const tools = ctx.session.tools()
      const rows = tools.map((t) => [
        t.enabled ? "on " : "off",
        t.name,
        t.exposure === "active" ? t.source : `${t.source}, ${t.exposure}`,
      ])
      const off = tools.filter((t) => !t.enabled).length
      ctx.print(`Tools (${tools.length - off} on, ${off} off):\n${table(rows)}`)
    },
  })

  add(providerCommand())

  add({
    name: "cost",
    aliases: ["usage"],
    description: "Show this session's cost by model",
    run(_args, ctx) {
      ctx.print(costReport(ctx.session.replies()))
    },
  })

  add({
    name: "context",
    description: "Show what fills the context window",
    async run(_args, ctx) {
      const info = ctx.session.info()
      ctx.print(contextReport(await ctx.session.preview(), info.contextWindow, info.contextTokens))
    },
  })

  add({
    name: "reload",
    description: "Reload every extension",
    async run(_args, ctx) {
      await ctx.session.reloadExtensions()
      ctx.print("Reloaded extensions.")
    },
  })
})

function modelRef(m: { provider: string; model: string }): string {
  return `${m.provider}/${m.model}`
}
