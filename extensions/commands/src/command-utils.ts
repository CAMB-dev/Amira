import { type CommandCandidate, clip } from "@amira/api"

/** `s` on one line, cut to `max` terminal cells. */
export const oneLine = (s: string, max = 60) => clip(s.replace(/\s+/g, " ").trim(), max)

/** Candidates "<word> <rest>" for a two-level argument such as "/tools disable <name>". */
export function subcommandCandidates(
  prefix: string,
  subs: Record<string, { description: string; values?: () => CommandCandidate[] }>,
): CommandCandidate[] {
  const m = /^(\S+)\s+/.exec(prefix)
  const sub = m ? subs[m[1]!] : undefined
  if (m && sub?.values) return sub.values().map((c) => ({ ...c, value: `${m[1]} ${c.value}` }))
  return Object.entries(subs).map(([value, s]) => ({ value, description: s.description }))
}
