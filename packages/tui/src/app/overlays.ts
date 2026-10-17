// Owns dialogs, full-screen viewers, waiting forms and their input and lifecycle.
import {
  type AnyEvent,
  type EventMap,
  type FrontendView,
  isSubagentView,
  type ToolDetailLevel,
} from "@amira/api"
import type { UiRequests } from "@amira/core"
import {
  type ImageStore,
  type InputEvent,
  type MouseInput,
  matchesKey,
  type RenderContext,
  Spinner,
  type Theme,
  translateMouse,
  truncateToWidth,
} from "@amira/tui-kit"
import { Dialog, type DialogAnswer, dialogEchoLines } from "../dialog.ts"
import {
  type ExtensionSettingsRequest,
  ExtensionSettingsView,
  type ExtensionSettingsViewOptions,
  uiExtensionSettingsBackend,
} from "../extension-settings-view.ts"
import { ExtensionViewer, type ViewSource } from "../extension-view.ts"
import { type FormRequest, FormView, uiFormBackend } from "../form-view.ts"
import { KeyReference } from "../key-reference.ts"
import type { Keybindings, KeySpec } from "../keybindings.ts"
import type { PresenterSource } from "../tool-view.ts"
import type { TranscriptView } from "../view.ts"
import type { CommandRunner } from "./command-runner.ts"
import { DockedView } from "./dock.ts"
import { overlayKeys } from "./startup.ts"

export interface OverlayManagerDeps {
  ui?: UiRequests
  views?: ViewSource
  keys: Keybindings
  theme: Theme
  presenters?: PresenterSource
  images?: () => ImageStore | undefined
  previewTheme?: ExtensionSettingsViewOptions["previewTheme"]
  toolDetail?: () => ToolDetailLevel
  env: Record<string, string | undefined>
  reaches: (spec: KeySpec) => boolean
  view: () => TranscriptView
  /** Emits on the active session's bus, which can change while the UI is open. */
  emitWaiting: (data: EventMap["ui.waiting"]) => void
  working: () => boolean
  interrupt: () => void
  approvalCancelled?: (request: EventMap["ui.request"]) => void
  conversationChrome?: (width: number, ctx: RenderContext) => string[]
  pointerHint?: () => string | undefined
  quitting: () => boolean
  editorEmpty: () => boolean
  searchActive: () => boolean
  searchHint: (theme: Theme, width: number) => string | undefined
  inputFocused: (focused: boolean) => void
  renderInput: (width: number, ctx: RenderContext, budget: number) => string[]
  handleInputPointer?: (event: MouseInput) => boolean
  commandActivity?: () => Pick<CommandRunner, "animationActive" | "tickAnimation">
}

/** Dialogs and full-screen views over the conversation, including forms waiting for their turn. */
export class OverlayManager {
  /** Open extension dialogs; the first one has the keyboard. */
  readonly dialogs: Dialog[] = []
  /** An extension's full-screen view, open over the conversation. */
  private viewer: ExtensionViewer | KeyReference | undefined
  dock: DockedView | undefined
  private inputTop = 0
  private inputBottom = 0
  private chromeStart: number | undefined
  private readonly lifetimes = new WeakMap<ExtensionViewer, { owner?: object; off?: () => void }>()
  private animationTimer: ReturnType<typeof setInterval> | undefined
  private animationInterval: number | undefined
  private disposed = false
  private detaching = false
  /** External requests have no core pending entry; their closed IDs live until disposal. */
  private readonly settledRequests = new Set<string>()
  private bottomVisible = true
  private commandRowVisible = true
  /**
   * Forms (ui.form) waiting to be shown full screen, oldest first; the first one is open while
   * `form` is set. A form waits while an inline dialog or the viewer is up, and inline dialogs
   * that arrive while a form is open wait behind it.
   */
  private readonly forms: (FormRequest | ExtensionSettingsRequest)[] = []
  private form: FormView | ExtensionSettingsView | undefined
  /** Pending requests retain their actual editors while their conversation is hidden. */
  private readonly requestDialogs = new Map<string, Dialog>()
  private readonly requestForms = new Map<
    string,
    { request: FormRequest | ExtensionSettingsRequest; view?: FormView | ExtensionSettingsView }
  >()

