import type { ShimmerEffect, TuiSettings } from "@amira/api"
import {
  bold,
  type HitRect,
  HitRegions,
  type InputEvent,
  inverse,
  type MouseInput,
  matchesKey,
  type RenderContext,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import { Dialog } from "./dialog.ts"
import { dialogFrame } from "./dialog-frame.ts"
import { asciiGlyphs, glyphs, viewEllipsis } from "./glyphs.ts"
import { defaultKeybindings, type Keybindings } from "./keybindings.ts"
import { contentGeometry } from "./margins.ts"
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

type MouseAction =
  | { kind: "open-section"; section: SettingsSectionId }
  | { kind: "home" }
  | { kind: "focus"; index: number }
  | { kind: "set"; index: number; key: EditableTuiKey; value: EditableTuiSettings[EditableTuiKey] }
  | { kind: "step"; index: number; key: "margin" | "marginRows" | "shellOutputLines"; delta: -1 | 1 }
  | { kind: "action"; action: "save" | "reset-section" | "defaults" | "cancel" }

interface TargetSpec {
  id: string
  x: number
  y: number
  width: number
  action: MouseAction
}

export interface SettingsMenuOptions {
  initial: TuiSettings
  runtimeTheme?: {
    name: string
    themeVariant: NonNullable<TuiSettings["themeVariant"]>
    shimmer?: ShimmerEffect
  }
  themeNames?: readonly string[]
  initialSection?: SettingsSectionId
  keys?: Keybindings
  viewport?: () => { columns: number; rows: number }
  onPreview: (draft: EditableTuiSettings, section: SettingsSectionId | "home") => void
  onSave: (patch: Partial<TuiSettings>, draft: EditableTuiSettings) => void
  onCancel: () => void
}

/**
 * Hierarchical two-level clickable GUI settings menu hosted in the bottom dialog slot so the
 * real transcript, theme palette, shimmer and outer margins stay live and visible above it.
 */
export class SettingsMenuDialog extends Dialog {
  readonly #initial: EditableTuiSettings
  readonly #originalShimmer: ShimmerEffect | undefined
  readonly #themeNames: readonly string[]
  #draft: EditableTuiSettings
  /** "home" shows the top-level category menu; a section id drills into that sub-page. */
  #view: "home" | SettingsSectionId
  #homeFocus = 0
  #fieldFocus = 0
  #closed = false
  #hits = new HitRegions()
  #actions = new Map<string, MouseAction>()
  #opts: SettingsMenuOptions

  constructor(opts: SettingsMenuOptions) {
    super(
      { kind: "select", requestId: "tui-settings", title: "Settings", options: ["Save"] },
      () => {},
      opts.keys ?? defaultKeybindings(),
    )
    this.#opts = opts
    this.#themeNames = opts.themeNames ?? []
    this.#originalShimmer = opts.runtimeTheme ? opts.runtimeTheme.shimmer : opts.initial.shimmer
    this.#initial = resolveEditableSettings(opts.initial, opts.runtimeTheme)
    this.#draft = { ...this.#initial }
    this.#view = opts.initialSection ?? "home"
    if (opts.initialSection) {
      const idx = SETTINGS_SECTIONS.findIndex((s) => s.id === opts.initialSection)
      if (idx >= 0) this.#homeFocus = idx
    }
  }

  get draft(): EditableTuiSettings {
    return { ...this.#draft }
  }

  get activeView(): "home" | SettingsSectionId {
    return this.#view
  }

  get dirty(): boolean {
    return Object.keys(diffEditableSettings(this.#initial, this.#draft, this.#originalShimmer)).length > 0
  }

  override close(): void {
    this.#closed = true
    this.#hits.reset()
    this.#actions.clear()
    super.close()
  }

  #sectionFields(section: SettingsSectionId): SettingsField[] {
    return SETTINGS_FIELDS.filter((f) => f.section === section)
  }

  #sectionDirty(section: SettingsSectionId): boolean {
    return this.#sectionFields(section).some((f) => this.#draft[f.key] !== this.#initial[f.key])
  }

  #openSection(section: SettingsSectionId): void {
    const idx = SETTINGS_SECTIONS.findIndex((s) => s.id === section)
    if (idx >= 0) this.#homeFocus = idx
    this.#view = section
    this.#fieldFocus = 0
    this.#opts.onPreview(this.draft, this.#view)
  }

  #goHome(): void {
    if (this.#view === "home") return
    this.#view = "home"
    this.#opts.onPreview(this.draft, "home")
  }

  #setValue<K extends EditableTuiKey>(key: K, value: EditableTuiSettings[K]): void {
    if (this.#draft[key] === value) return
    this.#draft = { ...this.#draft, [key]: value }
    this.#opts.onPreview(this.draft, this.#view)
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
    if (this.#view === "home") return
    const field = this.#sectionFields(this.#view)[this.#fieldFocus]
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

  #resetSection(): void {
    if (this.#view === "home") return
    const next = { ...this.#draft }
    let changed = false
    for (const field of this.#sectionFields(this.#view)) {
      if (next[field.key] !== field.defaultValue) {
        Object.assign(next, { [field.key]: field.defaultValue })
        changed = true
      }
    }
    if (!changed) return
    this.#draft = next
    this.#opts.onPreview(this.draft, this.#view)
  }

  #resetAll(): void {
    const defaults = defaultEditableSettings()
    if (Object.keys(diffEditableSettings(this.#draft, defaults, this.#originalShimmer)).length === 0) return
    this.#draft = defaults
    this.#opts.onPreview(this.draft, this.#view)
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

  override handleInput(event: InputEvent): boolean {
    if (this.#closed) return false
    if (event.type === "mouse") return this.#handleMouse(event)
    if (matchesKey(event, "c", { ctrl: true })) {
      this.#abort()
      return true
    }
    if (matchesKey(event, "s", { ctrl: true })) {
      this.#commit()
      return true
    }
    if (matchesKey(event, "escape")) {
      if (this.#view !== "home") this.#goHome()
      else this.#abort()
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
      if (next) this.#openSection(next.id)
      return true
    }
    if (this.#view === "home") {
      if (matchesKey(event, "up") || matchesKey(event, "k")) {
        this.#homeFocus = (this.#homeFocus - 1 + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length
      } else if (matchesKey(event, "down") || matchesKey(event, "j") || matchesKey(event, "tab")) {
        const step = matchesKey(event, "tab", { shift: true }) ? -1 : 1
        this.#homeFocus = (this.#homeFocus + step + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length
      } else if (matchesKey(event, "enter") || matchesKey(event, "right") || matchesKey(event, "space")) {
        this.#openSection(SETTINGS_SECTIONS[this.#homeFocus]!.id)
      }
      return true
    }

    // Sub-page navigation
    if (matchesKey(event, "backspace")) {
      this.#goHome()
      return true
    }
    if (matchesKey(event, "enter")) {
      this.#commit()
      return true
    }
    if (matchesKey(event, "tab")) {
      const step = matchesKey(event, "tab", { shift: true }) ? -1 : 1
      const i = SETTINGS_SECTIONS.findIndex((s) => s.id === this.#view)
      this.#openSection(
        SETTINGS_SECTIONS[(i + step + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length]!.id,
      )
      return true
    }
    const fields = this.#sectionFields(this.#view)
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
        const step = event.button === "down" ? 1 : -1
        if (this.#view === "home") {
          this.#homeFocus = (this.#homeFocus + step + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length
        } else {
          const fields = this.#sectionFields(this.#view)
          this.#fieldFocus = (this.#fieldFocus + step + fields.length) % fields.length
        }
        return true
      }
      return false
    }
    const hit = this.#hits.handle(event)
    const action = hit && this.#actions.get(hit.id)
    if (!hit || !action) return true
    switch (action.kind) {
      case "open-section":
        this.#openSection(action.section)
        return true
      case "home":
        this.#goHome()
        return true
      case "focus": {
        this.#fieldFocus = action.index
        if (this.#view !== "home") {
          const field = this.#sectionFields(this.#view)[action.index]
          if (field?.kind === "toggle") this.#setValue(field.key, !this.#draft[field.key])
        }
        return true
      }
      case "set":
        this.#fieldFocus = action.index
        this.#setValue(action.key, action.value as never)
        return true
      case "step": {
        this.#fieldFocus = action.index
        if (this.#view !== "home") {
          const field = this.#sectionFields(this.#view)[action.index]
          if (field?.kind === "number") this.#stepNumber(field, action.delta)
        }
        return true
      }
      case "action":
        if (action.action === "save") this.#commit()
        else if (action.action === "reset-section") this.#resetSection()
        else if (action.action === "defaults") this.#resetAll()
        else this.#abort()
        return true
    }
  }

  override render(width: number, ctx: RenderContext): string[] {
    this.#hits.clear()
    this.#actions.clear()
    if (this.#closed) return []
    const { theme } = ctx
    const compact = width < 6 || this.maxRows < 4
    const inner = compact ? Math.max(1, width) : Math.max(1, width - 4)
    const vp = this.#opts.viewport?.() ?? { columns: width, rows: ctx.rows }
    const geom = contentGeometry(vp.columns, vp.rows, {
      margin: this.#draft.margin,
      marginRows: this.#draft.marginRows,
    })
    const sep = ` ${glyphs.separator} `
    const dims = `${geom.width}×${geom.height} (margin ${this.#draft.margin}, rows ${this.#draft.marginRows})`
    const dirtyTag = this.dirty ? ` ${theme.accent(`${glyphs.separator} unsaved`)}` : ""
    const sectionMeta = this.#view === "home" ? undefined : SETTINGS_SECTIONS.find((s) => s.id === this.#view)
    const titleHead = sectionMeta
      ? `${bold(theme.text("Settings"))} ${theme.muted(glyphs.pointer)} ${bold(theme.accent(sectionMeta.label))}`
      : bold(theme.text("Settings"))
    const title = `${titleHead} ${theme.muted(`${glyphs.separator} ${dims}`)}${dirtyTag}`

    const body: string[] = []
    const targets: TargetSpec[] = []
    const addTarget = (target: TargetSpec) => targets.push(target)
    const ascii = asciiGlyphs()

    if (this.#view === "home") {
      this.#renderHome(body, inner, ctx, addTarget, ascii)
    } else {
      this.#renderSection(this.#view, body, inner, vp, ctx, addTarget, ascii)
    }

    // Action button bar
    body.push(theme.border(glyphs.rule.repeat(inner)))
    const actionButtons: {
      id: "save" | "reset-section" | "defaults" | "cancel" | "home"
      label: string
      primary?: boolean
    }[] =
      this.#view === "home"
        ? [
            { id: "save", label: this.dirty ? "Save changes" : "Save", primary: true },
            { id: "defaults", label: "Defaults" },
            { id: "cancel", label: this.dirty ? "Cancel (restore)" : "Close" },
          ]
        : [
            { id: "home", label: `${ascii ? "<-" : "←"} Back` },
            { id: "save", label: this.dirty ? "Save changes" : "Save", primary: true },
            { id: "reset-section", label: "Reset section" },
            { id: "cancel", label: this.dirty ? "Cancel (restore)" : "Close" },
          ]
    let actionRow = "  "
    const actionY = body.length
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
        addTarget({
          id: `action:${btn.id}`,
          x,
          y: actionY,
          width: visibleWidth(raw),
          action: btn.id === "home" ? { kind: "home" } : { kind: "action", action: btn.id },
        })
        actionRow += `${styled}  `
      }
    }
    body.push(actionRow.trimEnd())

    const arrows = ascii ? "up/down" : "↑↓"
    const lr = ascii ? "left/right" : "←→"
    const hint =
      this.#view === "home"
        ? `click category${sep}1-4 jump${sep}${arrows} select${sep}enter open${sep}ctrl+s save${sep}esc restore`
        : `click buttons${sep}backspace/esc back${sep}tab next group${sep}${arrows} field${sep}${lr} adjust${sep}enter save`
    body.push(theme.muted(truncateToWidth(`  ${hint}`, inner, viewEllipsis())))

    const rows = dialogFrame(title, body, width, ctx, theme.accent, this.maxRows)
    const room = Math.max(0, this.maxRows - 2)
    const start = Math.max(0, body.length + 1 - Math.max(1, this.maxRows))
    for (const target of targets) {
      const shown = compact
        ? target.y + 1 - start
        : body.length <= room || target.y < room - 1
          ? target.y + 1
          : target.y === body.length - 1
            ? room
            : -1
      if (shown < 0 || shown >= rows.length) continue
      const left = compact ? 0 : 2
      const right = compact ? width : width - 2
      const x = left + target.x
      const end = Math.min(right, x + target.width)
      if (end <= x) continue
      const rect: HitRect = { x, y: shown, width: end - x, height: 1 }
      this.#hits.add(target.id, rect)
      this.#actions.set(target.id, target.action)
    }
    return rows
  }

  #renderHome(
    body: string[],
    inner: number,
    ctx: RenderContext,
    addTarget: (target: TargetSpec) => void,
    ascii: boolean,
  ): void {
    const { theme } = ctx
    body.push(
      theme.muted(truncateToWidth("  Choose a category (changes preview live):", inner, viewEllipsis())),
    )
    body.push(theme.border(glyphs.rule.repeat(inner)))

    const labelCol = Math.min(24, Math.max(18, ...SETTINGS_SECTIONS.map((s) => visibleWidth(s.label) + 7)))
    const chevron = ascii ? ">" : "›"
    for (let i = 0; i < SETTINGS_SECTIONS.length; i++) {
      const sec = SETTINGS_SECTIONS[i]!
      const focused = i === this.#homeFocus
      const dirty = this.#sectionDirty(sec.id)
      const mark = focused ? bold(theme.accent(glyphs.pointer)) : " "
      const num = theme.muted(`${i + 1}.`)
      const rawTitle = `${sec.label}${dirty ? "*" : ""}`
      const titleStyled = focused ? bold(theme.accent(rawTitle)) : theme.text(rawTitle)
      const prefix = `${mark} ${num} ${titleStyled}`
      const pad = " ".repeat(Math.max(1, labelCol - visibleWidth(prefix)))
      const summaryRoom = Math.max(0, inner - labelCol - 3)
      const summaryText =
        summaryRoom > 4 ? truncateToWidth(sec.summary(this.#draft), summaryRoom, viewEllipsis()) : ""
      const summaryStyled = focused ? theme.fg2(summaryText) : theme.muted(summaryText)
      const rowLeft = `${prefix}${pad}${summaryStyled}`
      const rightPad = " ".repeat(Math.max(1, inner - visibleWidth(rowLeft) - 2))
      const line = `${rowLeft}${rightPad}${focused ? bold(theme.accent(chevron)) : theme.muted(chevron)}`
      addTarget({
        id: `section:${sec.id}`,
        x: 0,
        y: body.length,
        width: inner,
        action: { kind: "open-section", section: sec.id },
      })
      body.push(truncateToWidth(line, inner, viewEllipsis()))
    }

    const activeSec = SETTINGS_SECTIONS[this.#homeFocus]
    if (activeSec) {
      body.push("")
      body.push(theme.muted(truncateToWidth(`  ${activeSec.description}`, inner, viewEllipsis())))
    }
  }

  #renderSection(
    section: SettingsSectionId,
    body: string[],
    inner: number,
    vp: { columns: number; rows: number },
    ctx: RenderContext,
    addTarget: (target: TargetSpec) => void,
    ascii: boolean,
  ): void {
    const { theme } = ctx
    // Breadcrumb & quick section switcher bar
    const backRaw = `[ ${ascii ? "<-" : "←"} Settings ]`
    let navLine = theme.fg2(backRaw)
    const navY = body.length
    addTarget({
      id: "nav:home",
      x: 0,
      y: navY,
      width: visibleWidth(backRaw),
      action: { kind: "home" },
    })
    for (const sec of SETTINGS_SECTIONS) {
      const active = sec.id === section
      const short = sec.label.split(" ")[0]!
      const raw = `[ ${short}${this.#sectionDirty(sec.id) ? "*" : ""} ]`
      const x = visibleWidth(navLine) + 2
      if (x + visibleWidth(raw) > inner) break
      const styled = active
        ? ctx.color
          ? inverse(bold(theme.accent(raw)))
          : bold(theme.accent(raw))
        : theme.muted(raw)
      addTarget({
        id: `nav:${sec.id}`,
        x,
        y: navY,
        width: visibleWidth(raw),
        action: { kind: "open-section", section: sec.id },
      })
      navLine += `  ${styled}`
    }
    body.push(navLine)
    body.push(theme.border(glyphs.rule.repeat(inner)))

    const fields = this.#sectionFields(section)
    const labelCol = Math.min(20, Math.max(12, ...fields.map((f) => visibleWidth(f.label) + 4)))
    const controlRoom = Math.max(12, inner - labelCol - 1)

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!
      const focused = i === this.#fieldFocus
      const value = this.#draft[field.key]
      const modified = value !== field.defaultValue
      const mark = focused ? bold(theme.accent(glyphs.pointer)) : " "
      const rawLabel = `${field.label}${modified ? "*" : ""}`
      const pad = " ".repeat(Math.max(1, labelCol - 2 - visibleWidth(rawLabel)))
      const labelPart = `${mark} ${focused ? bold(theme.accent(rawLabel)) : theme.text(rawLabel)}${pad}`

      const pill = (text: string, active: boolean, disabled = false): string => {
        const raw = `[ ${text} ]`
        if (disabled) return theme.dim(raw)
        if (active) {
          return focused && ctx.color ? inverse(bold(theme.accent(raw))) : bold(theme.accent(raw))
        }
        return focused ? theme.fg2(raw) : theme.muted(raw)
      }

      const controls: { text: string; raw: string; action: MouseAction }[] = []
      let suffix = ""
      if (field.kind === "number") {
        const current = value as number
        const presets = field.presets.includes(current)
          ? field.presets
          : [...field.presets, current].sort((a, b) => a - b)
        const needStepper = field.max - field.min > 2
        const fullWidth = (needStepper ? 12 : 0) + presets.reduce((sum, n) => sum + `[ ${n} ]`.length + 1, 0)
        if (fullWidth <= controlRoom) {
          if (needStepper) {
            controls.push({
              text: pill("-", false, current <= field.min),
              raw: "[ - ]",
              action: { kind: "step", index: i, key: field.key, delta: -1 },
            })
          }
          for (const preset of presets) {
            controls.push({
              text: pill(String(preset), preset === current),
              raw: `[ ${preset} ]`,
              action: { kind: "set", index: i, key: field.key, value: preset },
            })
          }
          if (needStepper) {
            controls.push({
              text: pill("+", false, current >= field.max),
              raw: "[ + ]",
              action: { kind: "step", index: i, key: field.key, delta: 1 },
            })
          }
        } else {
          controls.push(
            {
              text: pill("-", false, current <= field.min),
              raw: "[ - ]",
              action: { kind: "step", index: i, key: field.key, delta: -1 },
            },
            { text: pill(String(current), true), raw: `[ ${current} ]`, action: { kind: "focus", index: i } },
            {
              text: pill("+", false, current >= field.max),
              raw: "[ + ]",
              action: { kind: "step", index: i, key: field.key, delta: 1 },
            },
          )
        }
        if (field.liveSuffix) suffix = ` ${theme.muted(field.liveSuffix(this.#draft, vp))}`
      } else if (field.kind === "toggle") {
        const on = value === true
        controls.push(
          {
            text: pill("On", on),
            raw: "[ On ]",
            action: { kind: "set", index: i, key: field.key, value: true },
          },
          {
            text: pill("Off", !on),
            raw: "[ Off ]",
            action: { kind: "set", index: i, key: field.key, value: false },
          },
        )
      } else {
        const options = this.#optionsOf(field)
        const current = String(value)
        const allWidth = options.reduce((sum, o) => sum + `[ ${o.label} ]`.length + 1, 0)
        if (allWidth <= controlRoom) {
          for (const opt of options) {
            controls.push({
              text: pill(opt.label, String(opt.value) === current),
              raw: `[ ${opt.label} ]`,
              action: { kind: "set", index: i, key: field.key, value: opt.value },
            })
          }
        } else {
          const idx = Math.max(
            0,
            options.findIndex((o) => String(o.value) === current),
          )
          const chosen = options[idx]?.label ?? current
          const prev = options[(idx - 1 + options.length) % options.length]!
          const next = options[(idx + 1) % options.length]!
          controls.push(
            {
              text: pill(ascii ? "<" : "‹", false),
              raw: `[ ${ascii ? "<" : "‹"} ]`,
              action: { kind: "set", index: i, key: field.key, value: prev.value },
            },
            { text: pill(chosen, true), raw: `[ ${chosen} ]`, action: { kind: "focus", index: i } },
            {
              text: pill(ascii ? ">" : "›", false),
              raw: `[ ${ascii ? ">" : "›"} ]`,
              action: { kind: "set", index: i, key: field.key, value: next.value },
            },
          )
        }
      }

      const controlsRawWidth = controls.reduce((s, c, idx) => s + visibleWidth(c.raw) + (idx ? 1 : 0), 0)
      const inline = labelCol + controlsRawWidth <= inner
      const rowY = body.length
      addTarget({
        id: `row:${i}`,
        x: 0,
        y: rowY,
        width: Math.min(inner, labelCol),
        action: { kind: "focus", index: i },
      })

      let controlLine = ""
      const baseX = inline ? visibleWidth(labelPart) : 2
      const controlY = inline ? rowY : rowY + 1
      for (let c = 0; c < controls.length; c++) {
        const item = controls[c]!
        if (c > 0) controlLine += " "
        const x = baseX + visibleWidth(controlLine)
        const w = visibleWidth(item.raw)
        if (x + w <= inner) {
          addTarget({ id: `ctrl:${i}:${c}`, x, y: controlY, width: w, action: item.action })
        }
        controlLine += item.text
      }
      const controlWithSuffix =
        suffix && baseX + visibleWidth(controlLine) + visibleWidth(suffix) <= inner
          ? controlLine + suffix
          : controlLine

      if (inline) body.push(labelPart + controlWithSuffix)
      else {
        body.push(labelPart.trimEnd())
        body.push(`  ${controlWithSuffix}`)
      }
    }

    const focusedField = fields[this.#fieldFocus]
    if (focusedField) {
      body.push("")
      const defaultNote = `Default: ${String(focusedField.defaultValue)}`
      body.push(
        theme.muted(truncateToWidth(`  ${focusedField.description} (${defaultNote})`, inner, viewEllipsis())),
      )
    }
  }
}
