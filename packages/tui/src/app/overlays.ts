// Owns dialogs, full-screen viewers, waiting forms and their input and lifecycle.
import {
  type AnyEvent,
  type EventMap,
  type FrontendView,
  isSubagentView,
  type ToolDetailLevel,
} from "@amira/api"
import type { UiRequests } from "@amira/core"
import { type ImageStore, type InputEvent, matchesKey, type RenderContext, type Theme } from "@amira/tui-kit"
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
  mode: "inline" | "fullscreen"
  env: Record<string, string | undefined>
  reaches: (spec: KeySpec) => boolean
  view: () => TranscriptView
  /** Emits on the active session's bus, which can change while the UI is open. */
  emitWaiting: (data: EventMap["ui.waiting"]) => void
  working: () => boolean
  interrupt: () => void
  quitting: () => boolean
  editorEmpty: () => boolean
  searchActive: () => boolean
  searchHint: (theme: Theme, width: number) => string | undefined
  inputFocused: (focused: boolean) => void
  renderInput: (width: number, ctx: RenderContext, budget: number) => string[]
  /** Inline mode enables pointer reports only while a dock or fullscreen view uses them. */
  dockChanged?: (open: boolean) => void
}

/** Dialogs and full-screen views over the conversation, including forms waiting for their turn. */
export class OverlayManager {
  /** Open extension dialogs; the first one has the keyboard. */
  readonly dialogs: Dialog[] = []
  /**
   * An extension's full-screen view, open over the conversation. Inline,
   * the UI is suspended meanwhile: what the main session commits is held and printed when it closes.
   */
  private viewer: ExtensionViewer | KeyReference | undefined
  dock: DockedView | undefined
  private inputTop = 0
  private inputBottom = 0
  private readonly lifetimes = new WeakMap<ExtensionViewer, { owner?: object; off?: () => void }>()
  private dockTimer: ReturnType<typeof setInterval> | undefined
  private dockInterval = 1000
  private viewerTimer: ReturnType<typeof setInterval> | undefined
  private viewerInterval = 1000
  /**
   * Forms (ui.form) waiting to be shown full screen, oldest first; the first one is open while
   * `form` is set. A form waits while an inline dialog or the viewer is up, and inline dialogs
   * that arrive while a form is open wait behind it.
   */
  private readonly forms: (FormRequest | ExtensionSettingsRequest)[] = []
  private form: FormView | ExtensionSettingsView | undefined

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
    if (this.form) return this.form.render(width, ctx)
    if (this.viewer instanceof ExtensionViewer) {
      const budget = Math.max(1, Math.min(Math.floor(ctx.rows / 3), ctx.rows - 2))
      const input = this.deps.renderInput(width, ctx, budget)
      this.inputTop = Math.max(0, ctx.rows - input.length - 1)
      this.inputBottom = this.inputTop + input.length
      const rows = this.viewer.render(width, { ...ctx, rows: this.inputTop })
      while (rows.length < this.inputTop) rows.push("")
      this.syncViewerTimer()
      return [
        ...rows,
        ...input,
        `  ${(!this.viewer.focused && this.deps.searchHint(ctx.theme, Math.max(1, width - 2))) || this.viewer.focusHint(ctx.theme, Math.max(1, width - 2), this.deps.editorEmpty())}`,
      ]
    }
    const rows = this.viewer?.render(width, ctx) ?? []
    this.syncViewerTimer()
    return rows
  }

  waitingChanged(change: EventMap["ui.waiting"]["change"]) {
    if (this.dialogs.length && !this.hasFullscreen && this.dock?.viewer.focused)
      this.focusView(this.dock.viewer, false)
    const pending = this.dialogs.length + this.forms.length
    const hidden = pending > 0 && (this.viewer !== undefined || (this.form !== undefined && pending > 1))
    this.deps.emitWaiting({ pending, hidden, change })
  }

  /** Titles of everything waiting for an answer, for the banners of full-screen views. */
  private waitingTitles = () => [
    ...this.dialogs.map((d) => d.request.title),
    ...this.forms.slice(this.form ? 1 : 0).map((f) => f.title),
  ]

  /** Shows a full-screen view; false when it cannot be shown now (see CommandContext.openView). */
  openView(v: FrontendView): boolean {
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
        if (this.dock?.viewer === next) this.deps.dockChanged?.(true)
      }
      this.syncDockTimer()
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
    if (this.hasFullscreen) return []
    const rows = this.dock?.render(width, ctx, available) ?? []
    if (this.dock?.viewer.focused && !this.dock.viewer.selectable) this.focusView(this.dock.viewer, false)
    this.syncDockTimer()
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
    if (this.dialogs.length) return e.type === "mouse" && e.action === "wheel" && this.dock.handleInput(e)
    if (e.type === "mouse" && e.action === "press" && e.button === "left") {
      if (this.dock.focusable) this.focusView(this.dock.viewer, this.dock.contains(e))
    }
    if (this.dock.focusable && e.type !== "mouse" && this.handleViewInput(this.dock.viewer, e)) return true
    // Cancel a search before applying the input's ordinary dock-close action.
    if (this.deps.searchActive() && e.type !== "mouse") return false
    if (matchesKey(e, "escape") && !this.dock.viewer.focused) {
      this.closeDock()
      return true
    }
    return this.dock.handleInput(e)
  }

  private syncDockTimer() {
    if (!this.dock) return
    const interval = this.dock.viewer.animating ? 80 : 1000
    if (this.dockTimer && this.dockInterval === interval) return
    clearInterval(this.dockTimer)
    this.dockInterval = interval
    this.dockTimer = setInterval(() => {
      if (!this.hasFullscreen) this.deps.view().requestRender()
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
    clearInterval(this.dockTimer)
    this.dockTimer = undefined
    this.disposeViewer(previous.viewer)
    this.deps.dockChanged?.(false)
    this.deps.view().requestRender()
  }

  /** A side view belongs to the session that opened it. */
  sessionChanged(): void {
    this.closeDock()
  }

  /** Opens the key reference over the conversation (the help key); a form keeps the screen. */
  openKeyReference() {
    if (this.form) return
    const { keys, mode, reaches } = this.deps
    const next = new KeyReference(keys, {
      fullscreen: mode === "fullscreen",
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
    this.deps.view().openOverlay(next instanceof ExtensionViewer)
    this.syncViewerTimer()
    this.waitingChanged("visibility")
  }

  /** Reuse the overlay timer: ordinary views keep their 1s refresh, running tools use 80ms. */
  private syncViewerTimer() {
    if (!this.viewer) return
    const interval = this.viewer instanceof ExtensionViewer && this.viewer.animating ? 80 : 1000
    if (this.viewerTimer && this.viewerInterval === interval) return
    clearInterval(this.viewerTimer)
    this.viewerInterval = interval
    this.viewerTimer = setInterval(() => this.deps.view().requestOverlayRender(), interval)
  }

  private closeView() {
    const previous = this.viewer
    if (!previous) return
    this.viewer = undefined
    this.deps.inputFocused(!this.dock?.viewer.focused)
    clearInterval(this.viewerTimer)
    this.viewerTimer = undefined
    this.deps.view().closeOverlay()
    if (this.dock) this.deps.dockChanged?.(true)
    if (previous instanceof ExtensionViewer) this.disposeViewer(previous)
    this.openNextForm()
    this.waitingChanged("visibility")
  }

  /** Shows the first waiting form, unless a dialog, the viewer or another form is up. */
  private openNextForm() {
    const ui = this.deps.ui
    const next = this.forms[0]
    if (!ui || !next || this.form || this.viewer || this.dialogs.length) return
    const options = {
      requestRender: () => this.deps.view().requestOverlayRender(),
      waiting: this.waitingTitles,
      onClose: () => this.closeForm(next),
    }
    this.form =
      next.kind === "extension-settings"
        ? new ExtensionSettingsView(uiExtensionSettingsBackend(ui, next), {
            ...options,
            images: this.deps.images,
            previewTheme: this.deps.previewTheme,
          })
        : new FormView(uiFormBackend(ui, next), options)
    this.deps.view().openOverlay()
    this.deps.view().renderOverlay()
  }

  /** The open form was answered, cancelled, or resolved elsewhere: back to the conversation. */
  private closeForm(request: FormRequest | ExtensionSettingsRequest) {
    const i = this.forms.indexOf(request)
    if (i !== -1) this.forms.splice(i, 1)
    if (!this.form) return
    this.form = undefined
    this.deps.view().closeOverlay()
    if (this.dock) this.deps.dockChanged?.(true)
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
    if (!ui) return
    if (data.kind === "form" || data.kind === "extension-settings") {
      this.forms.push(data)
      this.openNextForm()
      this.waitingChanged("opened")
      return
    }
    const dialog = new Dialog(data, (answer) => this.answerDialog(ui, dialog, answer), this.deps.keys)
    this.dialogs.push(dialog)
    // Over the viewer or a form it shows only as a banner; the bell rings so it is noticed.
    this.waitingChanged("opened")
  }

  onUiResolved(data: EventMap["ui.resolved"]) {
    const i = this.dialogs.findIndex((d) => d.request.requestId === data.requestId)
    if (i !== -1) this.dialogs.splice(i, 1)
    const f = this.forms.find((r) => r.requestId === data.requestId)
    // Answered or cancelled elsewhere (another client, a timeout): close it without answering.
    if (f && this.form && this.forms[0] === f) this.form.close()
    else if (f) this.forms.splice(this.forms.indexOf(f), 1)
    this.openNextForm()
    this.waitingChanged("resolved")
  }

  handleInput(e: InputEvent): boolean {
    // A form or the viewer owns the keyboard while open: the rest is hidden. Ctrl+L repaints it.
    // Forms and the key reference use wheel arrows; extension views receive pointer coordinates.
    if (!this.hasFullscreen) return false
    if (this.deps.keys.is(e, "redraw")) {
      this.deps.view().redrawOverlay()
      return true
    }
    if (!this.form && this.viewer instanceof ExtensionViewer) {
      const viewer = this.viewer
      if (e.type === "mouse") {
        if (e.y >= this.inputTop && e.y < this.inputBottom) {
          if (e.action === "press" && e.button === "left") this.focusView(viewer, false)
          return true
        }
        if (e.y >= this.inputTop) return true
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
    for (const k of overlayKeys(e, false)) {
      if (this.form) this.form.handleInput(k)
      else this.viewer?.handleInput(k)
    }
    this.deps.view().requestOverlayRender()
    return true
  }

  private answerDialog(ui: UiRequests, dialog: Dialog, answer: DialogAnswer) {
    const i = this.dialogs.indexOf(dialog)
    if (i !== -1) this.dialogs.splice(i, 1)
    const { requestId } = dialog.request
    const refused = answer !== undefined && ui.respond(requestId, answer) !== undefined
    if (answer === undefined || refused) ui.cancel(requestId)
    // Esc on an approval denies the call and stops the whole turn, as the dialog's keys say.
    if (answer === undefined && dialog.request.source === "approval" && this.deps.working())
      this.deps.interrupt()
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

  /** Closes full-screen overlays; inline dialogs are cancelled at the later shutdown boundary. */
  dispose() {
    this.closeDock()
    for (const f of this.forms.splice(0)) this.deps.ui?.cancel(f.requestId)
    this.form?.close()
    this.closeView()
  }
}