  constructor(private readonly deps: OverlayManagerDeps) {}

  /** Echoes of existing dialogs use the theme active when they are answered or redrawn. */
  setTheme(theme: Theme): void {
    this.deps.theme = theme
  }

  get hasFullscreen(): boolean {
    return !!(this.form || this.viewer)
  }

  /** Without focus reports, only permission and question dialogs warrant an alert. */
  get needsAttention(): boolean {
    return this.dialogs.some(
      (d) => d.request.source === "approval" || d.request.kind === "ask" || d.request.kind === "confirm",
    )
  }

  render(width: number, ctx: RenderContext): string[] {
    const chrome = this.deps.conversationChrome?.(width, ctx) ?? []
    const hint = this.deps.pointerHint?.()
    if (hint) chrome.push(ctx.theme.muted(truncateToWidth(hint, width)))
    if (!chrome.length) {
      this.chromeStart = undefined
      return this.renderContent(width, ctx)
    }
    const room = Math.max(0, ctx.rows - chrome.length)
    this.chromeStart = room
    const rows = this.renderContent(width, { ...ctx, rows: Math.max(1, room) }).slice(0, room)
    while (rows.length < room) rows.push("")
    return [...rows, ...chrome].slice(0, ctx.rows)
  }

  private renderContent(width: number, ctx: RenderContext): string[] {
    if (this.form) return this.form.render(width, ctx)
    if (this.viewer instanceof ExtensionViewer) {
      const budget = Math.max(1, Math.min(Math.floor(ctx.rows / 3), ctx.rows - 2))
      const input = this.deps.renderInput(width, ctx, budget)
      this.inputTop = Math.max(0, ctx.rows - input.length - 1)
      this.inputBottom = this.inputTop + input.length
      const rows = this.viewer.render(width, { ...ctx, rows: this.inputTop })
      while (rows.length < this.inputTop) rows.push("")
      this.syncAnimation()
      return [
        ...rows,
        ...input,
        `  ${(!this.viewer.focused && this.deps.searchHint(ctx.theme, Math.max(1, width - 2))) || this.viewer.focusHint(ctx.theme, Math.max(1, width - 2), this.deps.editorEmpty())}`,
      ]
    }
    const rows = this.viewer?.render(width, ctx) ?? []
    this.syncAnimation()
    return rows
  }

  waitingChanged(change: EventMap["ui.waiting"]["change"]) {
    if (this.dialogs.length && !this.hasFullscreen) this.deps.view().cancelPointer?.()
    if (this.dialogs.length && !this.hasFullscreen && this.dock?.viewer.focused)
      this.focusView(this.dock.viewer, false)
    const pending = this.dialogs.length + this.forms.length
    const hidden = pending > 0 && (this.viewer !== undefined || (this.form !== undefined && pending > 1))
    this.syncAnimation()
    this.deps.emitWaiting({ pending, hidden, change })
  }

  /** Titles of everything waiting for an answer, for the banners of full-screen views. */
  private waitingTitles = () => [
    ...this.dialogs.map((d) => d.request.title),
    ...this.forms.slice(this.form ? 1 : 0).map((f) => f.title),
  ]

