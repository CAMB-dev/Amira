import { type CommandDefinition, clip, plural } from "@amira/api"
import { oneLine } from "./command-utils.ts"
import { table } from "./format.ts"

export function helpCommand(): CommandDefinition {
  return {
    name: "help",
    aliases: ["?", "h"],
    description: "List the slash commands, the common keys and how to run skills",
    args: { hint: "[command]" },
    run(args, ctx) {
      const sep = ctx.glyphs?.().separator ?? "·"
      const more = ctx.glyphs?.().more ?? "…"
      const arrow = sep === "." ? "->" : "→"
      const all = ctx.commands()
      const query = args.trim().replace(/^\//, "")
      if (query) {
        const match = all.find((c) => c.name === query || c.aliases.includes(query))
        if (!match) throw new Error(`Unknown command "/${query}". Run /help to list all commands.`)
        const lines = [
          `/${match.name}${match.hint ? ` ${match.hint}` : ""}`,
          match.description,
          ...(match.aliases.length ? [`Aliases: ${match.aliases.map((a) => `/${a}`).join(", ")}`] : []),
          `Source: ${match.source}`,
        ]
        ctx.print(lines.join("\n"))
        return
      }
      // Three parts: the commands (built-in ones together, then each extension's), the common
      // keys of the frontend, and the skills folded to a line: they can be many.
      const own = all.find((c) => c.name === "help")?.source
      const builtIn = (source: string) => source === own || source.startsWith("builtin:")
      const sources = [...new Set(all.map((c) => (builtIn(c.source) ? "" : c.source)))].sort(
        (a, b) => Number(b === "") - Number(a === ""),
      )
      const groups = sources.map((source) => {
        const rows = all
          .filter((c) => (builtIn(c.source) ? "" : c.source) === source)
          .map((c) => [
            // Leave room for the two-space separator and description even on 80-column terminals.
            clip(
              `/${c.name}${c.aliases.length ? ` (${c.aliases.map((a) => `/${a}`).join(", ")})` : ""}${c.hint ? ` ${c.hint}` : ""}`,
              38,
              more,
            ),
            oneLine(c.description, 70, more),
          ])
        return `${source === "" ? "Commands" : `From ${source}`}:\n${table(rows)}`
      })
      const keys = ctx.keys?.() ?? []
      if (keys.length)
        groups.push(`Keys:\n${table(keys.map((k) => [k.keys, oneLine(k.description, 70, more)]))}`)
      // Skills run with a $, not a slash; typing $ lists them.
      const n = ctx.skills().length
      groups.push(
        n
          ? `Skills: ${plural(n, "skill")} ${sep} type $ to list them; $<name> [arguments] runs one.`
          : "Skills: none found ($ runs a skill: $<name> [arguments]).",
      )
      const aliases = ctx.aliases()
      if (aliases.length) {
        const rows = aliases.map((a) => [`/${a.name}`, `${arrow} /${oneLine(a.expansion, 70, more)}`])
        groups.push(`Aliases from settings (commandAliases):\n${table(rows)}`)
      }
      groups.push(
        "Providers: /provider add picks a catalog vendor or Custom (choose a protocol).\n" +
          "/provider add <vendor|protocol> skips the picker (protocol names win on a clash).\n" +
          "Use /provider edit <id>, remove <id> or key <id> to manage configured providers.",
      )
      groups.push(
        "Extensions: /ext opens installed and available packages.\n" +
          `/ext install <name> [--project], update [name${more}], remove <name>, disable <name>, enable <name>, search <query>.\n` +
          "Changes apply with /reload while idle.",
      )
      ctx.print(groups.join("\n\n"))
    },
  }
}
