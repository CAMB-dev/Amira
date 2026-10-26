import {
  type EventMap,
  type ExtensionSettingField,
  type ExtensionSettingsPreviewContext,
  type ExtensionSettingsValues,
  type MarkdownRenderResult,
  validateExtensionSetting,
} from "@amira/api"
import type { UiRequests, UiResponseAck } from "@amira/core"
import {
  bold,
  type Component,
  colourSwatch,
  type HitRect,
  HitRegions,
  type ImageStore,
  type InputEvent,
  inverse,
  key,
  LineInput,
  type MouseInput,
  matchesKey,
  type RenderContext,
  type Theme,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { styledExtensionStatusBadge } from "./extension-status.ts"
import { glyphs, viewEllipsis } from "./glyphs.ts"
import { imageFallback, nodeRows } from "./markdown-nodes.ts"

export type ExtensionSettingsRequest = Extract<EventMap["ui.request"], { kind: "extension-settings" }>

/** Serializable page data, with preview and persistence kept behind the host boundary. */
export interface SettingsPageBackend {
  request: ExtensionSettingsRequest
  preview?(
    values: ExtensionSettingsValues,
    context: ExtensionSettingsPreviewContext,
  ): MarkdownRenderResult | Promise<MarkdownRenderResult>
  evaluate?(
    draft: { revision: number; values: ExtensionSettingsValues },
    context: ExtensionSettingsPreviewContext,
  ): Promise<{ revision: number; preview: MarkdownRenderResult }>
  submit(
    values: ExtensionSettingsValues,
    scope: "user" | "project",
  ): Promise<string | undefined | UiResponseAck>
  cancel: (() => void) | (() => UiResponseAck | Promise<UiResponseAck>)
}

export function uiExtensionSettingsBackend(
  ui: UiRequests,
  request: ExtensionSettingsRequest,
): SettingsPageBackend {
  const backend = ui.extensionSettingsBackend(request.requestId)
  const current = ui.claimExtensionSettingsEditor(request.requestId)
  const stale = (): UiResponseAck => ({ status: "invalid", message: "stale settings editor" })
  return {
    request,
    ...(backend?.preview
      ? { preview: (values, context) => (current() ? backend.preview!(values, context) : { lines: [] }) }
      : {}),
    submit: async (values, scope) => {
      if (!current()) return stale()
      const error = await ui.submitExtensionSettings(request.requestId, { values, scope })
      if (error) return { status: "invalid", message: error }
      return { status: "accepted" }
    },
    cancel: () => (current() ? ui.respondAcknowledged(request.requestId, undefined) : stale()),
  }
}

export interface ExtensionSettingsViewOptions {
  requestRender: () => void
  onClose: () => void
  waiting?: () => string[]
  images?: () => ImageStore | undefined
  /** The same current Markdown theme context used by the transcript's real renderers. */
  previewTheme?: () => ExtensionSettingsPreviewContext["theme"]
}

type SettingsMouseAction =
  | { kind: "field"; index: number; key?: "left" | "right" | "space"; column?: number }
  | { kind: "key"; key: "enter" | "escape" }
  | { kind: "scope"; scope: "user" | "project" }

interface SettingsTarget {
  id: string
  rect: HitRect
  action: SettingsMouseAction
}

interface SettingsRow {
  lines: string[]
  targets: SettingsTarget[]
}

/** A compact settings editor: draft preview above editable rows, footer always visible. */
export class ExtensionSettingsView implements Component {
  #backend: SettingsPageBackend
  #opts: ExtensionSettingsViewOptions
  #values: ExtensionSettingsValues
  #focus = 0
  #input = new Map<string, LineInput>()
  #numberInput: LineInput | undefined
  #scope: "user" | "project"
  #choosingScope = false
  #saving = false
  #cancelling = 0
  #error: string | undefined
  #closed = false
  #previewKey = ""
  #revision = 0
  #preview: MarkdownRenderResult | undefined
  #previewError: string | undefined
  #previewRunning = false
  #controller: AbortController | undefined
  #watching = new WeakSet<object>()
  #hits = new HitRegions()
  #mouseActions = new Map<string, SettingsMouseAction>()
  #fieldArea: HitRect | undefined

  constructor(backend: SettingsPageBackend, opts: ExtensionSettingsViewOptions) {
    this.#backend = backend
    this.#opts = opts
    this.#values = structuredClone(backend.request.values)
    this.#scope = backend.request.scope
    this.#syncInputs()
  }

  get closed(): boolean {
    return this.#closed
  }

  get values(): ExtensionSettingsValues {
    return structuredClone(this.#values)
  }

  /** Used also for timeout, external resolution, unload and terminal shutdown. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#controller?.abort()
    this.#preview = undefined
    this.#input.clear()
    this.#hits.reset()
    this.#mouseActions.clear()
    this.#fieldArea = undefined
    this.#opts.onClose()
  }

  #syncInputs(): void {
    for (const field of this.#backend.request.fields) {
      if (field.type !== "text" && field.type !== "colour") continue
      let input = this.#input.get(field.key)
      if (!input) {
        input = new LineInput(field.type === "colour" ? { accept: (g) => /^[#\da-f]$/i.test(g) } : {})
        this.#input.set(field.key, input)
      }
      input.value = String(this.#values[field.key] ?? field.default)
    }
  }

  #changed(key: string, value: string | number | boolean): void {
    this.#revision++
    this.#values = { ...this.#values, [key]: value }
    this.#error = undefined
    // Cancel immediately, before the next frame has a chance to start its replacement.
    this.#controller?.abort()
    this.#previewKey = ""
    this.#preview = undefined
    this.#opts.requestRender()
  }

  handleInput(event: InputEvent): boolean {
    if (this.#closed) return false
    if (this.#saving) return true
    if (event.type === "mouse") return this.#handleMouse(event)
    if (matchesKey(event, "escape")) {
      void this.#cancel()
      return true
    }
    if (this.#choosingScope) {
      if (
        matchesKey(event, "left") ||
        matchesKey(event, "right") ||
        matchesKey(event, "up") ||
        matchesKey(event, "down") ||
        matchesKey(event, "tab") ||
        matchesKey(event, "space")
      ) {
        this.#scope = this.#scope === "user" ? "project" : "user"
      } else if (matchesKey(event, "enter")) void this.#submit()
      this.#opts.requestRender()
      return true
    }
    const fields = this.#backend.request.fields
    const field = fields[this.#focus]
    if (matchesKey(event, "up") || matchesKey(event, "down") || matchesKey(event, "tab")) {
      const previous = matchesKey(event, "up") || matchesKey(event, "tab", { shift: true })
      this.#focus = (this.#focus + (previous ? -1 : 1) + fields.length) % fields.length
      this.#numberInput = undefined
      this.#error = undefined
      this.#opts.requestRender()
      return true
    }
    if (matchesKey(event, "enter")) {
      const invalid = fields.findIndex((f) => validateExtensionSetting(f, this.#values[f.key]) !== undefined)
      if (invalid !== -1) {
        this.#focus = invalid
        const current = fields[invalid]!
        this.#error = `${current.label}: ${validateExtensionSetting(current, this.#values[current.key])}`
      } else {
        this.#choosingScope = true
        this.#error = undefined
      }
      this.#opts.requestRender()
      return true
    }
    if (!field) return true
    if (matchesKey(event, "r", { ctrl: true })) {
      this.#changed(field.key, field.default)
      this.#numberInput = undefined
      this.#syncInputs()
      return true
    }
    const left = matchesKey(event, "left")
    const right = matchesKey(event, "right")
    const value = this.#values[field.key] ?? field.default
    if (field.type === "toggle") {
      if (matchesKey(event, "space") || left || right) this.#changed(field.key, !value)
    } else if (field.type === "choice" && (left || right)) {
      const choices = field.options.map((option) => (typeof option === "string" ? option : option.value))
      const index = choices.indexOf(String(value))
      this.#changed(field.key, choices[(index + (left ? -1 : 1) + choices.length) % choices.length]!)
    } else if (field.type === "number") {
      if (left || right || matchesKey(event, "+") || matchesKey(event, "-")) {
        const direction = left || matchesKey(event, "-") ? -1 : 1
        this.#changed(field.key, clampNumber(field, Number(value) + direction * (field.step ?? 1)))
        this.#numberInput = undefined
      } else {
        const typing =
          event.type === "paste" || (event.type === "key" && !!event.text && !event.ctrl && !event.alt)
        if (typing && !this.#numberInput)
          this.#numberInput = new LineInput({ accept: (g) => /^[\d.+-]$/.test(g) })
        if (this.#numberInput?.handleInput(event)) {
          const raw = this.#numberInput.value
          if (raw.trim() && Number.isFinite(Number(raw)))
            this.#changed(field.key, clampNumber(field, Number(raw)))
        }
      }
    } else if (field.type === "text" || field.type === "colour") {
      const input = this.#input.get(field.key)!
      const before = input.value
      if (input.handleInput(event)) {
        const limit = field.type === "text" ? field.maxLength : 7
        if (limit !== undefined) {
          const points = Array.from(input.value)
          if (points.length > limit) input.value = points.slice(0, limit).join("")
        }
        if (input.value !== before) this.#changed(field.key, input.value)
        else this.#opts.requestRender()
      }
    }
    return true
  }

  /** Coordinates are relative to the last rendered settings frame. */
  #handleMouse(event: MouseInput): boolean {
    if (this.#closed) return false
    if (this.#saving) return true
    if (event.action === "wheel") {
      const area = this.#fieldArea
      if (
        !area ||
        event.x < area.x ||
        event.x >= area.x + area.width ||
        event.y < area.y ||
        event.y >= area.y + area.height ||
        (event.button !== "up" && event.button !== "down")
      )
        return false
      // Legacy overlay wheel reports became three arrow keys; keep that navigation cadence.
      for (let i = 0; i < 3; i++) this.handleInput(key(event.button))
      return true
    }
    const hit = this.#hits.handle(event)
    const action = hit && this.#mouseActions.get(hit.id)
    if (!hit || !action) return true
    if (action.kind === "key") return this.handleInput(key(action.key))
    if (action.kind === "scope") {
      if (this.#choosingScope && this.#scope !== action.scope) this.handleInput(key("right"))
      return true
    }
    if (this.#choosingScope) return true
    if (this.#focus !== action.index) {
      this.#focus = action.index
      this.#numberInput = undefined
      this.#error = undefined
    }
    if (action.key) return this.handleInput(key(action.key))
    if (action.column !== undefined) {
      const field = this.#backend.request.fields[action.index]!
      this.#input.get(field.key)?.placeCursor(event.x - action.column)
    }
    this.#opts.requestRender()
    return true
  }

  #addTarget(target: SettingsTarget): void {
    this.#hits.add(target.id, target.rect)
    this.#mouseActions.set(target.id, target.action)
  }

  async #cancel(): Promise<void> {
    const sequence = ++this.#cancelling
    const values = this.#values
    const scope = this.#scope
    const current = () =>
      !this.#closed && sequence === this.#cancelling && values === this.#values && scope === this.#scope
    try {
      const result = this.#backend.cancel()
      const ack = result instanceof Promise ? await result : result
      if (!current()) return
      if (!ack || typeof ack !== "object" || ["accepted", "cancelled", "settled"].includes(ack.status))
        this.close()
      else if ("message" in ack) this.#error = ack.message
    } catch (error) {
      if (!current()) return
      this.#error = error instanceof Error ? error.message : String(error)
    }
    this.#opts.requestRender()
  }

  async #submit(): Promise<void> {
    this.#saving = true
    this.#opts.requestRender()
    let error: string | undefined
    try {
      const response = await this.#backend.submit(this.values, this.#scope)
      error = typeof response === "object" ? ("message" in response ? response.message : undefined) : response
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    if (this.#closed) return
    this.#saving = false
    if (!error) this.close()
    else {
      this.#error = error
      this.#choosingScope = false
      this.#opts.requestRender()
    }
  }

  render(width: number, ctx: RenderContext): string[] {
    this.#hits.clear()
    this.#mouseActions.clear()
    this.#fieldArea = undefined
    if (this.#closed) return []
    const room = Math.max(1, width)
    const height = Math.max(1, ctx.rows)
    const { theme } = ctx
    const ascii = /^[\x20-\x7e]+$/.test(glyphs.pointer)
    const focused = this.#backend.request.fields[this.#focus]
    const editHint =
      focused?.type === "number"
        ? "left/right +/-"
        : focused?.type === "choice"
          ? "left/right change"
          : focused?.type === "toggle"
            ? "space toggle"
            : "type to edit"
    const footerText = this.#saving
      ? "saving settings"
      : this.#choosingScope
        ? "left/right scope · enter save · esc discard"
        : `${ascii ? "up/down" : "↑↓"} focus · ${editHint} · enter save · esc discard · ctrl+r reset`
    const hints: string[] = []
    const footerTargets: SettingsTarget[] = []
    for (const hint of footerText.split(" · ")) {
      const last = hints.at(-1)
      const separator = ` ${glyphs.separator} `
      const combined = last ? `${last}${separator}${hint}` : hint
      const action = hint === "enter save" ? "enter" : hint === "esc discard" ? "escape" : undefined
      const addFooterTarget = (x: number, y: number, text: string) => {
        if (action)
          footerTargets.push({
            id: `footer:${action}:${y}`,
            rect: { x, y, width: visibleWidth(text), height: 1 },
            action: { kind: "key", key: action },
          })
      }
      if (last && visibleWidth(combined) <= room) {
        addFooterTarget(visibleWidth(last + separator), hints.length - 1, hint)
        hints[hints.length - 1] = combined
      } else {
        for (const line of wrapText(hint, room)) {
          addFooterTarget(0, hints.length, line)
          hints.push(line)
        }
      }
    }
    const footer = hints.map(theme.muted)
    const status = this.#backend.request.extensionStatus
    const badge = status ? styledExtensionStatusBadge(status, theme) : ""
    const title = truncateToWidth(
      `${bold(theme.accent(this.#backend.request.title))}${badge ? ` ${badge}` : ""}`,
      room,
      viewEllipsis(),
    )
    // Short terminals keep the action keys and a focused control before optional preview/description.
    const footerRows = footer.slice(0, Math.max(1, Math.min(footer.length, height - 2)))
    const bodyBudget = Math.max(0, height - 1 - footerRows.length)
    const fields = this.#backend.request.fields
    const fieldRows = fields.map((field, index) => this.#row(field, index, room, theme, ascii))
    const focusedRows = fieldRows[this.#focus]?.lines ?? []
    const minControlRows = Math.min(bodyBudget, focusedRows.length || 1)
    const previewBudget = Math.max(0, Math.min(Math.floor(height * 0.35), bodyBudget - minControlRows - 1))
    const preview = this.#previewRows(room, previewBudget, ctx)
    const reserved = preview.length + (preview.length ? 1 : 0)
    let body: string[] = []
    const bodyTop = 1 + reserved
    const bodyBottom = height - footerRows.length
    const addBodyTarget = (target: SettingsTarget, offset = 0) => {
      const y = bodyTop + offset + target.rect.y
      const targetHeight = Math.min(target.rect.height, bodyBottom - y)
      const targetWidth = Math.min(target.rect.width, room - target.rect.x)
      if (targetHeight > 0 && targetWidth > 0)
        this.#addTarget({ ...target, rect: { ...target.rect, y, width: targetWidth, height: targetHeight } })
    }
    if (this.#choosingScope || this.#saving) {
      body = wrapText("save settings to", room).map(theme.muted)
      body.push(
        truncateToWidth(
          `${this.#scope === "user" ? inverse(theme.accent("[ user ]")) : theme.muted("  user  ")}  ${this.#scope === "project" ? inverse(theme.accent("[ project ]")) : theme.muted("  project  ")}`,
          room,
          viewEllipsis(),
        ),
      )
      if (!this.#saving) {
        for (const [scope, x, targetWidth] of [
          ["user", 0, 8],
          ["project", 10, 11],
        ] as const) {
          // Do not turn a truncation marker into a scope button.
          const visible = visibleWidth(body.at(-1)!)
          const limit = room < 21 ? Math.max(0, room - visibleWidth(viewEllipsis())) : visible
          addBodyTarget({
            id: `scope:${scope}`,
            rect: { x, y: body.length - 1, width: Math.min(targetWidth, limit - x), height: 1 },
            action: { kind: "scope", scope },
          })
        }
      }
    } else {
      const budget = Math.max(0, bodyBudget - reserved)
      const field = fields[this.#focus]
      const source = field ? `source: ${this.#backend.request.sources?.[field.key] ?? "default"}` : ""
      const detail = this.#error ?? [source, field?.description].filter(Boolean).join(` ${glyphs.separator} `)
      if (detail && focusedRows.length < budget) {
        const style = this.#error ? theme.error : theme.muted
        focusedRows.push(
          ...wrapText(detail, room)
            .slice(0, Math.min(3, budget - focusedRows.length))
            .map(style),
        )
      }
      // Show the focused row and its description before spending space on adjacent fields.
      let start = this.#focus
      let end = start + 1
      let used = focusedRows.length
      while (start > 0 && used + fieldRows[start - 1]!.lines.length <= budget)
        used += fieldRows[--start]!.lines.length
      while (end < fieldRows.length && used + fieldRows[end]!.lines.length <= budget)
        used += fieldRows[end++]!.lines.length
      const shown = fieldRows.slice(start, end)
      body = shown.flatMap((row) => row.lines).slice(0, budget)
      let offset = 0
      for (const row of shown) {
        for (const target of row.targets) addBodyTarget(target, offset)
        offset += row.lines.length
      }
      if (body.length) this.#fieldArea = { x: 0, y: bodyTop, width: room, height: body.length }
      const waiting = this.#opts.waiting?.() ?? []
      if (waiting.length && budget > body.length)
        body.push(
          truncateToWidth(
            theme.muted(`${waiting.length} dialogs wait: ${waiting.join(", ")}`),
            room,
            viewEllipsis(),
          ),
        )
    }
    if (!this.#saving) {
      for (const target of footerTargets)
        if (target.rect.y < footerRows.length)
          this.#addTarget({ ...target, rect: { ...target.rect, y: bodyBottom + target.rect.y } })
    }
    const lines = [title, ...preview, ...(preview.length ? [""] : []), ...body]
    while (lines.length < height - footerRows.length) lines.push("")
    return [...lines.slice(0, height - footerRows.length), ...footerRows].slice(0, height)
  }

  #row(
    field: ExtensionSettingField,
    index: number,
    width: number,
    theme: Theme,
    ascii: boolean,
  ): SettingsRow {
    const focused = index === this.#focus
    const value = this.#values[field.key] ?? field.default
    const changed = value !== field.default ? " *" : ""
    const label = `${focused ? glyphs.pointer : " "} ${field.label}${changed}`
    const labelStyle = focused ? theme.accent : theme.text
    const controlStyle = focused ? (text: string) => inverse(theme.borderFocused(text)) : theme.fg2
    const stepper = (button: string, disabled = false) =>
      focused && !disabled ? theme.borderFocused(button) : theme.muted(button)
    let control: string
    switch (field.type) {
      case "number":
        control = `${stepper("-", field.min !== undefined && Number(value) <= field.min)} ${controlStyle(String(value))} ${stepper("+", field.max !== undefined && Number(value) >= field.max)}`
        break
      case "choice": {
        const option = field.options.find((o) => (typeof o === "string" ? o : o.value) === value)
        const shown = typeof option === "string" ? option : (option?.label ?? String(value))
        control = `${stepper(ascii ? "<" : "‹")} ${controlStyle(shown)} ${stepper(ascii ? ">" : "›")}`
        break
      }
      case "toggle":
        control = controlStyle(value ? "on" : "off")
        break
      default: {
        const input = this.#input.get(field.key)!
        const labelWidth = visibleWidth(label) + 2
        const inputWidth = width - labelWidth >= 12 ? width - labelWidth - 2 : width - 4
        const text = input.render(Math.max(1, inputWidth), theme, {
          focused,
          placeholder: field.type === "text" ? field.placeholder : "#rrggbb",
        })
        control = controlStyle(`[ ${text} ]`)
        if (field.type === "colour" && /^#[\da-f]{6}$/i.test(String(value))) {
          const swatch = colourSwatch(String(value), ascii ? "##" : "██")
          control = `${swatch} ${control}`
        }
      }
    }
    const inline = visibleWidth(label) + 2 + visibleWidth(control) <= width
    const lines = inline
      ? [truncateToWidth(`${labelStyle(label)}  ${control}`, width, viewEllipsis())]
      : [
          truncateToWidth(labelStyle(label), width, viewEllipsis()),
          truncateToWidth(`  ${control}`, width, viewEllipsis()),
        ]
    const x = inline ? visibleWidth(label) + 2 : 2
    const y = inline ? 0 : 1
    const targets: SettingsTarget[] = [
      {
        id: `field:${index}`,
        rect: { x: 0, y: 0, width, height: lines.length },
        action: { kind: "field", index, ...(field.type === "toggle" ? { key: "space" } : {}) },
      },
    ]
    const controlWidth = visibleWidth(control)
    const limit = x + controlWidth <= width ? width : Math.max(0, width - visibleWidth(viewEllipsis()))
    const add = (id: string, column: number, size: number, action: SettingsMouseAction) => {
      const shown = Math.min(size, limit - column)
      if (shown > 0)
        targets.push({ id: `${id}:${index}`, rect: { x: column, y, width: shown, height: 1 }, action })
    }
    if (field.type === "number" || field.type === "choice") {
      add("left", x, 1, { kind: "field", index, key: "left" })
      add("right", x + controlWidth - 1, 1, { kind: "field", index, key: "right" })
    } else if (field.type === "text" || field.type === "colour") {
      const swatch = field.type === "colour" && /^#[\da-f]{6}$/i.test(String(value)) ? 3 : 0
      const column = x + swatch + 2
      add("input", x + swatch, controlWidth - swatch, { kind: "field", index, column })
    }
    return { lines, targets }
  }

  #previewRows(width: number, budget: number, ctx: RenderContext): string[] {
    if (!this.#backend.preview && !this.#backend.evaluate) return []
    if (budget < 1) {
      this.#controller?.abort()
      this.#previewKey = ""
      return []
    }
    const store = ctx.place ? this.#opts.images?.() : undefined
    const theme = this.#opts.previewTheme?.() ?? { dark: true }
    const context = { width, images: !!store, maxImageRows: Math.min(budget, store?.maxRows() ?? 0), theme }
    const key = JSON.stringify([this.#values, context])
    if (this.#previewKey !== key) {
      this.#controller?.abort()
      const controller = new AbortController()
      this.#controller = controller
      this.#previewKey = key
      this.#preview = undefined
      this.#watching = new WeakSet()
      this.#previewError = undefined
      this.#previewRunning = true
      const draft = this.values
      const revision = ++this.#revision
      // Defer callbacks until this frame has completed; synchronous previews redraw too.
      void Promise.resolve()
        .then(async () => {
          controller.signal.throwIfAborted()
          const options = { ...context, signal: controller.signal }
          if (!this.#backend.evaluate) return this.#backend.preview!(draft, options)
          const reply = await this.#backend.evaluate({ revision, values: draft }, options)
          if (reply.revision !== revision) return undefined
          return reply.preview
        })
        .then(
          (result) => {
            if (controller.signal.aborted || this.#closed || this.#revision !== revision) return
            this.#preview = result
            this.#previewRunning = false
            this.#opts.requestRender()
          },
          (error) => {
            if (controller.signal.aborted || this.#closed) return
            this.#previewRunning = false
            this.#previewError = error instanceof Error ? error.message : String(error)
            this.#opts.requestRender()
          },
        )
    }
    const result = this.#preview
    if (!result)
      return [
        ctx.theme.muted(
          truncateToWidth(
            this.#previewError ? `preview: ${this.#previewError}` : this.#previewRunning ? "previewing" : "",
            width,
            viewEllipsis(),
          ),
        ),
      ]
    if ("lines" in result) return nodeRows(result.lines.slice(0, 900), ctx.theme, width).slice(0, budget)
    if ("segments" in result)
      return [
        truncateToWidth(
          nodeRows(result.segments.slice(0, 900), ctx.theme, width, true).join(""),
          width,
          viewEllipsis(),
        ),
      ]
    const fallback = () => imageFallback(result, [], ctx.theme, width).slice(0, budget)
    if (!store) return fallback()
    const source = store.screen(result.image)
    const controller = this.#controller
    const changed = () => {
      if (!this.#closed && this.#controller === controller && !controller?.signal.aborted)
        this.#opts.requestRender()
    }
    if (!this.#watching.has(source)) {
      this.#watching.add(source)
      source.onSettled(changed)
    }
    const image = source.image(width, context.maxImageRows)
    if (!image || image.broken) return fallback()
    image.want()
    if (!image.ready) {
      if (!this.#watching.has(image)) {
        this.#watching.add(image)
        image.whenReady(changed)
      }
      return fallback()
    }
    // Title occupies row zero; image placements follow it.
    ctx.place?.({
      key: `extension-settings:${this.#backend.request.requestId}`,
      image,
      row: 1,
      col: 0,
      from: 0,
      to: image.rows,
    })
    return Array.from({ length: image.rows }, () => "")
  }
}

function clampNumber(field: Extract<ExtensionSettingField, { type: "number" }>, value: number): number {
  const step = field.step
  const base = field.min ?? 0
  const bounded = Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, value))
  if (step === undefined) return bounded
  let steps = Math.round((bounded - base) / step)
  if (field.max !== undefined) steps = Math.min(steps, Math.floor((field.max - base) / step + 1e-8))
  return Number((base + steps * step).toPrecision(12))
}
