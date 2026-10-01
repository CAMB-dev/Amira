import type { CommandDefinition, StoredSessionInfo } from "@amira/api"
import { oneLine } from "./command-utils.ts"

/** "3m ago", "5h ago", "2d ago"; the date after a month. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`
  return new Date(ms).toISOString().slice(0, 10)
}

/** How a stored session reads in a picker: "<id>  3m ago  12 msgs  first words". */
export function sessionLabel(s: StoredSessionInfo, now = Date.now()): string {
  return `${s.id}  ${ago(s.updatedAt, now)}  ${s.messageCount} msgs  ${oneLine(s.title || s.firstUserText || "(empty)", 50)}`
}

/** The first word of a picker label, which is the id it stands for. */
const idOf = (label: string) => label.split(/\s/, 1)[0]!

export function clearCommand(): CommandDefinition {
  return {
    name: "clear",
    aliases: ["new", "reset"],
    description: "Start a new session with an empty conversation",
    async run(_args, ctx) {
      await ctx.session.newSession()
      // The TUI names the new session in the boundary line it starts the transcript with.
      if (ctx.frontend !== "tui") ctx.print(`Started a new session (${ctx.session.info().id}).`)
    },
  }
}

export function renameCommand(): CommandDefinition {
  return {
    name: "rename",
    description: "Name the current session",
    args: { hint: "[title]" },
    run(args, ctx) {
      if (!ctx.session.rename) throw new Error("this host cannot rename sessions")
      ctx.session.rename(args)
      const title = ctx.session.info().title
      ctx.print(args.trim() ? `Renamed session to ${title}.` : "Cleared the manual session name.")
    },
  }
}

export function forkCommand(): CommandDefinition {
  return {
    name: "fork",
    description: "Continue this conversation in a new session",
    async run(_args, ctx) {
      if (!ctx.session.fork) throw new Error("this host cannot fork sessions")
      await ctx.session.fork()
      ctx.print(`Forked into session ${ctx.session.info().id}.`)
    },
  }
}

export function resumeCommand(): CommandDefinition {
  return {
    name: "resume",
    aliases: ["continue"],
    description: "Switch to another session of this directory",
    args: {
      hint: "[session id]",
      complete: (_prefix, ctx) =>
        ctx.session.sessions().map((s) => ({
          value: s.id,
          description: `${ago(s.updatedAt)} · ${oneLine(s.title || s.firstUserText || "(empty)", 40)}`,
        })),
    },
    async run(args, ctx) {
      let id = args
      while (!id) {
        const current = ctx.session.info().id
        const sessions = ctx.session.sessions().filter((s) => s.id !== current)
        if (!sessions.length) {
          ctx.print("No other sessions in this directory.")
          return
        }
        const now = Date.now()
        const picked = await ctx.ui.choose(
          "Resume which session?",
          sessions.map((s) => sessionLabel(s, now)),
          {
            signal: ctx.signal,
            sections: [
              {
                at: 0,
                choose: "resume",
                keys: ctx.session.deleteSession ? [{ key: "d", label: "delete" }] : [],
              },
            ],
            descriptions: sessions.map((s) => oneLine(s.firstUserText, 100)),
            searchTexts: sessions.map((s) => s.searchText ?? s.firstUserText),
          },
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
        const chosen = idOf(picked.option)
        if (picked.key === "d") {
          if (await ctx.ui.confirm("Delete this session?", picked.option, { signal: ctx.signal })) {
            await ctx.session.deleteSession!(chosen)
            ctx.print(`Deleted session ${chosen}.`)
          }
          continue
        }
        id = chosen
      }
      await ctx.session.resume(id)
      // As for /clear, the TUI names the resumed session in its boundary line.
      if (ctx.frontend !== "tui")
        ctx.print(`Resumed session ${id} (${ctx.session.messages().length} messages).`)
    },
  }
}