  /** Shows a full-screen view; false when it cannot be shown now (see CommandContext.openView). */
  openView(v: FrontendView): boolean {
    if (this.detaching || this.disposed) return false
    const { keys, presenters, env } = this.deps
    const source = this.deps.views
    if (source?.canOpen?.(v) === false) return false
    const owner = source?.owner?.(v)
    const request = v
    // Keep old command requests working through the same extension lookup.
    if (isSubagentView(v)) v = { ...v, data: { sessionId: v.sessionId } }
    const definition = source?.get(v.kind)
    if (!definition) throw new Error(`there is no "${v.kind}" view`)
    if (this.deps.quitting() || this.form || env.TERM === "dumb") return false
    if (v.placement === "dock") {
      if (this.dock?.viewer.uses(definition) && this.lifetimes.get(this.dock.viewer)?.owner === owner) {
        this.dock.viewer.show(v.data, v.state)
        this.dock.maxHeight = v.maxHeight
      } else {
        const next = new ExtensionViewer(definition, v.data, {
          placement: "dock",
          hostFocus: true,
          keys,
          toolDetail: this.deps.toolDetail,
          state: v.state,
          onClose: () => this.dock?.viewer === next && this.closeDock(),
          requestRender: () => next.ready && this.deps.view().requestRender(),
          onError: (error) => this.deps.view().notice("warning", `View ${v.kind}: ${error}`),
          onPrint: (text, level) => {
            this.deps.view().commandOutput(level ?? "info", text)
            this.deps.view().requestRender()
          },
          ...(presenters ? { presenters } : {}),
        })
        const previous = this.dock
        this.dock = new DockedView(next, keys, v.maxHeight, () => this.focusView(next, false))
        if (!this.hasFullscreen) this.deps.inputFocused(true)
        this.lifetimes.set(next, {
          owner,
          off: source?.watch?.(request, () => this.dock?.viewer === next && this.closeDock()),
        })
        if (previous) this.disposeViewer(previous.viewer)
        if (this.dock?.viewer === next) next.mount()
      }
      this.syncAnimation()
      this.deps.view().requestRender()
      return true
    }
    if (
      this.viewer instanceof ExtensionViewer &&
      this.viewer.uses(definition) &&
      this.lifetimes.get(this.viewer)?.owner === owner
    )
      this.viewer.show(v.data, v.state)
    else {
      const next = new ExtensionViewer(definition, v.data, {
        keys,
        hostFocus: true,
        toolDetail: this.deps.toolDetail,
        state: v.state,
        waiting: this.waitingTitles,
        onClose: () => this.viewer === next && this.closeView(),
        requestRender: () => next.ready && this.deps.view().requestOverlayRender(),
        onError: (error) => this.deps.view().notice("warning", `View ${v.kind}: ${error}`),
        onPrint: (text, level) => {
          this.deps.view().commandOutput(level ?? "info", text)
          this.deps.view().requestRender()
        },
        ...(presenters ? { presenters } : {}),
      })
      this.lifetimes.set(next, {
        owner,
        off: source?.watch?.(request, () => this.viewer === next && this.closeView()),
      })
      this.showOverlay(next)
    }
    if (!(this.viewer instanceof ExtensionViewer) || this.viewer.ready) this.deps.view().renderOverlay()
    return true
  }

  renderDock(width: number, ctx: RenderContext, available: number): string[] {
    if (this.hasFullscreen) {
      this.dock?.hide()
      this.syncAnimation()
      return []
    }
    const rows = this.dock?.render(width, ctx, available) ?? []
    this.syncAnimation()
    return rows
  }

  focusHint(theme: Theme, width: number): string | undefined {
    return !this.hasFullscreen && !this.dialogs.length && !this.deps.searchActive() && this.dock?.focusable
      ? this.dock.viewer.focusHint(theme, width, this.deps.editorEmpty())
      : undefined
  }

  private focusView(viewer: ExtensionViewer, focused: boolean) {
    viewer.focused = focused
    this.deps.inputFocused(!focused)
    if (this.hasFullscreen) this.deps.view().requestOverlayRender()
    else this.deps.view().requestRender()
  }

