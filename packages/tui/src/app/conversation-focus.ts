import type { AnyEvent, EventMap, OwnedConversation } from "@amira/api"
import type { Editor, EditorPart } from "@amira/tui-kit"
import { truncateToWidth } from "@amira/tui-kit"
import { conversationScopeContains } from "../../../core/src/session-routing.ts"
import { restoreEditorState } from "../../../tui-kit/src/internal/editor-state.ts"
import { imageBytes, MAX_IMAGE_BYTES } from "../image-input.ts"
import { PromptHistory } from "../prompt-history.ts"
import type { TranscriptView } from "../view.ts"
import { createTurnActivity } from "./activity.ts"
import { createConversationEvents } from "./conversation-events.ts"
import { draftMessage, messageParts } from "./outbox.ts"

type Entry = {
  conversation: OwnedConversation
  view: TranscriptView
  activity: ReturnType<typeof createTurnActivity>
  history: PromptHistory
  draft: EditorPart[]
  iterator: AsyncIterator<AnyEvent>
  disposed: boolean
  sentContent?: string
}

interface FocusDeps {
  mode: "inline" | "fullscreen"
  editor: Editor
  mainView: TranscriptView
  mainHistory: PromptHistory
  mainId: () => string
  mainContainsSession: (id: string) => boolean
  mainWorking: () => boolean
  mainAttention?: () => number
  onMainFocused?: () => void
  interruptMain: () => void
  canFocus: () => boolean
  createView: (conversation: OwnedConversation) => TranscriptView
  activate: (entry: Entry | undefined) => void
  detachOverlays: () => void
  prepareOutgoing: () => void
  resetComposer: () => void
  showNote: (text: string) => void
  returnKey?: () => string
  syncDialogs: (requests: EventMap["ui.request"][]) => void
  request: (data: EventMap["ui.request"]) => void
  resolved: (data: EventMap["ui.resolved"]) => void
}

/** Native focus owns presentation only: neither returning nor changing focus stops work. */
export class ConversationFocus {
  private readonly entries = new Map<OwnedConversation, Entry>()
  private readonly released = new WeakSet<OwnedConversation>()
  private readonly requests = new Map<string, { sessionId: string; data: EventMap["ui.request"] }>()
  private current: Entry | undefined
  private mainDraft: EditorPart[] = []
  private pendingCommand: { entry: Entry; version: number; parts: EditorPart[] } | undefined
  private transitioning = false
  private disposed = false
  readonly history: PromptHistory

  constructor(private readonly deps: FocusDeps) {
    const self = this
    this.history = new (class extends PromptHistory {
      override get entries() {
        return (self.current?.history ?? deps.mainHistory).entries
      }
      override add(parts: EditorPart[]) {
        ;(self.current?.history ?? deps.mainHistory).add(parts)
      }
    })()
  }

  setTheme(...args: Parameters<TranscriptView["setTheme"]>) {
    this.deps.mainView.setTheme(...args)
    for (const entry of this.entries.values()) entry.view.setTheme(...args)
  }

  refresh() {
    this.current?.view.requestRender()
  }

  get conversation() {
    return this.current?.conversation
  }

  /** Main outbox recovery must never write into the owned composer while it is visible. */
  get mainEditor(): Pick<Editor, "getParts" | "setParts" | "isEmpty"> {
    const self = this
    return {
      getParts: () => (self.current ? self.mainDraft : self.deps.editor.getParts()),
      setParts(parts) {
        if (self.current) self.mainDraft = parts
        else self.deps.editor.setParts(parts)
      },
      get isEmpty() {
        return self.current ? self.empty(self.mainDraft) : self.deps.editor.isEmpty
      },
    }
  }

  private empty(parts: EditorPart[]) {
    return parts.every((part) => (typeof part === "string" ? !part : "paste" in part && !part.paste))
  }

