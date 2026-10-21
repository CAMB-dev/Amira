import type { AnyEvent, Message } from "@amira/api"
import { type AgentPort, frontendIdentity } from "@amira/core"
import { type Editor, type EditorPart, truncateToWidth } from "@amira/tui-kit"
import { restoreEditorState } from "../../../tui-kit/src/internal/editor-state.ts"
import { imageBytes, MAX_IMAGE_BYTES } from "../image-input.ts"
import type { PromptHistory } from "../prompt-history.ts"
import { PromptHistory as History } from "../prompt-history.ts"
import type { TranscriptView } from "../view.ts"
import { createTurnActivity } from "./activity.ts"
import { createConversationEvents } from "./conversation-events.ts"
import type { createNativeFocus } from "./native-focus.ts"
import { draftMessage, messageParts } from "./outbox.ts"
import type { OverlayManager } from "./overlays.ts"

export interface FrontendConversationRef {
  readonly conversationId: string
  readonly incarnation: string
}
export interface FrontendConversationSnapshot extends FrontendConversationRef {
  readonly name: string
  readonly cwd: string
  readonly messages: readonly Message[]
  readonly busy: boolean
  readonly turnId?: string
  readonly acceptsImages?: boolean
  readonly activity?: readonly AnyEvent[]
  /** Host-proven prompt turns already included in messages at the same history cut. */
  readonly renderedTurnIds?: readonly string[]
}
export type FrontendConversationUpdate =
  | { readonly kind: "snapshot"; readonly snapshot: FrontendConversationSnapshot }
  | { readonly kind: "event"; readonly event: AnyEvent }
export interface FrontendConversationSource {
  /** Authoritative ancestry, including descendants retained across snapshot restore. */
  containsSession?(root: string, sessionId: string): boolean
  /** Subscribe before reading. Events delivered after snapshot must be past its replay watermark. */
  open(
    ref: FrontendConversationRef,
    listener: (update: FrontendConversationUpdate) => void,
  ): Promise<{
    readonly snapshot: FrontendConversationSnapshot
    dispose(): void
  }>
}

type NativeFocus = ReturnType<typeof createNativeFocus>
type Focused = {
  conversation: { id: string; name: string; cwd: string }
  snapshot: FrontendConversationSnapshot
  view: TranscriptView
  activity: ReturnType<typeof createTurnActivity>
  history: PromptHistory
  receipt?: { turnId: string; reconciled: boolean }
  dispose(): void
  events: ReturnType<typeof createConversationEvents>
  sending: boolean
}

