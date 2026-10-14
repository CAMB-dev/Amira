import { statSync } from "node:fs"
import type { Agent } from "@amira/core"
import { displayHistory } from "../display-history.ts"
import { rememberMessageTime } from "../format.ts"
import type { TranscriptView } from "../view.ts"

/** Shows this session's boundary and history; switched full-screen sessions start afresh. */
export function showAgentSession(view: TranscriptView, agent: Agent, switched: boolean) {
  const displays = displayHistory(agent)
  const resumed = agent.messages.length > 0 || displays.length > 0
  let updatedAt: number | undefined
  try {
    if (agent.session?.file && resumed) updatedAt = statSync(agent.session.file).mtimeMs
  } catch {}
  const boundary = {
    id: agent.sessionId,
    resumed,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  }
  for (const entry of agent.session?.branch() ?? []) {
    if (entry.type === "message") rememberMessageTime(entry.message, entry.ts)
  }
  view.openSession(boundary, agent.messages, switched, (m) => agent.compactionInfo(m), displays)
}
