import type { AnyEvent } from "@amira/api"
import type { AgentPort } from "@amira/core"
import type { Spinner } from "@amira/tui-kit"
import type { TerminalStatus } from "../terminal-status.ts"
import type { TranscriptView } from "../view.ts"
import type { TurnActivity } from "./activity.ts"
import { createConversationEvents } from "./conversation-events.ts"
import type { NoticeStrip, Outbox } from "./outbox.ts"

/** Remote display shares the transcript renderer, but never performs host-side effects. */
export function createFrontendEvents(deps: {
  frontend: AgentPort
  view: TranscriptView
  activity: TurnActivity
  outbox: Outbox
  noticeStrip: NoticeStrip
  spinner: Spinner
  termStatus: TerminalStatus
  changed: () => void
}) {
  const { view, activity, outbox, spinner, termStatus } = deps
  const events = createConversationEvents(view, activity, deps.changed)
  return {
    onEvent(event: AnyEvent, context?: { replay: boolean }) {
      let renderedSteer = false
      switch (event.type) {
        case "turn.start":
          deps.noticeStrip.turnStarted(event.data.prompt)
          outbox.turnStarted(event.data.prompt, event.turnId)
          if (!context?.replay) termStatus.setRunning(true)
          break
        case "turn.end":
          outbox.clearSteering()
          if (!context?.replay) termStatus.setRunning(false, event.data.reason === "aborted")
          break
        case "turn.steer":
          if (!deps.noticeStrip.steer(event.data.message, event.data.state)) {
            outbox.steer(event.data.message, event.data.state, !!event.turnId, !context?.replay)
            renderedSteer = event.data.state === "injected" && !context?.replay
          }
          break
        case "notice.retry":
          deps.noticeStrip.setRetry(event.ts + event.data.delayMs)
          break
      }
      if (!renderedSteer) events.onEvent(event)
      if (activity.working || activity.compacting) spinner.start(deps.changed)
      else spinner.stop()
      if (event.type === "turn.end" && !context?.replay) outbox.turnEnded()
    },
    reset() {
      const messages = deps.frontend.snapshot.transcript.messages
      events.reset(
        messages.map((entry) => entry.message),
        messages.flatMap((entry) => (entry.turnId ? [entry.turnId] : [])),
      )
      if (["working", "blocked"].includes(deps.frontend.snapshot.state.status)) {
        activity.beginSend()
        spinner.start(deps.changed)
      } else spinner.stop()
    },
  }
}