  get busy(): boolean {
    const entry = this.current
    if (!entry) return false
    try {
      return entry.conversation.status().busy
    } catch {
      this.released.add(entry.conversation)
      this.unfocus()
      return false
    }
  }

  historySnapshot() {
    const entry = this.current
    if (!entry) return undefined
    try {
      return entry.conversation.history()
    } catch {
      this.released.add(entry.conversation)
      this.unfocus()
      return []
    }
  }

  get activity() {
    return this.current?.activity
  }

  private rootSession(sessionId: string): string {
    if (sessionId === "host" || sessionId === this.deps.mainId()) return this.deps.mainId()
    for (const entry of this.entries.values()) {
      if (conversationScopeContains(entry.conversation, sessionId)) return entry.conversation.id
    }
    return this.deps.mainContainsSession(sessionId) ? this.deps.mainId() : sessionId
  }

  get pendingMain() {
    return (
      [...this.requests.values()].filter((r) => this.rootSession(r.sessionId) === this.deps.mainId()).length +
      (this.deps.mainAttention?.() ?? 0)
    )
  }

  indicator(width: number): string | undefined {
    if (!this.current) return undefined
    const status = `main ${this.deps.mainWorking() ? "working" : "idle"}`
    const key = this.deps.returnKey?.() ?? "F6"
    const pending = this.pendingMain ? ` · ${this.pendingMain} pending · ${key} to answer` : ` · ${key} main`
    const tail = `${status}${pending}`
    const name = this.current.conversation.name.replace(/\p{Cc}/gu, " ")
    return truncateToWidth(
      `${truncateToWidth(name, Math.max(8, width - tail.length - 3), "…")} · ${tail}`,
      width,
      "…",
    )
  }

  focus = (conversation: OwnedConversation): boolean => {
    if (this.transitioning) return false
    this.transitioning = true
    try {
      return this.focusConversation(conversation)
    } finally {
      this.transitioning = false
    }
  }

  private focusConversation(conversation: OwnedConversation): boolean {
    if (this.disposed || this.released.has(conversation) || !this.deps.canFocus()) return false
    let entry = this.entries.get(conversation)
    if (entry) {
      try {
        conversation.status()
      } catch {
        this.released.add(conversation)
        if (this.current?.conversation === conversation) this.returnToMain()
        return false
      }
    }
    if (this.current?.conversation === conversation) return true
    let fresh = false
    let initialHistory: ReturnType<OwnedConversation["history"]> = []
    if (!entry) {
      // The iterator subscribes before either snapshot, so no new live event falls into the gap.
      const iterator = conversation.events[Symbol.asyncIterator]()
      try {
        const history = new PromptHistory()
        initialHistory = conversation.history()
        for (const message of initialHistory) {
          if (message.role === "user" && !message.display?.origin) history.add(messageParts(message))
        }
        const activity = createTurnActivity()
        if (conversation.status().busy) activity.beginSend()
        entry = {
          conversation,
          iterator,
          history,
          activity,
          view: this.deps.createView(conversation),
          draft: [],
          disposed: false,
        }
      } catch {
        void iterator.return?.()
        return false
      }
      this.entries.set(conversation, entry)
      fresh = true
    }
    this.saveDraft()
    this.deps.detachOverlays()
    if (this.disposed) return false
    ;(this.current?.view ?? this.deps.mainView).setVisible(false)
    this.current = entry
    this.pendingCommand = undefined
    this.deps.activate(entry)
    this.restoreDraft(entry.draft)
    if (fresh && this.deps.mode === "fullscreen") {
      entry.view.openSession({ id: conversation.id, resumed: true }, [...initialHistory], true)
    }
    entry.view.activate(`— ${conversation.name.replace(/\p{Cc}/gu, " ")} —`)
    if (fresh) {
      entry.view.start()
      void this.follow(entry)
    } else entry.view.setVisible(true)
    this.syncDialogs()
    entry.view.requestRender()
    return true
  }

