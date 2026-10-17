import {
  type EventMap,
  type ExtensionSettingField,
  type ExtensionSettingsPreviewContext,
  type ExtensionSettingsValues,
  type MarkdownRenderResult,
  validateExtensionSetting,
} from "@amira/api"
import type { UiRequests } from "@amira/core"
import {
  bold,
  type Component,
  colourSwatch,
  type ImageStore,
  type InputEvent,
  inverse,
  LineInput,
  matchesKey,
  type RenderContext,
  type Theme,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"
import { imageFallback, nodeRows } from "./markdown-nodes.ts"

export type ExtensionSettingsRequest = Extract<EventMap["ui.request"], { kind: "extension-settings" }>

/** Serializable page data, with preview and persistence kept behind the host boundary. */
export interface SettingsPageBackend {
  request: ExtensionSettingsRequest
  preview?(
    values: ExtensionSettingsValues,
    context: ExtensionSettingsPreviewContext,
  ): MarkdownRenderResult | Promise<MarkdownRenderResult>
  submit(values: ExtensionSettingsValues, scope: "user" | "project"): Promise<string | undefined>
  cancel(): void
}

export function uiExtensionSettingsBackend(
  ui: UiRequests,
  request: ExtensionSettingsRequest,
): SettingsPageBackend {
  const backend = ui.extensionSettingsBackend(request.requestId)
  return {
    request,
    ...(backend?.preview ? { preview: (values, context) => backend.preview!(values, context) } : {}),
    submit: (values, scope) => ui.submitExtensionSettings(request.requestId, { values, scope }),
    cancel: () => void ui.cancel(request.requestId),
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

/** A compact settings editor: draft preview above keyboard-operated rows, footer always visible. */
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
  #error: string | undefined
  #closed = false
  #previewKey = ""
  #preview: MarkdownRenderResult | undefined
  #previewError: string | undefined
  #previewRunning = false
  #controller: AbortController | undefined
  #watching = new WeakSet<object>()

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
    if (matchesKey(event, "escape")) {
      this.#backend.cancel()
      this.close()
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

  async #submit(): Promise<void> {
    this.#saving = true
    this.#opts.requestRender()
    let error: string | undefined
    try {
      error = await this.#backend.submit(this.values, this.#scope)
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
    for (const hint of footerText.split(" · ")) {
      const last = hints.at(-1)
      const combined = last ? `${last} ${glyphs.separator} ${hint}` : hint
      if (last && visibleWidth(combined) <= room) hints[hints.length - 1] = combined
      else hints.push(...wrapText(hint, room))
    }
    const footer = hints.map(theme.muted)
    const title = truncateToWidth(bold(theme.accent(this.#backend.request.title)), room, glyphs.more)
    // Short terminals keep the action keys and a focused control before optional preview/description.
    const footerRows = footer.slice(0, Math.max(1, Math.min(footer.length, height - 2)))
    const bodyBudget = Math.max(0, height - 1 - footerRows.length)
    const fields = this.#backend.request.fields
    const fieldRows = fields.map((field, index) =>
      this.#row(field, index === this.#focus, room, theme, ascii),
    )
    const focusedRows = fieldRows[this.#focus] ?? []
    const minControlRows = Math.min(bodyBudget, focusedRows.length || 1)
    const previewBudget = Math.max(0, Math.min(Math.floor(height * 0.35), bodyBudget - minControlRows - 1))
    const preview = this.#previewRows(room, previewBudget, ctx)
    const reserved = preview.length + (preview.length ? 1 : 0)
    let body: string[] = []
    if (this.#choosingScope || this.#saving) {
      body = wrapText("save settings to", room).map(theme.muted)
      body.push(
        truncateToWidth(
          `${this.#scope === "user" ? inverse(theme.accent("[ user ]")) : theme.muted("  user  ")}  ${this.#scope === "project" ? inverse(theme.accent("[ project ]")) : theme.muted("  project  ")}`,
          room,
          glyphs.more,
        ),
      )
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
      while (start > 0 && used + fieldRows[start - 1]!.length <= budget) used += fieldRows[--start]!.length
      while (end < fieldRows.length && used + fieldRows[end]!.length <= budget)
        used += fieldRows[end++]!.length
      body = fieldRows.slice(start, end).flat().slice(0, budget)
      const waiting = this.#opts.waiting?.() ?? []
      if (waiting.length && budget > body.length)
        body.push(
          truncateToWidth(
            theme.muted(`${waiting.length} dialogs wait: ${waiting.join(", ")}`),
            room,
            glyphs.more,
          ),
        )
    }
    const lines = [title, ...preview, ...(preview.length ? [""] : []), ...body]
    while (lines.length < height - footerRows.length) lines.push("")
    return [...lines.slice(0, height - footerRows.length), ...footerRows].slice(0, height)
  }

  #row(
    field: ExtensionSettingField,
    focused: boolean,
    width: number,
    theme: Theme,
    ascii: boolean,
  ): string[] {
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
    if (visibleWidth(label) + 2 + visibleWidth(control) <= width)
      return [truncateToWidth(`${labelStyle(label)}  ${control}`, width, glyphs.more)]
    return [
      truncateToWidth(labelStyle(label), width, glyphs.more),
      truncateToWidth(`  ${control}`, width, glyphs.more),
    ]
  }

  #previewRows(width: number, budget: number, ctx: RenderContext): string[] {
    if (!this.#backend.preview) return []
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
      // Defer callbacks until this frame has completed; synchronous previews redraw too.
      void Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted()
          return this.#backend.preview!(draft, { ...context, signal: controller.signal })
        })
        .then(
          (result) => {
            if (controller.signal.aborted || this.#closed) return
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
            glyphs.more,
          ),
        ),
      ]
    if ("lines" in result) return nodeRows(result.lines.slice(0, 900), ctx.theme, width).slice(0, budget)
    if ("segments" in result)
      return [
        truncateToWidth(
          nodeRows(result.segments.slice(0, 900), ctx.theme, width, true).join(""),
          width,
          glyphs.more,
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
