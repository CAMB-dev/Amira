import type { AnyEvent, EventMap, OwnedConversation } from "@amira/api"
import {
  conversationHoldId,
  conversationIncarnation,
  conversationScopeContains,
  conversationTurnId,
  sendConversation,
} from "@amira/host/internal"
import {
  bold,
  type Editor,
  type EditorPart,
  inverse,
  type RenderContext,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import { restoreEditorState } from "../../../tui-kit/src/internal/editor-state.ts"
import { asciiGlyphs, chromeText, glyphs, viewEllipsis } from "../glyphs.ts"
import { imageBytes, MAX_IMAGE_BYTES } from "../image-input.ts"
import { PromptHistory } from "../prompt-history.ts"
import { badgeSymbol, spinnerFrameAt } from "../status-badge.ts"
import type { TranscriptView } from "../view.ts"
import { createTurnActivity } from "./activity.ts"
import { createConversationEvents } from "./conversation-events.ts"
import { draftMessage, messageParts, type Outgoing } from "./outbox.ts"

export type ConversationTabTarget = "main" | OwnedConversation

export interface ConversationBarHit {
  x: number
  width: number
  target: ConversationTabTarget
}

export interface ConversationBarRender {
  line: string
  hits: ConversationBarHit[]
}

type Entry = {
  conversation: OwnedConversation
  incarnation: string
  view: TranscriptView
  activity: ReturnType<typeof createTurnActivity>
  history: PromptHistory
  draft: EditorPart[]
  queued: Outgoing[]
  iterator: AsyncIterator<AnyEvent>
  disposed: boolean
  send?: { turnId: string; reconciled: boolean }
  sending?: boolean
  turnId?: string
}

interface FocusDeps {
  editor: Editor
  mainView: TranscriptView
  mainHistory: PromptHistory
  mainId: () => string
  mainContainsSession: (id: string) => boolean
  mainWorking: () => boolean
  mainTurnId?: () => string | undefined
  requireApprovalOwner?: boolean
  approvalOwner?: (
    requestId: string,
  ) =>
    | { readonly sessionId: string; readonly turnId?: string; readonly conversationIncarnation?: string }
    | undefined
  mainAttention?: () => number
  onMainFocused?: () => void
  interruptMain: (turnId?: string) => void
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
  private readonly requests = new Map<
    string,
    { sessionId: string; data: EventMap["ui.request"]; cancelApproval?: () => void }
  >()
  private current: Entry | undefined
  private lastEntry: Entry | undefined
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
      return entry.sending === true || entry.conversation.status().busy
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

  get queued(): readonly Outgoing[] {
    return this.current?.queued ?? []
  }

  get activeCount(): number {
    let count = 0
    for (const entry of this.entries.values()) if (!entry.disposed) count++
    return count
  }

  private pendingFor(conversationId: string): number {
    return [...this.requests.values()].filter((r) => this.rootSession(r.sessionId) === conversationId).length
  }

  private entryWorking(entry: Entry): boolean {
    if (entry.sending) return true
    try {
      return entry.conversation.status().busy
    } catch {
      return false
    }
  }

  private putBackTo(entry: Entry, items: Outgoing[]) {
    if (!items.length) return
    const parts: EditorPart[] = []
    for (const q of items) {
      if (parts.length) parts.push("\n\n")
      parts.push(...(q.parts ?? [q.text]))
    }
    if (this.current === entry) {
      if (!this.deps.editor.isEmpty) parts.push("\n\n", ...this.deps.editor.getParts())
      this.deps.editor.setParts(parts)
    } else {
      if (!this.empty(entry.draft)) parts.push("\n\n", ...entry.draft)
      entry.draft = parts
    }
  }

  popQueuedToEditor(index?: number): boolean {
    const entry = this.current
    if (!entry?.queued.length) return false
    const at = index === undefined ? entry.queued.length - 1 : index
    if (at < 0 || at >= entry.queued.length) return false
    const [item] = entry.queued.splice(at, 1)
    if (!item) return false
    this.putBackTo(entry, [item])
    entry.view.requestRender()
    return true
  }

  removeQueued(index: number): boolean {
    const entry = this.current
    if (!entry || index < 0 || index >= entry.queued.length) return false
    entry.queued.splice(index, 1)
    entry.view.requestRender()
    return true
  }

  selectTab(target: ConversationTabTarget): boolean {
    if (target === "main") return this.unfocus()
    return this.focus(target)
  }

  refocusLast(): boolean {
    if (this.current) return false
    const candidate =
      this.lastEntry && !this.lastEntry.disposed && this.entries.has(this.lastEntry.conversation)
        ? this.lastEntry
        : [...this.entries.values()].find((entry) => !entry.disposed)
    return candidate ? this.focus(candidate.conversation) : false
  }

  /** Clickable conversation switcher bar above the composer (shown when focused or when live owned conversations exist). */
  renderBar(width: number, ctx: RenderContext): ConversationBarRender | undefined {
    const { theme } = ctx
    const key = this.deps.returnKey?.() ?? "F6"
    const sep = ` ${glyphs.separator} `
    const frame = spinnerFrameAt(Date.now())
    if (this.current) {
      const status = `main ${this.deps.mainWorking() ? "working" : "idle"}`
      const pending = this.pendingMain
        ? `${sep}${this.pendingMain} pending${sep}${key} to answer`
        : `${sep}${key} main`
      const tailRaw = chromeText(`${status}${pending}`)
      const tailStyled = this.pendingMain ? bold(theme.warning(tailRaw)) : theme.fg2(tailRaw)
      const activeName = this.current.conversation.name.replace(/\p{Cc}/gu, " ")
      const others = [...this.entries.values()].filter((e) => !e.disposed && e !== this.current)
      const tailW = visibleWidth(tailRaw)
      const nameRoom = Math.max(8, width - tailW - visibleWidth(sep))
      const cutName = chromeText(truncateToWidth(activeName, nameRoom, viewEllipsis("…")))
      const hits: ConversationBarHit[] = []
      let line = bold(theme.accent(cutName))
      let cursor = visibleWidth(cutName)

      // Append other live conversations as clickable pills when horizontal space permits.
      for (const other of others) {
        const label = other.conversation.name.replace(/\p{Cc}/gu, " ")
        const wait = this.pendingFor(other.conversation.id)
        const icon = this.entryWorking(other)
          ? badgeSymbol("working", frame)
          : wait > 0
            ? glyphs.warning
            : asciiGlyphs()
              ? "*"
              : glyphs.info
        const raw = `[ ${icon} ${truncateToWidth(label, 18, viewEllipsis("…"))}${wait ? ` (${wait})` : ""} ]`
        const w = visibleWidth(raw)
        if (cursor + 2 + w + visibleWidth(sep) + tailW > width) break
        line += `  ${wait ? theme.warning(raw) : theme.muted(raw)}`
        hits.push({ x: cursor + 2, width: w, target: other.conversation })
        cursor += 2 + w
      }

      const tailX = cursor + visibleWidth(sep)
      line += theme.muted(sep) + tailStyled
      hits.push({ x: tailX, width: Math.max(1, Math.min(tailW, width - tailX)), target: "main" })
      return { line: truncateToWidth(line, width, viewEllipsis("…")), hits }
    }

    const live = [...this.entries.values()].filter((e) => !e.disposed)
    if (!live.length) return undefined
    const hits: ConversationBarHit[] = []
    const mainRaw = "[ main ]"
    let line = ctx.color ? inverse(bold(theme.accent(mainRaw))) : bold(theme.accent(mainRaw))
    let cursor = visibleWidth(mainRaw)
    for (const entry of live) {
      const label = entry.conversation.name.replace(/\p{Cc}/gu, " ")
      const working = this.entryWorking(entry)
      const wait = this.pendingFor(entry.conversation.id)
      const qCount = entry.queued.length
      const icon = working
        ? badgeSymbol("working", frame)
        : wait > 0
          ? glyphs.warning
          : asciiGlyphs()
            ? "*"
            : glyphs.info
      const badge = wait > 0 ? ` ${wait} waiting` : qCount > 0 ? ` ${qCount}q` : ""
      const raw = `[ ${icon} ${truncateToWidth(label, 22, viewEllipsis("…"))}${badge} ]`
      const w = visibleWidth(raw)
      if (cursor + 2 + w > width) break
      const styled = wait > 0 ? bold(theme.warning(raw)) : working ? theme.accent(raw) : theme.fg2(raw)
      line += `  ${styled}`
      hits.push({ x: cursor + 2, width: w, target: entry.conversation })
      cursor += 2 + w
    }
    const hint = `  ${key} switch`
    if (cursor + visibleWidth(hint) <= width) line += theme.muted(hint)
    return { line: truncateToWidth(line, width, viewEllipsis("…")), hits }
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
      chromeText(
        `${truncateToWidth(name, Math.max(8, width - tail.length - 3), viewEllipsis("…"))} · ${tail}`,
      ),
      width,
      viewEllipsis("…"),
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
        const view = this.deps.createView(conversation)
        entry = {
          conversation,
          incarnation: conversationIncarnation(conversation),
          iterator,
          history,
          activity,
          view,
          draft: [],
          queued: [],
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
    this.lastEntry = entry
    this.pendingCommand = undefined
    this.deps.activate(entry)
    this.restoreDraft(entry.draft)
    if (fresh) {
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
    this.lastEntry = outgoing
    this.deps.activate(undefined)
    const draft = this.mainDraft.length ? this.mainDraft : (pending?.parts ?? [])
    this.pendingCommand = undefined
    this.restoreDraft(draft)
    // Retained conversations show destination chrome without replaying history.
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
    if (this.current !== entry) return true
    if (!text.trim() && !parts.some((p) => typeof p !== "string" && "image" in p)) return true
    if (imageBytes(parts) > MAX_IMAGE_BYTES) {
      this.deps.editor.setParts(parts)
      this.deps.showNote(
        "Images in a message are limited to 5 MB total. Remove an attachment or resize it first.",
      )
      return true
    }
    const message: Outgoing = { ...draftMessage(text.trim(), display, parts), parts }
    entry.history.add(parts)
    this.deps.editor.clear()
    this.deps.resetComposer()
    if (this.busy) {
      entry.queued.push(message)
      entry.view.requestRender()
      return true
    }
    this.dispatchEntryMessage(entry, message, parts)
    return true
  }

  private dispatchEntryMessage(entry: Entry, message: Outgoing, parts: EditorPart[]) {
    const body = message.content
      ? message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
      : message.text
    const images = message.content?.flatMap((b) => (b.type === "image" ? [b] : []))
    const receipt = { turnId: crypto.randomUUID(), reconciled: false }
    entry.send = receipt
    entry.sending = true
    const options = {
      ...(images ? { images } : {}),
      ...(message.display ? { display: { text: message.display } } : {}),
    }
    void Promise.resolve()
      .then(async () => {
        await sendConversation(entry.conversation, body, options, receipt.turnId)
      })
      .catch((error) => {
        if (entry.disposed || receipt.reconciled) return
        if (this.current === entry) {
          if (this.deps.editor.isEmpty) this.deps.editor.setParts(parts)
        } else if (this.empty(entry.draft)) entry.draft = parts
        entry.view.notice("error", error instanceof Error ? error.message : String(error))
        entry.view.requestRender()
      })
      .finally(() => {
        if (entry.send !== receipt) return
        entry.send = undefined
        entry.sending = false
        if (!entry.disposed) {
          this.drainQueued(entry)
          entry.view.requestRender()
        }
      })
  }

  private drainQueued(entry: Entry) {
    if (entry.disposed || entry.sending || !entry.queued.length) return
    try {
      if (entry.conversation.status().busy) return
    } catch {
      return
    }
    const batch = entry.queued.splice(0, entry.queued.length)
    if (!batch.length) return
    const text = batch.map((q) => q.text).join("\n\n")
    const shown = batch.map((q) => q.display ?? q.text)
    const display = batch.some((q) => q.display) ? shown.join("\n\n") : undefined
    const parts = batch.flatMap<EditorPart>((q, i) => [...(i ? ["\n\n"] : []), ...(q.parts ?? [q.text])])
    const merged: Outgoing = {
      ...draftMessage(text, display, parts),
      parts,
    }
    if (batch.some((q) => q.content)) {
      merged.content = batch.flatMap((q, i) => [
        ...(i ? [{ type: "text" as const, text: "\n\n" }] : []),
        ...(q.content ?? [{ type: "text" as const, text: q.text }]),
      ])
      if (imageBytes(parts) > MAX_IMAGE_BYTES) {
        this.putBackTo(entry, batch)
        entry.view.notice(
          "warning",
          "Images in the combined message exceed 5 MB. Send the attachments separately.",
        )
        return
      }
    }
    this.dispatchEntryMessage(entry, merged, parts)
  }

  /** Local requests capture turn ownership synchronously, before queued delivery or focus changes. */
  captureApprovalRequest(request: EventMap["ui.request"]): void {
    if (this.disposed || request.source !== "approval" || this.requests.has(request.requestId)) return
    const sessionId = this.deps.approvalOwner?.(request.requestId)?.sessionId ?? request.sessionId ?? "host"
    this.requests.set(request.requestId, {
      sessionId: sessionId === "host" ? this.deps.mainId() : sessionId,
      data: request,
      cancelApproval: this.requestApprovalCancellation(request),
    })
  }

  approvalCancellation(request: EventMap["ui.request"]): () => void {
    return this.requests.get(request.requestId)?.cancelApproval ?? this.requestApprovalCancellation(request)
  }

  private requestApprovalCancellation(request: EventMap["ui.request"]): () => void {
    const owner = this.deps.approvalOwner?.(request.requestId)
    // Missing host authority must never borrow a replacement turn during replay.
    if (!owner && this.deps.requireApprovalOwner) return () => {}
    return this.captureApprovalCancellation(request.sessionId, owner)
  }

  private captureApprovalCancellation(
    sessionId?: string,
    owner?: {
      readonly sessionId: string
      readonly turnId?: string
      readonly conversationIncarnation?: string
    },
  ): () => void {
    const root = owner?.sessionId ?? this.rootSession(sessionId ?? "host")
    const current = () => !this.disposed
    if (root === this.deps.mainId()) {
      const turnId = owner ? owner.turnId : this.deps.mainTurnId?.()
      return () => {
        if (!current() || this.deps.mainId() !== root) return
        if (this.deps.mainTurnId && (!turnId || this.deps.mainTurnId() !== turnId)) return
        if (owner ? !!turnId : this.deps.mainWorking()) this.deps.interruptMain(turnId)
      }
    }
    const findEntry = () =>
      [...this.entries.values()].find(
        (candidate) =>
          candidate.conversation.id === root &&
          (!owner?.conversationIncarnation || candidate.incarnation === owner.conversationIncarnation),
      )
    const initial = findEntry()
    const turnId = owner
      ? owner.turnId
      : initial && (conversationTurnId(initial.conversation) ?? initial.turnId)
    return () => {
      const entry = findEntry()
      if (
        !current() ||
        !entry ||
        entry.disposed ||
        !turnId ||
        (conversationTurnId(entry.conversation) ?? entry.turnId) !== turnId
      )
        return
      this.stopEntry(entry, turnId)
    }
  }

  interrupt() {
    const entry = this.current
    if (!entry) return
    if (entry.queued.length) this.putBackTo(entry, entry.queued.splice(0, entry.queued.length))
    const turnId = conversationTurnId(entry.conversation) ?? entry.turnId
    if (turnId) this.stopEntry(entry, turnId)
    else {
      const holdId = conversationHoldId(entry.conversation)
      if (holdId) this.stopEntry(entry, undefined, holdId)
    }
  }

  private stopEntry(entry: Entry, expectedTurnId?: string, expectedHoldId?: string) {
    void Promise.resolve()
      .then(async () => {
        if (
          entry.disposed ||
          (expectedTurnId
            ? (conversationTurnId(entry.conversation) ?? entry.turnId) !== expectedTurnId
            : !expectedHoldId || conversationHoldId(entry.conversation) !== expectedHoldId)
        )
          return
        await entry.conversation.stop("Interrupted from composer")
      })
      .catch((error) => {
        if (entry.disposed) return
        entry.view.notice("error", String(error))
        entry.view.requestRender()
      })
  }

  /** Host UI requests default to main; owner callbacks explicitly supply their sessionId. */
  onUiEvent(event: AnyEvent): boolean {
    if (event.type === "ui.request") {
      const association =
        this.deps.approvalOwner?.(event.data.requestId)?.sessionId ?? event.data.sessionId ?? event.sessionId
      const sessionId = this.rootSession(association)
      this.requests.set(event.data.requestId, {
        sessionId: association === "host" ? this.deps.mainId() : association,
        data: event.data,
        cancelApproval:
          this.requests.get(event.data.requestId)?.cancelApproval ??
          (event.data.source === "approval" ? this.requestApprovalCancellation(event.data) : undefined),
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
        if (next.done || entry.disposed) break
        const event = next.value
        if (event.seq <= seq) continue
        seq = event.seq
        if (event.sessionId === entry.conversation.id) {
          const send = entry.send
          if (event.type === "turn.start") {
            entry.turnId = event.turnId
            if (send && send.turnId === event.turnId) send.reconciled = true
          } else if (event.type === "turn.end") {
            if (entry.turnId === event.turnId) entry.turnId = undefined
            if (send && send.turnId === event.turnId) {
              send.reconciled = true
              entry.send = undefined
              entry.sending = false
            }
            if (event.data.reason === "done") queueMicrotask(() => this.drainQueued(entry))
          }
        }
        if (this.onUiEvent(event)) continue
        if (event.type === "events.lost") {
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
            if (entry.send?.turnId !== event.turnId) entry.history.add(messageParts(event.data.prompt))
          }
          renderer.onEvent(event)
        } else if (entry.view.subagentEvent(event)) entry.view.requestRender()
      }
    } catch (error) {
      entry.view.notice("error", String(error))
    } finally {
      if (this.current === entry) this.unfocus()
      if (this.lastEntry === entry) this.lastEntry = undefined
      entry.queued.length = 0
      this.released.add(entry.conversation)
      this.entries.delete(entry.conversation)
      entry.disposed = true
      entry.view.stop()
      if (!this.current) this.deps.mainView.requestRender()
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