  unfocus = (): boolean => {
    if (this.transitioning) return false
    this.transitioning = true
    try {
      return this.returnToMain()
    } finally {
      this.transitioning = false
    }
  }

  private returnToMain(): boolean {
    const outgoing = this.current
    if (!outgoing) return false
    const pending =
      this.pendingCommand?.entry === outgoing && this.pendingCommand.version === this.deps.editor.version
        ? this.pendingCommand
        : undefined
    this.saveDraft()
    this.deps.detachOverlays()
    if (this.disposed) return false
    outgoing.view.setVisible(false)
    if (pending && !this.mainDraft.length) outgoing.draft = []
    this.current = undefined
    this.deps.activate(undefined)
    const draft = this.mainDraft.length ? this.mainDraft : (pending?.parts ?? [])
    this.pendingCommand = undefined
    this.restoreDraft(draft)
    // The destination boundary precedes every held commit, without replaying history.
    this.deps.mainView.activate("— main —")
    this.deps.mainView.setVisible(true)
    this.syncDialogs()
    this.deps.mainView.requestRender()
    this.deps.onMainFocused?.()
    return true
  }

  private saveDraft() {
    this.deps.prepareOutgoing()
    if (this.current) this.current.draft = this.deps.editor.getParts()
    else this.mainDraft = this.deps.editor.getParts()
  }

  private restoreDraft(parts: EditorPart[]) {
    this.deps.resetComposer()
    const name = this.current?.conversation.name.replace(/\p{Cc}/gu, " ")
    restoreEditorState(this.deps.editor, parts, name ? `Message ${name}` : undefined)
  }

  guardCommand(line: string, parts: EditorPart[] = [line]): boolean {
    if (!this.current) return false
    this.deps.editor.setParts(parts)
    this.pendingCommand = {
      entry: this.current,
      version: this.deps.editor.version,
      parts: this.deps.editor.getParts(),
    }
    this.deps.showNote(
      `Return to main with ${this.deps.returnKey?.() ?? "F6"} to run slash commands or skills. Your input is kept.`,
    )
    return true
  }

  submit(text: string, parts: EditorPart[], display?: string): boolean {
    const entry = this.current
    if (!entry) return false
    if (text.trimStart().startsWith("/") || text.trimStart().startsWith("$"))
      return this.guardCommand(text, parts)
    if (this.busy) {
      this.deps.editor.setParts(parts)
      this.deps.showNote(
        "This conversation is working. Wait for it to finish or interrupt it before sending.",
      )
      return true
    }
    if (this.current !== entry) return true
    if (!text.trim() && !parts.some((p) => typeof p !== "string" && "image" in p)) return true
    if (imageBytes(parts) > MAX_IMAGE_BYTES) {
      this.deps.editor.setParts(parts)
      this.deps.showNote(
        "Images in a message are limited to 5 MB total. Remove an attachment or resize it first.",
      )
      return true
    }
    const message = draftMessage(text.trim(), display, parts)
    entry.history.add(parts)
    this.deps.editor.clear()
    this.deps.resetComposer()
    const body = message.content
      ? message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
      : message.text
    const images = message.content?.flatMap((b) => (b.type === "image" ? [b] : []))
    entry.sentContent = JSON.stringify([...(body ? [{ type: "text", text: body }] : []), ...(images ?? [])])
    void entry.conversation
      .send(body, {
        ...(images ? { images } : {}),
        ...(message.display ? { display: { text: message.display } } : {}),
      })
      .catch((error) => {
        entry.sentContent = undefined
        if (entry.disposed) return
        if (this.current === entry) {
          if (this.deps.editor.isEmpty) this.deps.editor.setParts(parts)
        } else if (this.empty(entry.draft)) entry.draft = parts
        entry.view.notice("error", error instanceof Error ? error.message : String(error))
        entry.view.requestRender()
      })
    return true
  }