/** Presentation and control over DTOs; no Agent, tool registry or executable remote handles. */
export function createFrontendFocus(
  native: NativeFocus,
  deps: {
    source?: FrontendConversationSource
    port: AgentPort
    editor: Editor
    mainView: TranscriptView
    createView: (id: string) => TranscriptView
    activate: (view: TranscriptView) => void
    prepare: () => void
    overlays: Pick<OverlayManager, "detachConversation" | "onUiRequest" | "onUiResolved">
    showNote: (text: string) => void
    returnKey: () => string
    canFocus: () => boolean
  },
) {
  let current: Focused | undefined
  let mainDraft: EditorPart[] = []
  const drafts = new Map<string, EditorPart[]>()
  let version = 0
  let disposed = false
  type PendingRequest = { event: Extract<AnyEvent, { type: "ui.request" }>; scope?: FrontendConversationRef }
  const requests = new Map<string, PendingRequest>()
  function belongsTo(request: PendingRequest, root: string) {
    if (request.scope)
      return (
        request.scope.conversationId === root && request.scope.incarnation === current?.snapshot.incarnation
      )
    const sessionId = request.event.data.sessionId ?? request.event.sessionId
    const id = sessionId === "host" ? deps.port.snapshot.state.sessionId : sessionId
    return id === root || deps.source?.containsSession?.(root, id) === true
  }
  function syncRequests() {
    const id = current?.snapshot.conversationId ?? deps.port.snapshot.state.sessionId
    for (const request of requests.values())
      if (belongsTo(request, id)) deps.overlays.onUiRequest(request.event.data, { replay: true })
  }
  function routeUiEvent(event: AnyEvent, context?: { replay: boolean }, scope?: FrontendConversationRef) {
    if (!deps.source) return native.onUiEvent(event)
    if (event.type === "ui.request") {
      const request = { event, scope: scope ?? requests.get(event.data.requestId)?.scope }
      requests.set(event.data.requestId, request)
      const id = current?.snapshot.conversationId ?? deps.port.snapshot.state.sessionId
      if (belongsTo(request, id)) deps.overlays.onUiRequest(event.data, { replay: context?.replay })
      else if (current && belongsTo(request, deps.port.snapshot.state.sessionId))
        deps.showNote(`Main needs an answer. Press ${deps.returnKey()} to return.`)
    } else if (event.type === "ui.resolved") {
      requests.delete(event.data.requestId)
      deps.overlays.onUiResolved(event.data)
    } else return false
    return true
  }
  function onUiEvent(event: AnyEvent, context?: { replay: boolean }) {
    return routeUiEvent(event, context)
  }
  const history = new Proxy(native.history, {
    get(target, property) {
      const source = current?.history ?? target
      const value = Reflect.get(source, property, source)
      return typeof value === "function" ? value.bind(source) : value
    },
  })
  function unfocus() {
    version++
    if (!current) return native.unfocus()
    deps.prepare()
    deps.overlays.detachConversation()
    const outgoing = current
    drafts.set(outgoing.snapshot.incarnation, deps.editor.getParts())
    current = undefined
    outgoing.dispose()
    outgoing.view.setVisible(false)
    outgoing.view.stop()
    deps.activate(deps.mainView)
    restoreEditorState(deps.editor, mainDraft)
    deps.mainView.activate("— main —")
    deps.mainView.setVisible(true)
    syncRequests()
    return true
  }
  async function focusReference(ref: FrontendConversationRef) {
    if (disposed || !deps.canFocus()) return false
    if (!deps.source) {
      deps.showNote("The live conversation view is unavailable.")
      return false
    }
    const request = ++version
    const generation = frontendIdentity(deps.port).sessionGeneration
    const buffered: FrontendConversationUpdate[] = []
    let entry: Focused | undefined
    const apply = (update: FrontendConversationUpdate) => {
      if (!entry) {
        buffered.push(update)
        return
      }
      if (current !== entry || disposed) return
      if (update.kind === "snapshot") {
        entry.snapshot = update.snapshot
        entry.view.openSession({ id: ref.conversationId, resumed: true }, [...update.snapshot.messages], true)
        entry.events.reset(update.snapshot.messages, update.snapshot.renderedTurnIds)
        for (const event of update.snapshot.activity ?? []) {
          if (routeUiEvent(event, { replay: true }, ref)) continue
          if (event.sessionId === ref.conversationId) entry.events.onEvent(event)
          else if (entry.view.subagentEvent(event)) entry.view.requestRender()
        }
      } else {
        const event = update.event
        // The source scopes descendants, but only the owned root drives this transcript.
        if (routeUiEvent(event, undefined, ref)) return
        if (event.sessionId !== ref.conversationId) {
          if (entry.view.subagentEvent(event)) entry.view.requestRender()
          return
        }
        if (event.type === "turn.start") {
          if (entry.receipt && entry.receipt.turnId === event.turnId) entry.receipt.reconciled = true
          entry.snapshot = {
            ...entry.snapshot,
            busy: true,
            turnId: event.turnId,
            messages: [...entry.snapshot.messages, event.data.prompt],
          }
        }
        if (event.type === "message.end")
          entry.snapshot = { ...entry.snapshot, messages: [...entry.snapshot.messages, event.data.message] }
        if (event.type === "turn.end") {
          if (entry.receipt && entry.receipt.turnId === event.turnId) {
            entry.receipt.reconciled = true
            entry.sending = false
          }
          entry.snapshot = { ...entry.snapshot, busy: false, turnId: undefined }
        }
        entry.events.onEvent(event)
      }
    }
    let watch: Awaited<ReturnType<FrontendConversationSource["open"]>>
    try {
      watch = await deps.source.open(ref, apply)
    } catch (error) {
      if (request === version && !disposed)
        deps.showNote(error instanceof Error ? error.message : String(error))
      return false
    }
    if (
      disposed ||
      request !== version ||
      generation !== frontendIdentity(deps.port).sessionGeneration ||
      !deps.canFocus()
    ) {
      watch.dispose()
      return false
    }
    deps.prepare()
    deps.overlays.detachConversation()
    if (!current) mainDraft = deps.editor.getParts()
    else {
      drafts.set(current.snapshot.incarnation, deps.editor.getParts())
      current.dispose()
      current.view.setVisible(false)
      current.view.stop()
    }
    native.unfocus()
    deps.mainView.setVisible(false)
    const view = deps.createView(ref.conversationId)
    const activity = createTurnActivity()
    const events = createConversationEvents(view, activity, () => view.requestRender())
    const promptHistory = new History()
    for (const message of watch.snapshot.messages)
      if (message.role === "user" && !message.display?.origin) promptHistory.add(messageParts(message))
    entry = {
      conversation: { id: ref.conversationId, name: watch.snapshot.name, cwd: watch.snapshot.cwd },
      snapshot: watch.snapshot,
      view,
      activity,
      history: promptHistory,
      dispose: () => watch.dispose(),
      events,
      sending: false,
    }
    current = entry
    deps.activate(view)
    restoreEditorState(deps.editor, drafts.get(ref.incarnation) ?? [], `Message ${watch.snapshot.name}`)
    apply({ kind: "snapshot", snapshot: watch.snapshot })
    if (watch.snapshot.busy && !activity.working) activity.beginSend()
    for (const update of buffered.splice(0)) apply(update)
    syncRequests()
    view.start()
    return true
  }
  function guardCommand(line: string, parts: EditorPart[] = [line]) {
    if (!current) return native.guardCommand(line, parts)
    deps.editor.setParts(parts)
    deps.showNote(
      `Return to main with ${deps.returnKey()} to run slash commands or skills. Your input is kept.`,
    )
    return true
  }
  function submit(text: string, parts: EditorPart[], display?: string) {
    const entry = current
    if (!entry) return native.submit(text, parts, display)
    if (/^\s*[$/]/.test(text)) return guardCommand(text, parts)
    if (entry.snapshot.busy || entry.sending) {
      deps.editor.setParts(parts)
      deps.showNote("This conversation is working. Wait for it to finish or interrupt it before sending.")
      return true
    }
    const hasImages = parts.some((part) => typeof part !== "string" && "image" in part)
    if (hasImages && (imageBytes(parts) > MAX_IMAGE_BYTES || !entry.snapshot.acceptsImages)) {
      deps.editor.setParts(parts)
      deps.showNote(
        imageBytes(parts) > MAX_IMAGE_BYTES
          ? "Images in a message are limited to 5 MB total. Remove an attachment or resize it first."
          : "This conversation does not support images. Remove the attachments before sending.",
      )
      return true
    }
    const message = draftMessage(text.trim(), display, parts)
    if (!message.text && !message.content?.length) return true
    const receipt = { turnId: crypto.randomUUID(), reconciled: false }
    entry.receipt = receipt
    entry.sending = true
    entry.history.add(parts)
    deps.editor.clear()
    void deps.port
      .execute(
        "conversation.send",
        {
          conversationId: entry.snapshot.conversationId,
          incarnation: entry.snapshot.incarnation,
          turnId: receipt.turnId,
          message: {
            role: "user",
            content: message.content ?? [{ type: "text", text: message.text }],
            ...(message.display ? { display: { text: message.display } } : {}),
          },
        },
        { sessionGeneration: frontendIdentity(deps.port).sessionGeneration },
      )
      .catch((error) => {
        if (current !== entry || disposed || receipt.reconciled) return
        deps.editor.setParts(deps.editor.isEmpty ? parts : [...parts, "\n\n", ...deps.editor.getParts()])
        entry.view.notice("error", error instanceof Error ? error.message : String(error))
        entry.view.requestRender()
      })
      .finally(() => {
        if (entry.receipt === receipt) entry.sending = false
      })
    return true
  }
  const overrides = {
    history,
    focusReference,
    onUiEvent,
    commandContext() {
      if (!deps.source) return native.commandContext()
      const origin = current
      const generation = frontendIdentity(deps.port).sessionGeneration
      const context = native.commandContext()
      const valid = () =>
        !disposed &&
        current === origin &&
        frontendIdentity(deps.port).sessionGeneration === generation &&
        context.isFrontendCurrent!()
      return {
        ...context,
        isFrontendCurrent: valid,
        openView: (view: Parameters<NativeFocus["openView"]>[0]) => valid() && context.openView!(view),
      }
    },
    get conversation() {
      return current?.conversation ?? native.conversation
    },
    get activity() {
      return current?.activity ?? native.activity
    },
    get busy() {
      return current ? current.snapshot.busy || current.sending : native.busy
    },
    mainEditor: {
      getParts: () => (current ? mainDraft : native.mainEditor.getParts()),
      setParts: (parts: EditorPart[]) => {
        if (current) mainDraft = parts
        else native.mainEditor.setParts(parts)
      },
      get isEmpty() {
        return current
          ? !mainDraft.some((part) => typeof part !== "string" || part.trim())
          : native.mainEditor.isEmpty
      },
    },
    historySnapshot: () => current?.snapshot.messages ?? native.historySnapshot(),
    indicator: (width: number) =>
      current
        ? truncateToWidth(
            `${current.snapshot.name.replace(/\p{Cc}/gu, " ")} · ${deps.returnKey()} main`,
            width,
            "…",
          )
        : native.indicator(width),
    guardCommand,
    submit,
    unfocus,
    interrupt() {
      if (!current) return native.interrupt()
      const entry = current
      if (!entry.snapshot.turnId) return
      void deps.port
        .execute(
          "conversation.stop",
          {
            conversationId: entry.snapshot.conversationId,
            incarnation: entry.snapshot.incarnation,
            expectedTurnId: entry.snapshot.turnId,
          },
          { sessionGeneration: frontendIdentity(deps.port).sessionGeneration },
        )
        .catch((error) => {
          if (current === entry && !disposed)
            deps.showNote(error instanceof Error ? error.message : String(error))
        })
    },
    dispose() {
      disposed = true
      unfocus()
      native.dispose()
    },
    setTheme(...args: Parameters<NativeFocus["setTheme"]>) {
      native.setTheme(...args)
      current?.view.setTheme(...args)
    },
  }
  return new Proxy(native, {
    get(target, property) {
      if (property in overrides) return Reflect.get(overrides, property, overrides)
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as unknown as Omit<NativeFocus, keyof typeof overrides> & typeof overrides
}
