import {
  type CommandCandidate,
  type CommandContext,
  type CommandDefinition,
  clip,
  defineExtension,
  type EventMap,
  type ExtensionAPI,
  modelLabel,
  type ReloadReport,
  type ShellMode,
  type StoredSessionInfo,
} from "@amira/api"
import { extensionCommand } from "./ext-command.ts"
import {
  cacheHitRate,
  contextReport,
  costByModel,
  costReport,
  formatCost,
  formatTokens,
  table,
  tokensPerSecond,
  windowLabel,
} from "./format.ts"
import { providerCommand } from "./provider-command.ts"

export { extensionCommand } from "./ext-command.ts"
export {
  cacheHitRate,
  contextReport,
  costByModel,
  costReport,
  estimateTokens,
  formatCost,
  formatTokens,
  table,
  tokensPerSecond,
} from "./format.ts"
export {
  draftFromValues,
  modelDescription,
  type ProviderFormInitial,
  providerFormSpec,
} from "./provider-form.ts"

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

/** `s` on one line, cut to `max` terminal cells. */
const oneLine = (s: string, max = 60) => clip(s.replace(/\s+/g, " ").trim(), max)

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

  // For /status: the speed of each top-level session's last reply, timed from its first
  // streamed piece. Sub-agents (their events carry parentSessionId) are left out.
  const firstDeltaAt = new Map<string, number>()
  const speed = new Map<string, number>()
  api.on("message.start", (e) => void firstDeltaAt.delete(e.sessionId))
  api.on("message.delta", (e) => {
    if (e.parentSessionId === undefined && !firstDeltaAt.has(e.sessionId)) firstDeltaAt.set(e.sessionId, e.ts)
  })
  api.on("message.end", (e) => {
    const start = firstDeltaAt.get(e.sessionId)
    firstDeltaAt.delete(e.sessionId)
    const out = e.data.message.usage?.output ?? 0
    const tps = start === undefined ? undefined : tokensPerSecond(out, start, e.ts)
    if (tps !== undefined) speed.set(e.sessionId, tps)
  })

  const add = (c: CommandDefinition) => api.registerCommand(c)
  const extensions = extensionCommand(api)
  add(extensions.command)

  add({
    name: "help",
    aliases: ["?", "h"],
    description: "List the slash commands, the common keys and how to run skills",
    run(_args, ctx) {
      // Three parts: the commands (built-in ones together, then each extension's), the common
      // keys of the frontend, and the skills folded to a line: they can be many.
      const all = ctx.commands()
      const own = all.find((c) => c.name === "help")?.source
      const builtIn = (source: string) => source === own || source.startsWith("builtin:")
      const sources = [...new Set(all.map((c) => (builtIn(c.source) ? "" : c.source)))].sort(
        (a, b) => Number(b === "") - Number(a === ""),
      )
      const groups = sources.map((source) => {
        const rows = all
          .filter((c) => (builtIn(c.source) ? "" : c.source) === source)
          .map((c) => [
            `/${c.name}${c.aliases.length ? ` (${c.aliases.map((a) => `/${a}`).join(", ")})` : ""}${c.hint ? ` ${c.hint}` : ""}`,
            oneLine(c.description, 70),
          ])
        return `${source === "" ? "Commands" : `From ${source}`}:\n${table(rows)}`
      })
      const keys = ctx.keys?.() ?? []
      if (keys.length) groups.push(`Keys:\n${table(keys.map((k) => [k.keys, oneLine(k.description, 70)]))}`)
      // Skills run with a $, not a slash; typing $ lists them.
      const n = ctx.skills().length
      groups.push(
        n
          ? `Skills: ${n} ${n === 1 ? "skill" : "skills"} · type $ to list them; $<name> [arguments] runs one.`
          : "Skills: none found ($ runs a skill: $<name> [arguments]).",
      )
      const aliases = ctx.aliases()
      if (aliases.length) {
        const rows = aliases.map((a) => [`/${a.name}`, `→ /${oneLine(a.expansion, 70)}`])
        groups.push(`Aliases from settings (commandAliases):\n${table(rows)}`)
      }
      groups.push(
        "Extensions: /ext opens installed and available packages.\n" +
          "/ext install <name> [--project], update [name…], remove <name>, disable <name>, enable <name>, search <query>.\n" +
          "Changes apply with /reload while idle.",
      )
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
      // The TUI names the new session in the boundary line it starts the transcript with.
      if (ctx.frontend !== "tui") ctx.print(`Started a new session (${ctx.session.info().id}).`)
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
      const ref = args
      if (!ref) {
        const current = modelRef(ctx.session.info().model)
        const models = ctx.session.models()
        if (!models.length) {
          throw new Error(
            ctx.session.providers().length
              ? "No models to pick from: list some with /provider edit <id>, store a key with /provider key <id>, or pass one: /model provider/model"
              : "No providers configured — add one with /provider add",
          )
        }
        const picked = await ctx.ui.select(`Model (now ${current})`, models, {
          signal: ctx.signal,
        })
        if (!picked) {
          ctx.print(`Model: ${current}. Pass one to switch: /model provider/model`)
          return
        }
        // The TUI's picker leaves an echo line that shows what was chosen; other frontends
        // get the model it came to.
        ctx.session.setModel(picked)
        if (ctx.frontend !== "tui") ctx.print(`Model: ${modelRef(ctx.session.info().model)}`)
        return
      }
      ctx.session.setModel(ref)
      ctx.print(`Model: ${modelRef(ctx.session.info().model)}`)
    },
  })

  add({
    name: "status",
    description: "Show the model, session, context use, output, cache, speed, cost and workspace",
    async run(_args, ctx) {
      const info = ctx.session.info()
      const ws = await workspaceOf(info.id, ctx.signal)
      const rows = costByModel(ctx.session.replies())
      const provider = ctx.session.providers().find((p) => p.id === info.model.provider)
      const git = !ws
        ? "unknown"
        : ws.repoRoot
          ? `${ws.branch ?? (ws.head ? `detached at ${ws.head.slice(0, 7)}` : "no branch")}${ws.isWorktree ? " (worktree)" : ""} in ${ws.repoRoot}${ws.dirty ? ", with uncommitted changes" : ""}`
          : "not a git repository"
      // This session's own replies, and with its sub-agents' (the status bar shows the latter,
      // as spent since this run started). Both count earlier runs of a resumed session.
      // Compactions (the server's, or summaries the model wrote) count too, and are named.
      const compacted = (ctx.session.compactions?.() ?? []).filter((c) => c.usage.cost !== undefined)
      const compaction = compacted.length ? compacted.reduce((n, c) => n + (c.usage.cost ?? 0), 0) : undefined
      const priced = rows.filter((r) => r.cost !== undefined)
      const replies = priced.length ? priced.reduce((n, r) => n + (r.cost ?? 0), 0) : undefined
      const own =
        replies !== undefined || compaction !== undefined ? (replies ?? 0) + (compaction ?? 0) : undefined
      const subs = ctx.session.subagents().filter((s) => s.usage.cost !== undefined)
      const withSubs = subs.length
        ? (own ?? 0) + subs.reduce((n, s) => n + (s.usage.cost ?? 0), 0)
        : undefined
      const ofWhich = compaction !== undefined ? `; of which compaction ${formatCost(compaction)}` : ""
      const cost =
        withSubs !== undefined
          ? `${formatCost(withSubs)} with sub-agents${own !== undefined && formatCost(own) !== formatCost(withSubs) ? `; this session alone ${formatCost(own)}` : ""}${ofWhich}`
          : own !== undefined
            ? `${formatCost(own)} (this session; no sub-agents)${ofWhich}`
            : "unknown"
      const usage = rows.reduce(
        (t, r) => ({
          input: t.input + r.usage.input,
          output: t.output + r.usage.output,
          cacheRead: t.cacheRead + r.usage.cacheRead,
          cacheWrite: t.cacheWrite + r.usage.cacheWrite,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      )
      const cacheRate = cacheHitRate(usage.input, usage.cacheRead, usage.cacheWrite)
      const tps = speed.get(info.id)
      const context =
        info.contextTokens !== undefined
          ? `${formatTokens(info.contextTokens)} of ${formatTokens(info.contextWindow)} tokens (${Math.round((info.contextTokens / info.contextWindow) * 100)}%)`
          : "nothing sent yet"
      ctx.print(
        table([
          ["Model", modelRef(info.model)],
          [
            "Provider",
            provider
              ? `${provider.id} (${provider.dialect}, ${provider.baseUrl})`
              : info.model.provider || "(none; add one with /provider add, pick a model with /model)",
          ],
          ["Session", `${info.id}${info.busy ? " (turn running)" : ""}`],
          ...(info.file ? [["Session file", info.file]] : []),
          ["Context", info.model.provider ? context : "no model yet"],
          ...(info.model.provider
            ? [["Window", windowLabel(info.contextWindow, info.contextWindowSource)]]
            : []),
          ["Output", `${formatTokens(usage.output)} tokens written by this session's replies`],
          [
            "Cache",
            cacheRate === undefined
              ? "nothing sent yet"
              : `${Math.round(cacheRate * 100)}% of this session's prompt tokens read from the cache`,
          ],
          [
            "Speed",
            tps === undefined
              ? "not measured yet"
              : `${tps < 10 ? tps.toFixed(1) : Math.round(tps)} tokens/s in this session's last reply`,
          ],
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
      // As for /clear, the TUI names the resumed session in its boundary line.
      if (ctx.frontend !== "tui")
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
      ctx.print(costReport(ctx.session.replies(), ctx.session.compactions?.() ?? []))
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
      if (extensions.running()) throw new Error("Extension management is running; reload after it ends.")
      const report = await ctx.session.reloadExtensions()
      ctx.print(report ? reloadSummary(report) : "Reloaded extensions.")
    },
  })
})

/** "Reloaded 9 extensions · loaded workflow · 1 failed: x": what /reload changed. */
export function reloadSummary(r: ReloadReport): string {
  const parts = [`Reloaded ${r.extensions} ${r.extensions === 1 ? "extension" : "extensions"}`]
  if (r.loaded.length) parts.push(`new: ${r.loaded.join(", ")}`)
  if (r.unloaded.length) parts.push(`gone: ${r.unloaded.join(", ")}`)
  if (r.skillsAdded) parts.push(`${r.skillsAdded} new ${r.skillsAdded === 1 ? "skill" : "skills"}`)
  if (r.skillsRemoved) parts.push(`${r.skillsRemoved} ${r.skillsRemoved === 1 ? "skill" : "skills"} gone`)
  if (r.failed.length) parts.push(`${r.failed.length} failed: ${r.failed.join(", ")}`)
  if (parts.length === 1) parts.push("nothing changed")
  return parts.join(" · ")
}

const modelRef = modelLabel
