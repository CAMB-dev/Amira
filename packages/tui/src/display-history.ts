import type { EventMap, PrintOptions } from "@amira/api"
import type { Agent } from "@amira/core"
import type { NoticeLevel } from "./transcript.ts"
import type { TranscriptView } from "./view.ts"

export function displayOutput(
  view: TranscriptView,
  data: EventMap["command.output"] | EventMap["extension.notice"],
): void {
  if (data.details !== undefined || data.markdown || data.persist) view.display(data.level, data.text, data)
  else if ("command" in data) view.commandOutput(data.level, data.text)
  else view.notice(data.level, data.text)
}

export interface DisplayHistory {
  before: number
  level: NoticeLevel
  text: string
  options: PrintOptions
}

/** Anchor saved display entries to the next visible message, even across compaction. */
export function displayHistory(agent: Agent): DisplayHistory[] {
  const branch = agent.session?.branch() ?? []
  const positions = new Map(agent.messages.map((message, i) => [agent.entryId(message), i]))
  let before = agent.messages.length
  const out: DisplayHistory[] = []
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!
    const position = positions.get(entry.id)
    if (position !== undefined) before = position
    if (entry.type === "display") {
      out.push({
        before,
        level: entry.level,
        text: entry.text,
        options: { details: entry.details, markdown: entry.markdown },
      })
    }
  }
  return out.reverse()
}