  cancelApproval(sessionId?: string) {
    const root = this.rootSession(sessionId ?? "host")
    if (root === this.deps.mainId()) {
      if (this.deps.mainWorking()) this.deps.interruptMain()
      return
    }
    const entry = [...this.entries.values()].find((candidate) => candidate.conversation.id === root)
    if (entry) this.stopEntry(entry)
  }

  interrupt() {
    const entry = this.current
    if (entry) this.stopEntry(entry)
  }

  private stopEntry(entry: Entry) {
    void Promise.resolve()
      .then(() => entry.conversation.stop("Interrupted from composer"))
      .catch((error) => {
        entry.view.notice("error", String(error))
        entry.view.requestRender()
      })
  }

  /** Host UI requests default to main; owner callbacks explicitly supply their sessionId. */
  onUiEvent(event: AnyEvent): boolean {
    if (event.type === "ui.request") {
      const association = event.data.sessionId ?? event.sessionId
      const sessionId = this.rootSession(association)
      this.requests.set(event.data.requestId, {
        sessionId: association === "host" ? this.deps.mainId() : association,
        data: event.data,
      })
      if (sessionId === (this.current?.conversation.id ?? this.deps.mainId())) this.deps.request(event.data)
      else if (this.current && sessionId === this.deps.mainId())
        this.deps.showNote(`Main needs an answer. Press ${this.deps.returnKey?.() ?? "F6"} to return.`)
    } else if (event.type === "ui.resolved") {
      this.requests.delete(event.data.requestId)
      this.deps.resolved(event.data)
    } else return false
    ;(this.current?.view ?? this.deps.mainView).requestRender()
    return true
  }

  private syncDialogs() {
    const id = this.current?.conversation.id ?? this.deps.mainId()
    this.deps.syncDialogs(
      [...this.requests.values()].filter((r) => this.rootSession(r.sessionId) === id).map((r) => r.data),
    )
  }

  private async follow(entry: Entry) {
    const renderer = createConversationEvents(entry.view, entry.activity, () => {
      if (this.current === entry) entry.view.requestRender()
    })
    let seq = -1
    try {
      while (!entry.disposed) {
        const next = await entry.iterator.next()
        if (next.done) break
        const event = next.value
        if (event.seq <= seq) continue
        seq = event.seq
        if (this.onUiEvent(event)) continue
        if (event.type === "events.lost") {
          if (this.deps.mode === "fullscreen")
            entry.view.openSession(
              { id: entry.conversation.id, resumed: true },
              [...entry.conversation.history()],
              true,
            )
          renderer.reset(entry.conversation.history())
          if (entry.conversation.status().busy) entry.activity.beginSend()
          entry.view.notice("warning", "Live events were lost; conversation history refreshed.")
        } else if (event.sessionId === entry.conversation.id) {
          if (event.type === "turn.start" && !event.data.prompt.display?.origin) {
            if (JSON.stringify(event.data.prompt.content) !== entry.sentContent)
              entry.history.add(messageParts(event.data.prompt))
            entry.sentContent = undefined
          }
          renderer.onEvent(event)
        } else if (entry.view.subagentEvent(event)) entry.view.requestRender()
      }
    } catch (error) {
      entry.view.notice("error", String(error))
    } finally {
      if (this.current === entry) this.unfocus()
      this.released.add(entry.conversation)
      this.entries.delete(entry.conversation)
      entry.disposed = true
      entry.view.stop()
    }
  }

  dispose() {
    if (this.disposed) return
    if (!this.transitioning) this.unfocus()
    this.disposed = true
    this.current = undefined
    this.pendingCommand = undefined
    this.deps.activate(undefined)
    this.deps.mainView.setVisible(true)
    for (const entry of this.entries.values()) {
      entry.disposed = true
      void entry.iterator.return?.()
      entry.view.setVisible(false)
      entry.view.stop()
    }
    this.entries.clear()
  }
}
