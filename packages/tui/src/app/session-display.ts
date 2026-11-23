import { statSync } from "node:fs"
import type { Agent } from "@amira/core"
import { displayHistory } from "../display-history.ts"
import { rememberMessageTime } from "../format.ts"
import type { TranscriptView } from "../view.ts"

/** Loads the active local agent's transcript history and timestamps into the view. */
export function showAgentSession(
  view: Pick<TranscriptView, "openSession">,
  agent: Agent,
  switched: boolean,
): void {
  const messages = [...agent.messages]
  const branch = agent.session?.branch() ?? []
  const times = new Map(branch.filter((entry) => entry.type === "message").map((e) => [e.id, e.ts]))
  for (const message of messages) {
    const entryId = agent.entryId(message)
    const ts = entryId ? times.get(entryId) : undefined
    if (ts !== undefined) rememberMessageTime(message, ts)
  }
  const displays = displayHistory(agent)
  const resumed = messages.length > 0 || displays.length > 0
  let updatedAt: number | undefined
  try {
    if (agent.session?.file && resumed) updatedAt = statSync(agent.session.file).mtimeMs
  } catch {}
  view.openSession(
    {
      id: agent.sessionId,
      resumed,
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    },
    messages,
    switched,
    (message) => agent.compactionInfo(message),
    displays,
  )
}
