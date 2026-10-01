import type { ToolDefinition, ToolTraits } from "@amira/api"

/**
 * The capabilities the built-in tools' names imply. A tool registered under one of these names
 * (an override of a built-in, say) keeps them whatever it declares: a declaration can add
 * capabilities but never remove these, so it cannot take a built-in name out of the protected
 * path checks, the shell rules or plan mode's refusals.
 */
const NAME_FLOOR: Readonly<Record<string, ToolTraits>> = {
  write: { writesFiles: "paths" },
  edit: { writesFiles: "paths", editor: "edit" },
  apply_patch: { writesFiles: "paths", editor: "apply_patch" },
  bash: { shell: "bash" },
  powershell: { shell: "powershell" },
  ask_user: { interactive: true },
}

/**
 * A tool's traits as the host acts on them: what it declares, with the capabilities its name
 * implies laid over. `readOnly` is dropped for a tool that writes files or runs
 * a shell, since those are decided by their own checks.
 */
export function toolTraits(tool: Pick<ToolDefinition, "name" | "traits">): ToolTraits | undefined {
  const floor = Object.hasOwn(NAME_FLOOR, tool.name) ? NAME_FLOOR[tool.name] : undefined
  if (!floor) return tool.traits
  const declared = tool.traits ?? {}
  const out: ToolTraits = { ...declared, ...floor }
  // A complete report is the stronger promise only when the tool itself makes it.
  if (floor.writesFiles && (declared.writesFiles === true || declared.writesFiles === "paths")) {
    out.writesFiles = declared.writesFiles
  }
  if (out.writesFiles || out.shell) delete out.readOnly
  return out
}

/**
 * The paths a built-in-named file tool call would write, read from its arguments: `path` for
 * write and edit, every file an apply_patch patch adds, deletes, updates or moves to. Generous
 * on purpose: a header line anywhere counts, whether or not the patch would parse. Undefined
 * for any other name.
 */
export function builtinWrittenPaths(name: string, args: Record<string, unknown>): string[] | undefined {
  if (name === "write" || name === "edit")
    return typeof args.path === "string" && args.path ? [args.path] : []
  if (name !== "apply_patch") return undefined
  if (typeof args.patch !== "string") return []
  const out: string[] = []
  for (const raw of args.patch.split(/\r?\n/)) {
    const line = raw.trim()
    const header = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/.exec(line)
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    const found = header?.[1] ?? move?.[1]
    if (found) out.push(found)
  }
  return out
}
