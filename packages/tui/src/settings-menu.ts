import type { ShimmerEffect, TuiSettings } from "@amira/api"
import {
  bold,
  chromeGlyphs,
  type HitRect,
  HitRegions,
  type InputEvent,
  inverse,
  type MouseInput,
  matchesKey,
  type RenderContext,
  Spinner,
  themeToken,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import type { LocalOverlay } from "./app/overlays.ts"
import { paintShimmer, SHIMMER_INTERVAL_MS } from "./app/shimmer.ts"
import { asciiGlyphs, glyphs, viewEllipsis } from "./glyphs.ts"
import { contentGeometry } from "./margins.ts"
import {
  type FieldControlAction,
  floatingPreviewCardWidth,
  type PreviewHit,
  renderFloatingPreviewCard,
  renderLayoutPreviewStage,
  renderSettingsFieldRows,
  renderThemePreviewStage,
} from "./settings-preview.ts"
import {
  defaultEditableSettings,
  diffEditableSettings,
  type EditableTuiKey,
  type EditableTuiSettings,
  type NumberField,
  resolveEditableSettings,
  SETTINGS_FIELDS,
  SETTINGS_SECTIONS,
  type SettingsField,
  type SettingsSectionId,
} from "./settings-schema.ts"
import type { OverlayCardSpec } from "./view.ts"

export {
  defaultEditableSettings,
  diffEditableSettings,
  type EditableTuiKey,
  type EditableTuiSettings,
  resolveEditableSettings,
  SETTINGS_FIELDS,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  shimmerEffectFromChoice,
} from "./settings-schema.ts"

export type FloatingPreviewKind = "layout" | "appearance"

type MouseAction =
  | FieldControlAction
  | { kind: "tab"; section: SettingsSectionId }
  | { kind: "open-preview"; preview: FloatingPreviewKind }
  | { kind: "preview-ok" }
  | { kind: "preview-cancel" }
  | { kind: "action"; action: "save" | "reset-tab" | "defaults" | "cancel" }

const FLOATING_KEYS: Record<FloatingPreviewKind, readonly EditableTuiKey[]> = {
  layout: ["margin", "marginRows"],
  appearance: ["theme", "themeVariant", "colorDepth", "shimmer"],
}

export interface SettingsViewOptions {
  initial: TuiSettings
  runtimeTheme?: {
    name: string
    themeVariant: NonNullable<TuiSettings["themeVariant"]>
    shimmer?: ShimmerEffect
  }
  themeNames?: readonly string[]
  initialSection?: SettingsSectionId
  initialPreview?: FloatingPreviewKind
  viewport?: () => { columns: number; rows: number }
  now?: () => number
  onPreview: (
    draft: EditableTuiSettings,
    mode: { tab: SettingsSectionId; floating?: FloatingPreviewKind },
  ) => void
  onSave: (patch: Partial<TuiSettings>, draft: EditableTuiSettings) => void
  onCancel: () => void
}

function padCell(text: string, width: number): string {
  const cut = truncateToWidth(text, width, viewEllipsis())
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)))
}

function topBorder(left: string, right: string, width: number, ctx: RenderContext, ascii: boolean): string {
  const { theme } = ctx
  const tl = ascii ? "+" : "╭"
  const tr = ascii ? "+" : "╮"
  const h = ascii ? "-" : "─"
  const inner = Math.max(0, width - 2)
  const rightPart = right ? ` ${right} ` : ""
  const rightW = visibleWidth(rightPart)
  const leftRoom = Math.max(0, inner - rightW - 2)
  const leftPart = ` ${truncateToWidth(left, leftRoom, viewEllipsis())} `
  const fill = Math.max(0, inner - 1 - visibleWidth(leftPart) - rightW)
  return (
    theme.border(`${tl}${h}`) +
    leftPart +
    theme.border(h.repeat(fill)) +
    (rightPart ? rightPart : "") +
    theme.border(tr)
  )
}

