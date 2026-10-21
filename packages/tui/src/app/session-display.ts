import type { Message } from "@amira/ai"
import type { CompactionInfo } from "@amira/api"
import type { AgentPort, FrontendSnapshot } from "@amira/core"
import { displayHistory } from "../display-history.ts"
import { rememberMessageTime } from "../format.ts"
import type { TranscriptView } from "../view.ts"

/** Keeps failed switches pending until their first valid projection, without replaying live turns. */
export function createSessionDisplay(
  frontend: AgentPort,
  view: Pick<TranscriptView, "notice" | "requestRender" | "openSession">,
  options: { follow?: boolean; reset?: () => void } = {},
) {
  let generation = frontend.snapshot.sessionGeneration
  let valid = true
  let pending: { sessionId: string; switched: boolean } | undefined
  const off = frontend.subscribe((update) => {
    if (update.kind === "error") {
      valid = false
      view.notice("warning", update.error.message)
    } else {
      valid = true
      if (options.follow && (update.reset || update.snapshot.sessionGeneration !== generation)) {
        generation = update.snapshot.sessionGeneration
        options.reset?.()
        showAgentSession(view, update.snapshot, true)
        pending = undefined
      } else if (pending?.sessionId === update.snapshot.state.sessionId) {
        showAgentSession(view, update.snapshot, pending.switched)
        pending = undefined
      }
    }
    view.requestRender()
  })
  return {
    show(sessionId: string, switched: boolean) {
      pending = { sessionId, switched }
      if (valid && frontend.snapshot.state.sessionId === sessionId) {
        showAgentSession(view, frontend.snapshot, switched)
        pending = undefined
      }
    },
    dispose() {
      pending = undefined
      off()
    },
  }
}

/** Shows host-projected history without filesystem, store or Agent reads in the renderer. */
export function showAgentSession(
  view: Pick<TranscriptView, "openSession">,
  snapshot: FrontendSnapshot,
  switched: boolean,
) {
  const { state, transcript } = snapshot
  const messages = transcript.messages.map((entry) => entry.message)
  const compactions = new Map<Message, CompactionInfo | undefined>(
    transcript.messages.map((entry) => [entry.message, entry.compaction]),
  )
  for (const entry of transcript.messages) {
    if (entry.ts !== undefined) rememberMessageTime(entry.message, entry.ts)
  }
  view.openSession(
    {
      id: state.sessionId,
      resumed: state.resumed,
      ...(state.updatedAt !== undefined ? { updatedAt: state.updatedAt } : {}),
    },
    messages,
    switched,
    (message) => compactions.get(message),
    displayHistory(snapshot),
  )
}