  /** Returns false only when the original event should continue to the composer. */
  private handleViewInput(viewer: ExtensionViewer, e: InputEvent): boolean {
    if (
      !matchesKey(e, "tab", { shift: true }) &&
      (this.deps.keys.is(e, "view.focus") || (!viewer.needsTab && matchesKey(e, "tab", { shift: false })))
    ) {
      this.focusView(viewer, !viewer.focused)
      return true
    }
    if (!viewer.focused) {
      if (!this.deps.searchActive() && matchesKey(e, "escape") && this.deps.editorEmpty()) {
        this.focusView(viewer, true)
        return true
      }
      return false
    }
    if (!viewer.typing && (matchesKey(e, "/") || matchesKey(e, "i"))) {
      this.focusView(viewer, false)
      return matchesKey(e, "i")
    }
    if (viewer.handleInput(e)) return true
    if (e.type === "paste" || (e.type === "key" && !e.ctrl && !e.alt && e.text)) {
      this.focusView(viewer, false)
      return false
    }
    return true
  }

  /** Fullscreen overlays win; a read-only dock retains its original scrolling controls. */
  handleDockInput(e: InputEvent): boolean {
    if (!this.dock || this.hasFullscreen) return false
    // Visible dialogs own keyboard and pointer activation; only wheel scrolling reaches the dock.
    if (this.dialogs.length) {
      // Cancel a covered dock's pending gesture without letting the dialog click reach its controls.
      if (e.type === "mouse" && e.button === "left") this.dock.handleInput({ ...e, x: -1, y: -1 })
      return e.type === "mouse" && e.action === "wheel" && this.dock.handleInput(e)
    }
    if (e.type === "mouse" && e.action === "press" && e.button === "left") {
      if (this.dock.focusable && this.dock.contains(e)) this.focusView(this.dock.viewer, true)
    }
    if (this.dock.focusable && e.type !== "mouse" && this.handleViewInput(this.dock.viewer, e)) return true
    // Cancel a search before applying the input's ordinary dock-close action.
    if (this.deps.searchActive() && e.type !== "mouse") return false
    if (matchesKey(e, "escape") && !this.dock.viewer.focused) {
      this.closeDock()
      return true
    }
    const focused = this.dock.viewer.focused
    const handled = this.dock.handleInput(e)
    if (this.dock.viewer.focused !== focused) this.focusView(this.dock.viewer, this.dock.viewer.focused)
    return handled
  }

  /** One clock for visible view, dialog and command demand; hidden content never wakes it. */
  syncAnimation(bottomVisible?: boolean, commandRowVisible?: boolean): void {
    if (bottomVisible !== undefined) this.bottomVisible = bottomVisible
    if (commandRowVisible !== undefined) this.commandRowVisible = commandRowVisible
    const commands = this.deps.commandActivity?.()
    const commandVisible =
      this.bottomVisible &&
      this.commandRowVisible &&
      !this.hasFullscreen &&
      !this.dialogs.length &&
      commands?.animationActive
    const demands = this.disposed
      ? []
      : this.hasFullscreen
        ? [this.viewer instanceof ExtensionViewer && !this.form ? this.viewer.refreshIntervalMs : undefined]
        : [
            this.dock?.visible ? this.dock.viewer.refreshIntervalMs : undefined,
            this.bottomVisible ? this.dialogs[0]?.refreshIntervalMs : undefined,
            commandVisible ? Spinner.INTERVAL_MS : undefined,
          ]
    const intervals = demands.filter((ms): ms is number => ms !== undefined)
    const interval = intervals.length ? Math.min(...intervals) : undefined
    if (this.animationTimer !== undefined && this.animationInterval === interval) return
    clearInterval(this.animationTimer)
    this.animationTimer = undefined
    this.animationInterval = interval
    if (interval === undefined) return
    this.animationTimer = setInterval(() => {
      this.syncAnimation()
      if (this.animationTimer === undefined) return
      const commands = this.deps.commandActivity?.()
      if (
        this.bottomVisible &&
        this.commandRowVisible &&
        !this.hasFullscreen &&
        !this.dialogs.length &&
        commands?.animationActive
      )
        commands.tickAnimation()
      if (this.hasFullscreen) this.deps.view().requestOverlayRender()
      else this.deps.view().requestRender()
    }, interval)
  }