/**
 * Fullscreen top-tab Settings view with inline Layout/Theme live previews and a translucent
 * centered floating card mode (`[ OK ]` / `[ Cancel ]`) over the live dimmed conversation.
 */
export class SettingsView implements LocalOverlay {
  readonly pointer = true
  readonly #initial: EditableTuiSettings
  readonly #originalShimmer: ShimmerEffect | undefined
  readonly #themeNames: readonly string[]
  #draft: EditableTuiSettings
  #tab: SettingsSectionId
  #floatingPreview: FloatingPreviewKind | undefined
  #previewCheckpoint: EditableTuiSettings | undefined
  #fieldFocus = 0
  #closed = false
  #hits = new HitRegions()
  #actions = new Map<string, MouseAction>()
  #opts: SettingsViewOptions

  constructor(opts: SettingsViewOptions) {
    this.#opts = opts
    this.#themeNames = opts.themeNames ?? []
    this.#originalShimmer = opts.runtimeTheme ? opts.runtimeTheme.shimmer : opts.initial.shimmer
    this.#initial = resolveEditableSettings(opts.initial, opts.runtimeTheme)
    this.#draft = { ...this.#initial }
    this.#tab = opts.initialSection ?? opts.initialPreview ?? "layout"
    if (opts.initialPreview) {
      this.#floatingPreview = opts.initialPreview
      this.#previewCheckpoint = { ...this.#draft }
    }
  }

