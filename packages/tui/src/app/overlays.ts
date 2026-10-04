// Owns dialogs, full-screen viewers, waiting forms and their input and lifecycle.
import { type AnyEvent, type EventMap, type FrontendView, isSubagentView } from "@amira/api"
import type { UiRequests } from "@amira/core"
import type { InputEvent, RenderContext, Theme } from "@amira/tui-kit"
import { Dialog, type DialogAnswer, dialogEchoLines } from "../dialog.ts"
import { ExtensionViewer, type ViewSource } from "../extension-view.ts"
import { type FormRequest, FormView, uiFormBackend } from "../form-view.ts"
import { KeyReference } from "../key-reference.ts"
import type { Keybindings, KeySpec } from "../keybindings.ts"
import type { PresenterSource } from "../tool-view.ts"
import type { TranscriptView } from "../view.ts"
import { overlayKeys } from "./startup.ts"

export interface OverlayManagerDeps {
  ui?: UiRequests
  views?: ViewSource
  keys: Keybindings
  theme: Theme
  presenters?: PresenterSource
  mode: "inline" | "fullscreen"
  env: Record<string, string | undefined>
  reaches: (spec: KeySpec) => boolean
  view: () => TranscriptView
  /** Emits on the active session's bus, which can change while the UI is open. */
  emitWaiting: (data: EventMap["ui.waiting"]) => void
  working: () => boolean
  interrupt: () => void
  quitting: () => boolean
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
  private viewerTimer: ReturnType<typeof setInterval> | undefined
  /**
   * Forms (ui.form) waiting to be shown full screen, oldest first; the first one is open while
   * `form` is set. A form waits while an inline dialog or the viewer is up, and inline dialogs
   * that arrive while a form is open wait behind it.
   */
  private readonly forms: FormRequest[] = []
  private form: FormView | undefined

  constructor(private readonly deps: OverlayManagerDeps) {}

  get hasFullscreen(): boolean {
    return !!(this.form || this.viewer)
  }

  render(width: number, ctx: RenderContext): string[] {
    return this.form ? this.form.render(width, ctx) : (this.viewer?.render(width, ctx) ?? [])
  }

  waitingChanged(change: EventMap["ui.waiting"]["change"]) {
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
    // Keep old command requests working through the same extension lookup.
    if (isSubagentView(v)) v = { ...v, data: { sessionId: v.sessionId } }
    const definition = this.deps.views?.get(v.kind)
    if (!definition) throw new Error(`there is no "${v.kind}" view`)
    if (this.deps.quitting() || this.form || env.TERM === "dumb") return false
    if (this.viewer instanceof ExtensionViewer && this.viewer.kind === v.kind)
      this.viewer.show(v.data, v.state)
    else {
      const next = new ExtensionViewer(definition, v.data, {
        keys,
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
      this.showOverlay(next)
    }
    if (!(this.viewer instanceof ExtensionViewer) || this.viewer.ready) this.deps.view().renderOverlay()
    return true
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
    if (previous instanceof ExtensionViewer) previous.dispose()
    if (this.viewer !== next) return
    if (next instanceof ExtensionViewer) next.mount()
    if (this.viewer !== next) return
    this.deps.view().openOverlay(next instanceof ExtensionViewer)
    if (!this.viewerTimer) this.viewerTimer = setInterval(() => this.deps.view().requestOverlayRender(), 1000)
    this.waitingChanged("visibility")
  }

  private closeView() {
    const previous = this.viewer
    if (!previous) return
    this.viewer = undefined
    clearInterval(this.viewerTimer)
    this.viewerTimer = undefined
    this.deps.view().closeOverlay()
    if (previous instanceof ExtensionViewer) previous.dispose()
    this.openNextForm()
    this.waitingChanged("visibility")
  }

  /** Shows the first waiting form, unless a dialog, the viewer or another form is up. */
  private openNextForm() {
    const ui = this.deps.ui
    const next = this.forms[0]
    if (!ui || !next || this.form || this.viewer || this.dialogs.length) return
    this.form = new FormView(uiFormBackend(ui, next), {
      requestRender: () => this.deps.view().requestOverlayRender(),
      waiting: this.waitingTitles,
      onClose: () => this.closeForm(next),
    })
    this.deps.view().openOverlay()
    this.deps.view().renderOverlay()
  }

  /** The open form was answered, cancelled, or resolved elsewhere: back to the conversation. */
  private closeForm(request: FormRequest) {
    const i = this.forms.indexOf(request)
    if (i !== -1) this.forms.splice(i, 1)
    if (!this.form) return
    this.form = undefined
    this.deps.view().closeOverlay()
    this.openNextForm()
    this.waitingChanged("resolved")
  }

  onEvent(e: AnyEvent) {
    // An extension's view may show anything: it is drawn again at each event (at most once a frame).
    if (this.viewer instanceof ExtensionViewer || this.viewer?.handleEvent())
      this.deps.view().requestOverlayRender()
    if (this.form && (e.type === "ui.request" || e.type === "ui.resolved"))
      this.deps.view().requestOverlayRender()
  }

  onUiRequest(data: EventMap["ui.request"]) {
    const ui = this.deps.ui
    if (!ui) return
    if (data.kind === "form") {
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
    for (const k of overlayKeys(e, !this.form && this.viewer instanceof ExtensionViewer)) {
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
    for (const f of this.forms.splice(0)) this.deps.ui?.cancel(f.requestId)
    this.form?.close()
    this.closeView()
  }
}