  private disposeViewer(viewer: ExtensionViewer) {
    this.lifetimes.get(viewer)?.off?.()
    this.lifetimes.delete(viewer)
    viewer.dispose()
  }

  private closeDock() {
    const previous = this.dock
    if (!previous) return
    this.dock = undefined
    if (!this.hasFullscreen) this.deps.inputFocused(true)
    this.syncAnimation()
    this.disposeViewer(previous.viewer)
    this.deps.view().requestRender()
  }

  /** A side view belongs to the session that opened it. */
  sessionChanged(): void {
    this.closeDock()
  }

  /**
   * Suspends request editors before the current transcript is hidden or replaced.
   * The focus controller replays pending requests through onUiRequest to restore these instances.
   */
  detachConversation(): void {
    if (this.detaching) return
    this.detaching = true
    try {
      const form = this.form
      const viewer = this.viewer
      this.dialogs.splice(0)
      this.forms.splice(0)
      this.form = undefined
      this.viewer = undefined
      // Remove only visible ownership. Closing a request would discard its editing state.
      if (form || viewer) this.deps.view().closeOverlay()
      if (viewer instanceof ExtensionViewer) this.disposeViewer(viewer)
      this.closeDock()
      this.deps.inputFocused(true)
      this.waitingChanged("visibility")
    } finally {
      this.detaching = false
    }
  }

  /** Opens the key reference over the conversation (the help key); a form keeps the screen. */
  openKeyReference() {
    if (this.form) return
    const { keys, reaches } = this.deps
    const next = new KeyReference(keys, {
      onClose: () => this.viewer === next && this.closeView(),
      usable: (action, s) => action !== "newline" || reaches(s),
    })
    this.showOverlay(next)
    this.deps.view().renderOverlay()
  }

  /** Puts `next` over the conversation, in place of the viewer open there if any. */
  private showOverlay(next: ExtensionViewer | KeyReference) {
    const previous = this.viewer
    this.viewer = next
    this.deps.inputFocused(false)
    if (previous instanceof ExtensionViewer) this.disposeViewer(previous)
    if (this.viewer !== next) return
    if (next instanceof ExtensionViewer) next.mount()
    if (this.viewer !== next) return
    this.dock?.hide()
    this.deps.view().openOverlay(next instanceof ExtensionViewer)
    this.syncAnimation()
    this.waitingChanged("visibility")
  }

  private closeView() {
    const previous = this.viewer
    if (!previous) return
    this.viewer = undefined
    this.deps.inputFocused(!this.dock?.viewer.focused)
    this.syncAnimation()
    this.deps.view().closeOverlay()
    if (previous instanceof ExtensionViewer) this.disposeViewer(previous)
    this.openNextForm()
    this.waitingChanged("visibility")
  }

  /** Shows the first waiting form, unless a dialog, the viewer or another form is up. */
  private openNextForm() {
    const ui = this.deps.ui
    const next = this.forms[0]
    if (!ui || !next || this.detaching || this.disposed || this.form || this.viewer || this.dialogs.length)
      return
    const entry = this.requestForms.get(next.requestId)
    if (!entry) return
    const options = {
      requestRender: () => {
        if (this.form === form) this.deps.view().requestOverlayRender()
      },
      waiting: this.waitingTitles,
      onClose: () => this.closeForm(next.requestId, form),
    }
    const form =
      entry.view ??
      (next.kind === "extension-settings"
        ? new ExtensionSettingsView(uiExtensionSettingsBackend(ui, next), {
            ...options,
            images: this.deps.images,
            previewTheme: this.deps.previewTheme,
          })
        : new FormView(uiFormBackend(ui, next), options))
    entry.view = form
    this.form = form
    this.dock?.hide()
    this.syncAnimation()
    this.deps.view().openOverlay()
    this.deps.view().renderOverlay()
  }