  get draft(): EditableTuiSettings {
    return { ...this.#draft }
  }

  get activeTab(): SettingsSectionId {
    return this.#tab
  }

  get floatingPreview(): FloatingPreviewKind | undefined {
    return this.#floatingPreview
  }

  get dirty(): boolean {
    return Object.keys(diffEditableSettings(this.#initial, this.#draft, this.#originalShimmer)).length > 0
  }

  /** Animate live shimmer smoothly when on the Theme tab or Theme floating preview. */
  get refreshIntervalMs(): number | undefined {
    if (this.#closed) return undefined
    if (this.#tab === "appearance" || this.#floatingPreview === "appearance") return SHIMMER_INTERVAL_MS
    return undefined
  }

  /** Opt into the translucent centered floating card with live-updating dimmed conversation backdrop. */
  overlayCardSpec(width: number, ctx: Pick<RenderContext, "rows">): OverlayCardSpec | undefined {
    if (!this.#floatingPreview || width < 60 || ctx.rows < 20) return undefined
    return { width: floatingPreviewCardWidth(width), live: true }
  }

  dispose(): void {
    this.#closed = true
    this.#hits.reset()
    this.#actions.clear()
  }

  #activeFields(): SettingsField[] {
    if (this.#floatingPreview) {
      const keys = FLOATING_KEYS[this.#floatingPreview]
      return keys
        .map((key) => SETTINGS_FIELDS.find((f) => f.key === key))
        .filter((f): f is SettingsField => f !== undefined)
    }
    return SETTINGS_FIELDS.filter((f) => f.section === this.#tab)
  }

  #tabDirty(section: SettingsSectionId): boolean {
    return SETTINGS_FIELDS.some((f) => f.section === section && this.#draft[f.key] !== this.#initial[f.key])
  }

  #emitPreview(): void {
    this.#opts.onPreview(this.draft, { tab: this.#tab, floating: this.#floatingPreview })
  }

  #selectTab(section: SettingsSectionId): void {
    if (this.#tab === section && !this.#floatingPreview) return
    this.#tab = section
    this.#fieldFocus = 0
    this.#emitPreview()
  }

  #enterFloatingPreview(kind: FloatingPreviewKind): void {
    this.#tab = kind
    this.#floatingPreview = kind
    this.#previewCheckpoint = { ...this.#draft }
    this.#fieldFocus = 0
    this.#emitPreview()
  }

  #confirmFloatingPreview(): void {
    if (!this.#floatingPreview) return
    this.#floatingPreview = undefined
    this.#previewCheckpoint = undefined
    this.#fieldFocus = 0
    this.#emitPreview()
  }

  #cancelFloatingPreview(): void {
    if (!this.#floatingPreview) return
    if (this.#previewCheckpoint) this.#draft = { ...this.#previewCheckpoint }
    this.#floatingPreview = undefined
    this.#previewCheckpoint = undefined
    this.#fieldFocus = 0
    this.#emitPreview()
  }

  #setValue<K extends EditableTuiKey>(key: K, value: EditableTuiSettings[K]): void {
    if (this.#draft[key] === value) return
    this.#draft = { ...this.#draft, [key]: value }
    this.#emitPreview()
  }

  #stepNumber(field: NumberField, delta: -1 | 1): void {
    const next = Math.max(field.min, Math.min(field.max, this.#draft[field.key] + delta))
    this.#setValue(field.key, next)
  }

  #optionsOf(field: Extract<SettingsField, { kind: "choice" }>) {
    const base = typeof field.options === "function" ? field.options(this.#themeNames) : field.options
    const current = this.#draft[field.key]
    if (base.some((o) => o.value === current)) return base
    return [...base, { value: current, label: String(current) }]
  }

  #adjustFocused(delta: -1 | 1): void {
    const field = this.#activeFields()[this.#fieldFocus]
    if (!field) return
    if (field.kind === "number") {
      this.#stepNumber(field, delta)
    } else if (field.kind === "toggle") {
      this.#setValue(field.key, !this.#draft[field.key])
    } else {
      const options = this.#optionsOf(field)
      const idx = Math.max(
        0,
        options.findIndex((o) => o.value === this.#draft[field.key]),
      )
      const next = options[(idx + delta + options.length) % options.length]!
      this.#setValue(field.key, next.value)
    }
  }

  #resetTab(): void {
    const next = { ...this.#draft }
    let changed = false
    for (const field of SETTINGS_FIELDS.filter((f) => f.section === this.#tab)) {
      if (next[field.key] !== field.defaultValue) {
        Object.assign(next, { [field.key]: field.defaultValue })
        changed = true
      }
    }
    if (!changed) return
    this.#draft = next
    this.#emitPreview()
  }

  #resetAll(): void {
    const defaults = defaultEditableSettings()
    if (Object.keys(diffEditableSettings(this.#draft, defaults, this.#originalShimmer)).length === 0) return
    this.#draft = defaults
    this.#emitPreview()
  }

  #commit(): void {
    if (this.#closed) return
    this.#closed = true
    this.#hits.reset()
    this.#actions.clear()
    this.#opts.onSave(diffEditableSettings(this.#initial, this.#draft, this.#originalShimmer), this.draft)
  }

  #abort(): void {
    if (this.#closed) return
    this.#closed = true
    this.#hits.reset()
    this.#actions.clear()
    this.#opts.onCancel()
  }

  handleInput(event: InputEvent): boolean {
    if (this.#closed) return false
    if (event.type === "mouse") return this.#handleMouse(event)
    if (matchesKey(event, "c", { ctrl: true })) {
      this.#abort()
      return true
    }

    // Translucent floating preview modal keys: Enter = OK, Esc = Cancel (revert preview checkpoint).
    if (this.#floatingPreview) {
      if (matchesKey(event, "escape")) {
        this.#cancelFloatingPreview()
        return true
      }
      if (matchesKey(event, "enter")) {
        this.#confirmFloatingPreview()
        return true
      }
      const fields = this.#activeFields()
      if (matchesKey(event, "up") || matchesKey(event, "k")) {
        this.#fieldFocus = (this.#fieldFocus - 1 + fields.length) % fields.length
      } else if (matchesKey(event, "down") || matchesKey(event, "j") || matchesKey(event, "tab")) {
        const step = matchesKey(event, "tab", { shift: true }) ? -1 : 1
        this.#fieldFocus = (this.#fieldFocus + step + fields.length) % fields.length
      } else if (matchesKey(event, "left") || matchesKey(event, "h") || matchesKey(event, "-")) {
        this.#adjustFocused(-1)
      } else if (
        matchesKey(event, "right") ||
        matchesKey(event, "l") ||
        matchesKey(event, "+") ||
        matchesKey(event, "=") ||
        matchesKey(event, "space")
      ) {
        this.#adjustFocused(1)
      }
      return true
    }

    // Fullscreen top-tab Settings keys
    if (matchesKey(event, "escape")) {
      this.#abort()
      return true
    }
    if (matchesKey(event, "s", { ctrl: true }) || matchesKey(event, "enter")) {
      this.#commit()
      return true
    }
    if (
      event.type === "key" &&
      !event.ctrl &&
      !event.alt &&
      event.text &&
      ["1", "2", "3", "4"].includes(event.text)
    ) {
      const next = SETTINGS_SECTIONS[Number(event.text) - 1]
      if (next) this.#selectTab(next.id)
      return true
    }
    if (matchesKey(event, "tab")) {
      const step = matchesKey(event, "tab", { shift: true }) ? -1 : 1
      const idx = SETTINGS_SECTIONS.findIndex((s) => s.id === this.#tab)
      this.#selectTab(
        SETTINGS_SECTIONS[(idx + step + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length]!.id,
      )
      return true
    }
    if (matchesKey(event, "p") && (this.#tab === "layout" || this.#tab === "appearance")) {
      this.#enterFloatingPreview(this.#tab)
      return true
    }
    const fields = this.#activeFields()
    if (matchesKey(event, "up") || matchesKey(event, "k")) {
      this.#fieldFocus = (this.#fieldFocus - 1 + fields.length) % fields.length
    } else if (matchesKey(event, "down") || matchesKey(event, "j")) {
      this.#fieldFocus = (this.#fieldFocus + 1) % fields.length
    } else if (matchesKey(event, "left") || matchesKey(event, "h") || matchesKey(event, "-")) {
      this.#adjustFocused(-1)
    } else if (
      matchesKey(event, "right") ||
      matchesKey(event, "l") ||
      matchesKey(event, "+") ||
      matchesKey(event, "=") ||
      matchesKey(event, "space")
    ) {
      this.#adjustFocused(1)
    } else if (matchesKey(event, "r") || matchesKey(event, "r", { ctrl: true })) {
      const field = fields[this.#fieldFocus]
      if (field) this.#setValue(field.key, field.defaultValue)
    }
    return true
  }

  #handleMouse(event: MouseInput): boolean {
    if (event.action === "wheel") {
      if (event.button === "up" || event.button === "down") {
        const fields = this.#activeFields()
        const step = event.button === "down" ? 1 : -1
        this.#fieldFocus = (this.#fieldFocus + step + fields.length) % fields.length
        return true
      }
      return false
    }
    const hit = this.#hits.handle(event)
    const action = hit && this.#actions.get(hit.id)
    if (!hit || !action) return true
    switch (action.kind) {
      case "tab":
        this.#selectTab(action.section)
        return true
      case "open-preview":
        this.#enterFloatingPreview(action.preview)
        return true
      case "preview-ok":
        this.#confirmFloatingPreview()
        return true
      case "preview-cancel":
        this.#cancelFloatingPreview()
        return true
      case "focus": {
        this.#fieldFocus = action.index
        const field = this.#activeFields()[action.index]
        if (field?.kind === "toggle") this.#setValue(field.key, !this.#draft[field.key])
        return true
      }
      case "set":
        this.#fieldFocus = action.index
        this.#setValue(action.key, action.value as never)
        return true
      case "step": {
        this.#fieldFocus = action.index
        const field = this.#activeFields()[action.index]
        if (field?.kind === "number") this.#stepNumber(field, action.delta)
        return true
      }
      case "action":
        if (action.action === "save") this.#commit()
        else if (action.action === "reset-tab") this.#resetTab()
        else if (action.action === "defaults") this.#resetAll()
        else this.#abort()
        return true
    }
  }

  render(width: number, ctx: RenderContext): string[] {
    this.#hits.clear()
    this.#actions.clear()
    if (this.#closed) return []
    const ascii = asciiGlyphs()
    const vp = this.#opts.viewport?.() ?? { columns: width, rows: ctx.rows }
    const nowMs = this.#opts.now?.() ?? Date.now()
    if (this.#floatingPreview) {
      return this.#renderFloating(width, vp, ctx, ascii, nowMs)
    }
    return this.#renderFullscreen(width, vp, ctx, ascii, nowMs)
  }

  #registerTargets(targets: PreviewHit<MouseAction>[], maxWidth: number, maxRows: number): void {
    for (const target of targets) {
      if (target.y < 0 || target.y >= maxRows) continue
      const end = Math.min(maxWidth, target.x + target.width)
      if (end <= target.x) continue
      const rect: HitRect = { x: target.x, y: target.y, width: end - target.x, height: 1 }
      this.#hits.add(target.id, rect)
      this.#actions.set(target.id, target.action)
    }
  }

  #renderFieldRows(
    fields: readonly SettingsField[],
    inner: number,
    vp: { columns: number; rows: number },
    ctx: RenderContext,
    ascii: boolean,
    startY: number,
    addTarget: (target: PreviewHit<MouseAction>) => void,
    options?: { allowWrap?: boolean },
  ): string[] {
    return renderSettingsFieldRows({
      fields,
      draft: this.#draft,
      fieldFocus: this.#fieldFocus,
      optionsOf: (field) => this.#optionsOf(field),
      inner,
      vp,
      ctx,
      ascii,
      startY,
      allowWrap: options?.allowWrap,
      addTarget,
    })
  }

  #renderFloating(
    width: number,
    vp: { columns: number; rows: number },
    ctx: RenderContext,
    ascii: boolean,
    nowMs: number,
  ): string[] {
    const kind = this.#floatingPreview!
    const { theme } = ctx
    const floating = width >= 60 && ctx.rows >= 20
    const cardWidth = floating ? floatingPreviewCardWidth(width) : width
    const inner = Math.max(10, cardWidth - 4)
    const fields = this.#activeFields()
    const bodyLines: string[] = []
    const bodyTargets: PreviewHit<MouseAction>[] = []
    bodyLines.push(
      ...this.#renderFieldRows(fields, inner, vp, ctx, ascii, 0, (hit) => bodyTargets.push(hit), {
        allowWrap: true,
      }),
    )

    bodyLines.push("")
    if (kind === "layout") {
      bodyLines.push(
        theme.muted(
          truncateToWidth("  Background conversation updates live as you adjust.", inner, viewEllipsis()),
        ),
      )
    } else {
      const frames = chromeGlyphs(ctx.glyphs).spinnerFrames
      const spinChar = frames[Math.floor(nowMs / Spinner.INTERVAL_MS) % frames.length] ?? "*"
      const shimmerStyle = themeToken(theme, "shimmer") ?? theme.accent
      bodyLines.push(
        truncateToWidth(
          `  ${shimmerStyle(spinChar)} ${paintShimmer("Thinking · live theme & shimmer preview…", ctx, nowMs)}`,
          inner,
          viewEllipsis(),
        ),
      )
    }

    const geom = contentGeometry(vp.columns, vp.rows, {
      margin: this.#draft.margin,
      marginRows: this.#draft.marginRows,
    })
    const title =
      kind === "layout"
        ? `Layout Preview ${glyphs.separator} ${geom.width}×${geom.height} (margin ${this.#draft.margin}, rows ${this.#draft.marginRows})`
        : `Theme Preview ${glyphs.separator} ${this.#draft.theme} (${this.#draft.themeVariant})`

    const rendered = renderFloatingPreviewCard<MouseAction>({
      title,
      bodyLines,
      bodyTargets,
      width,
      ctx,
      ascii,
      okAction: { kind: "preview-ok" },
      cancelAction: { kind: "preview-cancel" },
    })
    this.#registerTargets(rendered.targets, width, ctx.rows)
    return rendered.rows
  }

  #renderFullscreen(
    width: number,
    vp: { columns: number; rows: number },
    ctx: RenderContext,
    ascii: boolean,
    nowMs: number,
  ): string[] {
    const { theme } = ctx
    const inner = Math.max(12, width - 4)
    const tl = ascii ? "+" : "╭"
    const bl = ascii ? "+" : "╰"
    const br = ascii ? "+" : "╯"
    const h = ascii ? "-" : "─"
    const v = ascii ? "|" : "│"
    const ml = ascii ? "+" : "├"
    const mr = ascii ? "+" : "┤"
    const sep = ` ${glyphs.separator} `
    const row = (content: string) => `${theme.border(v)} ${padCell(content, inner)} ${theme.border(v)}`
    const rule = theme.border(`${ml}${h.repeat(Math.max(0, width - 2))}${mr}`)

    const geom = contentGeometry(vp.columns, vp.rows, {
      margin: this.#draft.margin,
      marginRows: this.#draft.marginRows,
    })
    const statusRight =
      this.#tab === "appearance"
        ? theme.muted(`${this.#draft.theme} (${this.#draft.themeVariant})${sep}${this.#draft.colorDepth}`)
        : theme.muted(
            `${geom.width}×${geom.height}${sep}margin ${this.#draft.margin}, rows ${this.#draft.marginRows}`,
          )
    const dirtyTag = this.dirty ? ` ${theme.accent(`${glyphs.separator} unsaved`)}` : ""
    const topLine = topBorder(bold(theme.text("Settings")) + dirtyTag, statusRight, width, ctx, ascii)

    const allTargets: PreviewHit<MouseAction>[] = []
    // Top Tab Bar (row index 1)
    let tabLine = " "
    const tabY = 1
    for (const sec of SETTINGS_SECTIONS) {
      const active = sec.id === this.#tab
      const short = sec.label.split(" ")[0]!
      const raw = `[ ${short}${this.#tabDirty(sec.id) ? "*" : ""} ]`
      const styled = active
        ? ctx.color
          ? inverse(bold(theme.accent(raw)))
          : bold(theme.accent(raw))
        : theme.fg2(raw)
      const x = visibleWidth(tabLine)
      if (x + visibleWidth(raw) <= inner) {
        allTargets.push({
          id: `tab:${sec.id}`,
          x: 2 + x,
          y: tabY,
          width: visibleWidth(raw),
          action: { kind: "tab", section: sec.id },
        })
        tabLine += `${styled}  `
      }
    }
    const tabHint = theme.muted("1-4 / Tab switch")
    const tabGap = inner - visibleWidth(tabLine) - visibleWidth(tabHint)
    if (tabGap >= 2) tabLine += " ".repeat(tabGap) + tabHint

    // Content area starts at y = 3 (0: topBorder, 1: tabBar, 2: rule)
    const bodyStartY = 3
    const bodyLines: string[] = []
    const bodyTargets: PreviewHit<MouseAction>[] = []
    const compact = ctx.rows < 26
    if (!compact) bodyLines.push("")

    if (this.#tab === "layout") {
      bodyLines.push(
        ...renderLayoutPreviewStage<MouseAction>({
          draft: this.#draft,
          viewport: vp,
          width: inner,
          compact,
          ctx,
          ascii,
          startY: bodyLines.length,
          openAction: { kind: "open-preview", preview: "layout" },
          addTarget: (hit) => bodyTargets.push(hit),
        }),
      )
      bodyLines.push("")
    } else if (this.#tab === "appearance") {
      bodyLines.push(
        ...renderThemePreviewStage<MouseAction>({
          draft: this.#draft,
          width: inner,
          compact,
          ctx,
          ascii,
          nowMs,
          startY: bodyLines.length,
          openAction: { kind: "open-preview", preview: "appearance" },
          addTarget: (hit) => bodyTargets.push(hit),
        }),
      )
      bodyLines.push("")
    } else {
      const meta = SETTINGS_SECTIONS.find((s) => s.id === this.#tab)
      if (meta) {
        bodyLines.push(bold(theme.fg2(meta.label)))
        bodyLines.push(theme.muted(truncateToWidth(meta.description, inner, viewEllipsis())))
        bodyLines.push("")
      }
    }

    const fields = this.#activeFields()
    bodyLines.push(
      ...this.#renderFieldRows(fields, inner, vp, ctx, ascii, bodyLines.length, (hit) =>
        bodyTargets.push(hit),
      ),
    )

    const focusedField = fields[this.#fieldFocus]
    if (focusedField) {
      bodyLines.push("")
      bodyLines.push(
        theme.muted(
          truncateToWidth(
            `  ${focusedField.description} (Default: ${String(focusedField.defaultValue)})`,
            inner,
            viewEllipsis(),
          ),
        ),
      )
    }

    // Footer: rule + action buttons + hint + bottom border (4 rows)
    const footerRows = 4
    const bodyRoom = Math.max(1, ctx.rows - bodyStartY - footerRows)
    const visibleBody = bodyLines.slice(0, bodyRoom)
    for (const hit of bodyTargets) {
      if (hit.y >= 0 && hit.y < visibleBody.length) {
        allTargets.push({ ...hit, x: 2 + hit.x, y: bodyStartY + hit.y })
      }
    }
    while (visibleBody.length < bodyRoom) visibleBody.push("")

    const actionY = bodyStartY + bodyRoom + 1
    const actionButtons: {
      id: "save" | "reset-tab" | "defaults" | "cancel"
      label: string
      primary?: boolean
    }[] = [
      { id: "save", label: this.dirty ? "Save changes" : "Save", primary: true },
      { id: "reset-tab", label: "Reset tab" },
      { id: "defaults", label: "Defaults" },
      { id: "cancel", label: this.dirty ? "Cancel (restore)" : "Close" },
    ]
    let actionRow = " "
    for (const btn of actionButtons) {
      const raw = `[ ${btn.label} ]`
      const styled =
        btn.primary && this.dirty
          ? ctx.color
            ? inverse(bold(theme.accent(raw)))
            : bold(theme.accent(raw))
          : btn.primary
            ? bold(theme.accent(raw))
            : theme.fg2(raw)
      const x = visibleWidth(actionRow)
      if (x + visibleWidth(raw) <= inner) {
        allTargets.push({
          id: `action:${btn.id}`,
          x: 2 + x,
          y: actionY,
          width: visibleWidth(raw),
          action: { kind: "action", action: btn.id },
        })
        actionRow += `${styled}  `
      }
    }

    const arrows = ascii ? "up/down" : "↑↓"
    const lr = ascii ? "left/right" : "←→"
    const previewHint =
      this.#tab === "layout" || this.#tab === "appearance" ? `p live preview on chat${sep}` : ""
    const hintText = ` click tabs/buttons${sep}${previewHint}${arrows} field${sep}${lr} adjust${sep}enter save${sep}esc cancel`
    const bottomLine = theme.border(`${bl}${h.repeat(Math.max(0, width - 2))}${br}`)
    void tl

    const frame = [
      topLine,
      row(tabLine),
      rule,
      ...visibleBody.map(row),
      rule,
      row(actionRow.trimEnd()),
      row(theme.muted(truncateToWidth(hintText, inner, viewEllipsis()))),
      bottomLine,
    ].slice(0, ctx.rows)

    this.#registerTargets(allTargets, width, frame.length)
    return frame
  }
}
