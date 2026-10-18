import type { Agent } from "../agent.ts"
import type { FrontendDisplayEntry } from "./snapshot.ts"

/** Host-owned anchoring of saved display entries across compaction. */
export function frontendDisplayHistory(agent: Agent): FrontendDisplayEntry[] {
  const branch = agent.session?.branch() ?? []
  const positions = new Map(agent.messages.map((message, i) => [agent.entryId(message), i]))
  let before = agent.messages.length
  const out: FrontendDisplayEntry[] = []
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!
    const position = positions.get(entry.id)
    if (position !== undefined) before = position
    if (entry.type === "display") {
      out.push({
        id: entry.id,
        before,
        level: entry.level,
        text: entry.text,
        options: {
          ...(entry.details !== undefined ? { details: entry.details } : {}),
          ...(entry.markdown !== undefined ? { markdown: entry.markdown } : {}),
        },
      })
    }
  }
  return out.reverse()
}
