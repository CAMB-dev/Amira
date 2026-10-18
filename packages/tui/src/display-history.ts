import type { EventMap, PrintOptions } from "@amira/api"
import type { FrontendSnapshot } from "@amira/core"
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

/** Display anchors are projected by the host, not reconstructed from a local store. */
export function displayHistory(snapshot: FrontendSnapshot): readonly DisplayHistory[] {
  return snapshot.transcript.displays
}