  /** The open form was answered, cancelled, or resolved elsewhere: back to the conversation. */
  private closeForm(requestId: string, form: FormView | ExtensionSettingsView) {
    // A stale/reentrant close must never remove another editor or open its waiting requests.
    if (this.requestForms.get(requestId)?.view !== form) return
    this.requestForms.delete(requestId)
    if (!this.disposed) this.settledRequests.add(requestId)
    const i = this.forms.findIndex((request) => request.requestId === requestId)
    if (i !== -1) this.forms.splice(i, 1)
    if (this.form !== form) return
    this.form = undefined
    this.deps.view().closeOverlay()
    this.openNextForm()
    this.waitingChanged("resolved")
  }

  onEvent(e: AnyEvent) {
    if (this.dock && !this.hasFullscreen) this.deps.view().requestRender()
    // An extension's view may show anything: it is drawn again at each event (at most once a frame).
    if (this.viewer instanceof ExtensionViewer || this.viewer?.handleEvent())
      this.deps.view().requestOverlayRender()
    if (this.form && (e.type === "ui.request" || e.type === "ui.resolved"))
      this.deps.view().requestOverlayRender()
  }

  /** A picker owned by the TUI, sharing focus and the waiting-form lifecycle with extension dialogs. */
  openLocalDialog(dialog: Dialog): () => void {
    this.dialogs.push(dialog)
    this.waitingChanged("opened")
    this.deps.view().requestRender()
    return () => {
      const at = this.dialogs.indexOf(dialog)
      if (at === -1) return
      this.dialogs.splice(at, 1)
      this.openNextForm()
      this.waitingChanged("resolved")
      this.deps.view().requestRender()
    }
  }

  onUiRequest(data: EventMap["ui.request"]) {
    const ui = this.deps.ui
    // Unknown IDs can be first external announcements. Settled IDs are stale, even if cloned
    // or delivered before their initial request/resolved events have reached this frontend.
    if (
      !ui ||
      this.disposed ||
      this.settledRequests.has(data.requestId) ||
      ui.requestState(data.requestId) === "settled"
    )
      return
    if (data.kind === "form" || data.kind === "extension-settings") {
      if (this.forms.some((request) => request.requestId === data.requestId)) return
      if (!this.requestForms.has(data.requestId)) this.requestForms.set(data.requestId, { request: data })
      this.forms.push(data)
      this.openNextForm()
      this.waitingChanged("opened")
      return
    }
    const existing = this.requestDialogs.get(data.requestId)
    if (existing && this.dialogs.includes(existing)) {
      if (existing.update(data)) this.deps.view().requestRender()
      return
    }
    const dialog =
      existing ?? new Dialog(data, (answer) => this.answerDialog(ui, dialog, answer), this.deps.keys)
    if (existing) existing.update(data)
    this.requestDialogs.set(data.requestId, dialog)
    this.dialogs.push(dialog)
    // Over the viewer or a form it shows only as a banner; the bell rings so it is noticed.
    this.waitingChanged("opened")
  }

  onUiResolved(data: EventMap["ui.resolved"]) {
    this.forgetResolvedRequest(data.requestId)
  }

  private forgetResolvedRequest(requestId: string): void {
    if (!this.disposed) this.settledRequests.add(requestId)
    const dialog = this.requestDialogs.get(requestId)
    this.requestDialogs.delete(requestId)
    dialog?.close()
    const i = this.dialogs.findIndex((d) => d.request.requestId === requestId)
    if (i !== -1) this.dialogs.splice(i, 1)
    const entry = this.requestForms.get(requestId)
    // Closing a suspended editor clears it without touching the active conversation.
    if (entry?.view) {
      entry.view.close()
      return
    }
    this.requestForms.delete(requestId)
    const f = this.forms.findIndex((r) => r.requestId === requestId)
    if (f !== -1) this.forms.splice(f, 1)
    if (i === -1 && f === -1) return // Hidden resolution or an already removed local answer.
    this.openNextForm()
    this.waitingChanged("resolved")
  }

