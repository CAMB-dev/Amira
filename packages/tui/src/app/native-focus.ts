import type { Agent, AgentPort, CommandRunOptions, UiRequests } from "@amira/core"
import type { Editor } from "@amira/tui-kit"
import { registerCommandViewContext } from "../../../core/src/command-view-context.ts"
import { sessionScopeContains } from "../../../core/src/session-routing.ts"
import { onUiRequestCreated, uiRequestOwner } from "../../../core/src/ui-request-capture.ts"
import { discardPendingPaste } from "../../../tui-kit/src/input-paste-control.ts"
import type { Keybindings } from "../keybindings.ts"
import type { PromptHistory } from "../prompt-history.ts"
import type { TranscriptView, ViewHost } from "../view.ts"
import type { TurnActivity } from "./activity.ts"
import type { Composer } from "./composer.ts"
import { ConversationFocus } from "./conversation-focus.ts"
import type { OverlayManager } from "./overlays.ts"

/** History navigation retains a stable source while the selected conversation changes. */
export function focusHistory(main: PromptHistory, focus: () => ConversationFocus): PromptHistory {
  return new Proxy(main, {
    get: (_target, property) => {
      const history = focus().history
      const value = Reflect.get(history, property, history)
      return typeof value === "function" ? value.bind(history) : value
    },
  })
}

/** Wires native focus without making the app controller own transcript-switch lifecycle. */
export function createNativeFocus(deps: {
  editor: Editor
  mainView: TranscriptView
  mainHistory: PromptHistory
  agent: () => Agent
  port?: AgentPort
  ui?: UiRequests
  activity: TurnActivity
  interruptMain: (turnId?: string) => void
  mainAttention?: () => number
  onMainFocused?: () => void
  host: ViewHost
  makeView: (host: ViewHost) => TranscriptView
  activate: (view: TranscriptView) => void
  composer: Composer
  overlays: OverlayManager
  keys: Keybindings
  showNote: (text: string) => void
  quitting: () => boolean
}) {
  const { overlays, composer } = deps
  const focus = new ConversationFocus({
    port: deps.port,
    editor: deps.editor,
    mainView: deps.mainView,
    mainHistory: deps.mainHistory,
    mainId: () => deps.agent().sessionId,
    mainContainsSession: (id) => sessionScopeContains(deps.agent().tree, id, deps.agent().sessionId),
    mainWorking: () => deps.activity.working || deps.activity.compacting,
    mainTurnId: () => deps.agent().turnId,
    requireApprovalOwner: true,
    approvalOwner: (requestId) => deps.ui && uiRequestOwner(deps.ui, requestId),
    mainAttention: deps.mainAttention,
    onMainFocused: deps.onMainFocused,
    interruptMain: deps.interruptMain,
    canFocus: () => !deps.quitting() && !overlays.hasFullscreen && !overlays.dock && !overlays.dialogs.length,
    createView: (conversation) => deps.makeView({ ...deps.host, sessionId: () => conversation.id }),
    activate: (entry) => deps.activate(entry?.view ?? deps.mainView),
    detachOverlays: () => overlays.detachConversation(),
    returnKey: () => deps.keys.label("view.focus") ?? "F6",
    prepareOutgoing: () => {
      discardPendingPaste(deps.host.terminal)
      composer.search.cancel()
    },
    resetComposer: () => {
      composer.cancelClipboard()
      composer.search.cancel()
      composer.resetHistory()
      for (const popup of composer.popups) popup.update("")
      composer.filePicker.update("")
    },
    showNote: deps.showNote,
    syncDialogs: (requests) => {
      overlays.dialogs.splice(0)
      for (const request of requests) overlays.onUiRequest(request)
      overlays.waitingChanged("visibility")
    },
    request: (data) => overlays.onUiRequest(data),
    resolved: (data) => overlays.onUiResolved(data),
  })
  const openView = registerCommandViewContext(
    (view) => overlays.openView(view),
    (currentRoot) => {
      const origin = focus.conversation
      return (view) => {
        if (!currentRoot() || deps.quitting() || focus.conversation !== origin) return false
        if (origin) {
          try {
            origin.status()
          } catch {
            return false
          }
        }
        return overlays.openView(view)
      }
    },
  )
  const commandContext = (): Pick<
    CommandRunOptions,
    "isFrontendCurrent" | "openView" | "focusConversation" | "unfocusConversation"
  > => {
    let owner = focus.conversation
    const current = () => !deps.quitting() && owner === focus.conversation
    const open = (view: Parameters<OverlayManager["openView"]>[0]) => {
      if (!current()) return false
      try {
        focus.conversation?.status()
      } catch {
        return false
      }
      return overlays.openView(view)
    }
    return {
      isFrontendCurrent: current,
      openView: registerCommandViewContext(open, (rootCurrent) => (view) => rootCurrent() && open(view)),
      focusConversation: (conversation) => {
        if (!current()) return false
        const changed = focus.focus(conversation)
        if (changed) owner = focus.conversation
        return changed
      },
      unfocusConversation: () => {
        if (!current()) return false
        const changed = focus.unfocus()
        if (changed) owner = focus.conversation
        return changed
      },
    }
  }
  const offRequests = deps.ui
    ? onUiRequestCreated(deps.ui, (request) => focus.captureApprovalRequest(request))
    : undefined
  const dispose = focus.dispose.bind(focus)
  return Object.assign(focus, {
    openView,
    commandContext,
    dispose() {
      offRequests?.()
      dispose()
    },
  })
}
