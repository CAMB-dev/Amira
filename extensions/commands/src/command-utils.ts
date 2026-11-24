import { type CommandCandidate, clip } from "@amira/api"

/** `s` on one line, cut to `max` terminal cells. */
export const oneLine = (s: string, max = 60, more?: string) => clip(s.replace(/\s+/g, " ").trim(), max, more)

/** Candidates "<word> <rest>" for a two-level argument such as "/tools disable <name>". */
export function subcommandCandidates(
  prefix: string,
  subs: Record<string, { description: string; values?: () => CommandCandidate[] }>,
): CommandCandidate[] {
  const m = /^(\S+)\s+/.exec(prefix)
  if (m) {
    const sub = subs[m[1]!]
    return sub?.values ? sub.values().map((c) => ({ ...c, value: `${m[1]} ${c.value}` })) : []
  }
  return Object.entries(subs).map(([value, s]) => ({ value, description: s.description }))
}