  /** A settled host request must stop owning input even before its queued event is drained. */
  reconcileResolvedRequests(): void {
    const ui = this.deps.ui
    if (!ui) return
    const requests = [
      ...[...this.requestDialogs.values()].map((dialog) => dialog.request),
      ...[...this.requestForms.values()].map((entry) => entry.request),
    ]
    for (const request of requests) {
      if (ui.requestState(request.requestId) === "settled") this.forgetResolvedRequest(request.requestId)
    }
  }

  handleInput(e: InputEvent): boolean {
    // A form or the viewer owns the keyboard while open: the rest is hidden. Ctrl+L repaints it.
    // Interactive forms and extension views receive pointer coordinates; the key reference uses wheel arrows.
    if (!this.hasFullscreen) return false
    // Chrome is reserved after the overlay; content and caret origins never shift.
    if (e.type === "mouse" && this.chromeStart !== undefined && e.y >= this.chromeStart) {
      ;(this.form ?? this.viewer)?.handleInput(e)
      return true
    }
    if (this.deps.keys.is(e, "redraw")) {
      this.deps.view().redrawOverlay()
      return true
    }
    if (!this.form && this.viewer instanceof ExtensionViewer) {
      const viewer = this.viewer
      if (e.type === "mouse") {
        if (this.deps.handleInputPointer?.(translateMouse(e, 0, this.inputTop)))
          this.deps.view().requestOverlayRender()
        if (e.y >= this.inputTop) {
          viewer.handleInput(e) // Outside reports cancel a pending widget press before the composer consumes them.
          if (e.y < this.inputBottom && e.action === "press" && e.button === "left")
            this.focusView(viewer, false)
          return true
        }
        if (e.action === "press" && e.button === "left") this.focusView(viewer, true)
        // Wheel scrolling over the view need not steal focus from a draft.
        viewer.handleInput(e)
        this.deps.view().requestOverlayRender()
        return true
      }
      const handled = this.handleViewInput(viewer, e)
      this.deps.view().requestOverlayRender()
      return handled
    }
    if (this.form) this.form.handleInput(e)
    else for (const k of overlayKeys(e, false)) this.viewer?.handleInput(k)
    this.deps.view().requestOverlayRender()
    return true
  }

  private answerDialog(ui: UiRequests, dialog: Dialog, answer: DialogAnswer) {
    const i = this.dialogs.indexOf(dialog)
    if (i === -1 || this.disposed) return
    this.dialogs.splice(i, 1)
    const { requestId } = dialog.request
    this.requestDialogs.delete(requestId)
    dialog.close()
    if (!this.disposed) this.settledRequests.add(requestId)
    const refused = answer !== undefined && ui.respond(requestId, answer) !== undefined
    if (answer === undefined || refused) ui.cancel(requestId)
    // Esc on an approval denies the call and stops the whole turn, as the dialog's keys say.
    if (answer === undefined && dialog.request.source === "approval") {
      if (this.deps.approvalCancelled) this.deps.approvalCancelled(dialog.request)
      else if (this.deps.working()) this.deps.interrupt()
    }
    const echoed = refused ? undefined : answer
    // Confirms and questions leave no echo: the tool call that asked shows how it went (allowed,
    // declined, the answer). A command's picker or input keeps one, since nothing else shows it.
    const kind = dialog.request.kind
    if (kind !== "confirm" && kind !== "ask")
      this.deps.view().dialogEcho((width) => dialogEchoLines(dialog.request, echoed, this.deps.theme, width))
    this.deps.view().requestRender()
    this.openNextForm()
    this.waitingChanged("resolved")
  }

  /** Releases visible and suspended request editors and closes terminal overlays. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.syncAnimation()
    this.closeDock()
    for (const [requestId, entry] of this.requestForms) {
      this.deps.ui?.cancel(requestId)
      entry.view?.close()
    }
    this.requestForms.clear()
    this.forms.splice(0)
    for (const [requestId, dialog] of this.requestDialogs) {
      this.deps.ui?.cancel(requestId)
      dialog.close()
    }
    this.requestDialogs.clear()
    this.dialogs.splice(0)
    this.closeView()
    this.settledRequests.clear()
  }
}
