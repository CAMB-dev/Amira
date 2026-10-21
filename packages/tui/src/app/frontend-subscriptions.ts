import type { AnyEvent } from "@amira/api"
import type { Agent, AgentPort } from "@amira/core"
import type { TranscriptView } from "../view.ts"
import type { createFrontendFocus } from "./frontend-focus.ts"
import { createSessionDisplay } from "./session-display.ts"
import type { InteractiveOptions } from "./startup.ts"

/** Owns transport/display subscriptions, including finite non-replayed frontend effects. */
export function subscribeFrontend(
  opts: InteractiveOptions & { frontend: AgentPort },
  deps: {
    agent?: Agent
    view: TranscriptView
    activeView?: () => TranscriptView
    focus: ReturnType<typeof createFrontendFocus>
    onEvent: (event: AnyEvent, context?: { replay: boolean }) => void
    reset: () => void
    quitting: () => boolean
    quit: () => void
    rewind: () => boolean
  },
) {
  const sessions = createSessionDisplay(opts.frontend, deps.view, { follow: !deps.agent, reset: deps.reset })
  const offEvents = opts.frontend.subscribeEvents?.(deps.onEvent) ?? deps.agent?.bus.subscribe(deps.onEvent)
  let reported: string | undefined
  const connectionChanged = () => {
    const issue = opts.frontend.connectionIssue
    const fingerprint = issue && JSON.stringify([issue.code, issue.message, issue.recovery])
    if (issue && fingerprint !== reported) {
      const view = deps.activeView?.() ?? deps.view
      view.notice(issue.retryable ? "warning" : "error", `${issue.message}\n${issue.recovery}`)
      view.requestRender()
    }
    reported = fingerprint
    deps.view.requestRender()
  }
  const offConnection = opts.frontend.subscribeConnection?.(connectionChanged)
  connectionChanged()
  const offEffects = opts.subscribeFrontendEffects?.((effect) => {
    if (deps.quitting()) return
    switch (effect.kind) {
      case "detach":
        deps.quit()
        break
      case "rewind":
        deps.rewind()
        break
      case "unfocus":
        deps.focus.unfocus()
        break
      case "focus":
        void deps.focus.focusReference(effect)
        break
      case "view":
        deps.focus.openView({
          kind: effect.view,
          data: effect.view === "subagent" ? { sessionId: effect.id } : { id: effect.id },
        })
        break
    }
  })
  return {
    sessions,
    off() {
      offEvents?.()
      offConnection?.()
      offEffects?.()
    },
  }
}
