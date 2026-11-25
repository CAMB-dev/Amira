import {
  DEFAULT_SHELL_OUTPUT_LINES,
  DEFAULT_TUI_BELL,
  DEFAULT_TUI_CLOCK,
  DEFAULT_TUI_COLOR_DEPTH,
  DEFAULT_TUI_IMAGES,
  DEFAULT_TUI_MARGIN,
  DEFAULT_TUI_MARGIN_ROWS,
  DEFAULT_TUI_NOTIFY,
  DEFAULT_TUI_PROGRESS,
  DEFAULT_TUI_SUBMIT_WHILE_WORKING,
  DEFAULT_TUI_TITLE,
  DEFAULT_TUI_TOKEN_SPEED,
  type TuiSettings,
} from "@amira/api"
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

export type SettingsTabId = "layout" | "interface" | "alerts"

export type EditableTuiKey =
  | "margin"
  | "marginRows"
  | "shellOutputLines"
  | "clock"
  | "submitWhileWorking"
  | "colorDepth"
  | "images"
  | "tokenSpeed"
  | "bell"
  | "notify"
  | "title"
  | "progress"

export type EditableTuiSettings = Pick<TuiSettings, EditableTuiKey>

interface NumberField {
  kind: "number"
  key: "margin" | "marginRows" | "shellOutputLines"
  tab: SettingsTabId
  label: string
  description: string
  min: number
  max: number
  defaultValue: number
  presets: readonly number[]
  liveSuffix?: (draft: EditableTuiSettings, viewport: { columns: number; rows: number }) => string
}

interface ChoiceField<K extends EditableTuiKey = EditableTuiKey> {
  kind: "choice"
  key: K
  tab: SettingsTabId
  label: string
  description: string
  defaultValue: NonNullable<TuiSettings[K]>
  options: readonly { value: NonNullable<TuiSettings[K]>; label: string }[]
}

interface ToggleField {
  kind: "toggle"
  key: "tokenSpeed" | "bell" | "title" | "progress"
  tab: SettingsTabId
  label: string
  description: string
  defaultValue: boolean
}

type SettingsField = NumberField | ChoiceField | ToggleField

export const SETTINGS_TABS: readonly { id: SettingsTabId; label: string }[] = [
  { id: "layout", label: "Layout" },
  { id: "interface", label: "Interface" },
  { id: "alerts", label: "Alerts" },
]

export const SETTINGS_FIELDS: readonly SettingsField[] = [
  {
    kind: "number",
    key: "margin",
    tab: "layout",
    label: "Side margin",
    description: "Left/right outer margin in cells (0–12). Previews live; shrinks on narrow terminals.",
    min: 0,
    max: 12,
    defaultValue: DEFAULT_TUI_MARGIN,
    presets: [0, 1, 2, 3, 4, 6, 8],
    liveSuffix: (draft, vp) => `${contentGeometry(vp.columns, vp.rows, draft).width} cols`,
  },
  {
    kind: "number",
    key: "marginRows",
    tab: "layout",
    label: "Top/bottom rows",
    description: "Outer top/bottom padding in rows (0–2). Dropped automatically below 24 rows.",
    min: 0,
    max: 2,
    defaultValue: DEFAULT_TUI_MARGIN_ROWS,
    presets: [0, 1, 2],
    liveSuffix: (draft, vp) => `${contentGeometry(vp.columns, vp.rows, draft).height} rows`,
  },
  {
    kind: "number",
    key: "shellOutputLines",
    tab: "layout",
    label: "Shell preview",
    description: "Tail lines shown under succeeded shell calls in summary detail mode (0–20).",
    min: 0,
    max: 20,
    defaultValue: DEFAULT_SHELL_OUTPUT_LINES,
    presets: [0, 3, 6, 10],
  },
  {
    kind: "choice",
    key: "clock",
    tab: "interface",
    label: "Clock format",
    description: "Timestamp hour cycle: auto follows your system locale, or force 12h / 24h.",
    defaultValue: DEFAULT_TUI_CLOCK,
    options: [
      { value: "auto", label: "auto" },
      { value: "12h", label: "12h" },
      { value: "24h", label: "24h" },
    ],
  },
  {
    kind: "choice",
    key: "submitWhileWorking",
    tab: "interface",
    label: "Enter while busy",
    description: "Steer sends into the running turn; queue holds your message until the turn finishes.",
    defaultValue: DEFAULT_TUI_SUBMIT_WHILE_WORKING,
    options: [
      { value: "steer", label: "steer" },
      { value: "queue", label: "queue" },
    ],
  },
  {
    kind: "choice",
    key: "colorDepth",
    tab: "interface",
    label: "Color depth",
    description: "Terminal color palette depth; auto detects capabilities from your terminal.",
    defaultValue: DEFAULT_TUI_COLOR_DEPTH,
    options: [
      { value: "auto", label: "auto" },
      { value: "truecolor", label: "truecolor" },
      { value: "256", label: "256" },
      { value: "16", label: "16" },
    ],
  },
  {
    kind: "choice",
    key: "images",
    tab: "interface",
    label: "Inline images",
    description: "Render inline images in replies when supported by the terminal.",
    defaultValue: DEFAULT_TUI_IMAGES,
    options: [
      { value: "auto", label: "auto" },
      { value: "on", label: "on" },
      { value: "off", label: "off" },
    ],
  },
  {
    kind: "toggle",
    key: "tokenSpeed",
    tab: "interface",
    label: "Token speed",
    description: "Show live generation speed (tok/s) and thinking duration in the status strip.",
    defaultValue: DEFAULT_TUI_TOKEN_SPEED,
  },
  {
    kind: "toggle",
    key: "bell",
    tab: "alerts",
    label: "Terminal bell",
    description: "Ring the terminal bell once when a turn finishes in the background or waits on you.",
    defaultValue: DEFAULT_TUI_BELL,
  },
  {
    kind: "choice",
    key: "notify",
    tab: "alerts",
    label: "Desktop notify",
    description: "Send terminal desktop notifications (Ghostty, Kitty, WezTerm, iTerm2).",
    defaultValue: DEFAULT_TUI_NOTIFY,
    options: [
      { value: "auto", label: "auto" },
      { value: "off", label: "off" },
    ],
  },
  {
    kind: "toggle",
    key: "title",
    tab: "alerts",
    label: "Window title",
    description: "Update the terminal tab/window title with session status markers (●, ✓, ◆).",
    defaultValue: DEFAULT_TUI_TITLE,
  },
  {
    kind: "toggle",
    key: "progress",
    tab: "alerts",
    label: "Taskbar progress",
    description: "Show running/waiting progress on supported terminal tabs and taskbars (OSC 9;4).",
    defaultValue: DEFAULT_TUI_PROGRESS,
  },
]

export function resolveEditableSettings(source: TuiSettings): Required<EditableTuiSettings> {
  return {
    margin: source.margin ?? DEFAULT_TUI_MARGIN,
    marginRows: source.marginRows ?? DEFAULT_TUI_MARGIN_ROWS,
    shellOutputLines: source.shellOutputLines ?? DEFAULT_SHELL_OUTPUT_LINES,
    clock: source.clock ?? DEFAULT_TUI_CLOCK,
    submitWhileWorking: source.submitWhileWorking ?? DEFAULT_TUI_SUBMIT_WHILE_WORKING,
    colorDepth: source.colorDepth ?? DEFAULT_TUI_COLOR_DEPTH,
    images: source.images ?? DEFAULT_TUI_IMAGES,
    tokenSpeed: source.tokenSpeed ?? DEFAULT_TUI_TOKEN_SPEED,
    bell: source.bell ?? DEFAULT_TUI_BELL,
    notify: source.notify ?? DEFAULT_TUI_NOTIFY,
    title: source.title ?? DEFAULT_TUI_TITLE,
    progress: source.progress ?? DEFAULT_TUI_PROGRESS,
  }
}

export function diffEditableSettings(
  initial: Required<EditableTuiSettings>,
  draft: Required<EditableTuiSettings>,
): Partial<TuiSettings> {
  const patch: Partial<TuiSettings> = {}
  for (const field of SETTINGS_FIELDS) {
    const k = field.key
    if (draft[k] !== initial[k]) Object.assign(patch, { [k]: draft[k] })
  }
  return patch
}

export function defaultEditableSettings(): Required<EditableTuiSettings> {
  return resolveEditableSettings({})
}

type MouseAction =
  | { kind: "tab"; tab: SettingsTabId }
  | { kind: "focus"; index: number }
  | { kind: "set"; index: number; key: EditableTuiKey; value: EditableTuiSettings[EditableTuiKey] }
  | { kind: "step"; index: number; key: "margin" | "marginRows" | "shellOutputLines"; delta: -1 | 1 }
  | { kind: "action"; action: "save" | "reset-tab" | "defaults" | "cancel" }

interface TargetSpec {
  id: string
  x: number
  y: number
  width: number
  action: MouseAction
}

export interface SettingsMenuOptions {
  initial: TuiSettings
  keys?: Keybindings
  viewport?: () => { columns: number; rows: number }
  onPreview: (draft: Required<EditableTuiSettings>) => void
  onSave: (patch: Partial<TuiSettings>, draft: Required<EditableTuiSettings>) => void
  onCancel: () => void
}

/**
 * Clickable GUI-button settings menu hosted in the bottom dialog slot so the real
 * transcript, header and outer margins stay live and visible behind it while editing.
 */
export class SettingsMenuDialog extends Dialog {
  readonly #initial: Required<EditableTuiSettings>
  #draft: Required<EditableTuiSettings>
  #tab: SettingsTabId = "layout"
  #focus = 0
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
    this.#initial = resolveEditableSettings(opts.initial)
    this.#draft = { ...this.#initial }
  }

  get draft(): Required<EditableTuiSettings> {
    return { ...this.#draft }
  }

  get activeTab(): SettingsTabId {
    return this.#tab
  }

  get dirty(): boolean {
    return Object.keys(diffEditableSettings(this.#initial, this.#draft)).length > 0
  }

  override close(): void {
    this.#closed = true
    this.#hits.reset()
    this.#actions.clear()
    super.close()
  }

  #tabFields(): SettingsField[] {
    return SETTINGS_FIELDS.filter((f) => f.tab === this.#tab)
  }

  #setValue<K extends EditableTuiKey>(key: K, value: Required<EditableTuiSettings>[K]): void {
    if (this.#draft[key] === value) return
    this.#draft = { ...this.#draft, [key]: value }
    this.#opts.onPreview(this.draft)
  }

  #stepNumber(field: NumberField, delta: -1 | 1): void {
    const next = Math.max(field.min, Math.min(field.max, this.#draft[field.key] + delta))
    this.#setValue(field.key, next)
  }

  #adjustFocused(delta: -1 | 1): void {
    const field = this.#tabFields()[this.#focus]
    if (!field) return
    if (field.kind === "number") {
      this.#stepNumber(field, delta)
    } else if (field.kind === "toggle") {
      this.#setValue(field.key, !this.#draft[field.key])
    } else {
      const idx = field.options.findIndex((o) => o.value === this.#draft[field.key])
      const next = field.options[(idx + delta + field.options.length) % field.options.length]!
      this.#setValue(field.key, next.value)
    }
  }

  #resetTab(): void {
    const next = { ...this.#draft }
    let changed = false
    for (const field of this.#tabFields()) {
      if (next[field.key] !== field.defaultValue) {
        Object.assign(next, { [field.key]: field.defaultValue })
        changed = true
      }
    }
    if (!changed) return
    this.#draft = next
    this.#opts.onPreview(this.draft)
  }

  #resetAll(): void {
    const defaults = defaultEditableSettings()
    if (Object.keys(diffEditableSettings(this.#draft, defaults)).length === 0) return
    this.#draft = defaults
    this.#opts.onPreview(this.draft)
  }

  #commit(): void {
    if (this.#closed) return
    this.#closed = true
    this.#hits.reset()
    this.#actions.clear()
    this.#opts.onSave(diffEditableSettings(this.#initial, this.#draft), this.draft)
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
    if (matchesKey(event, "escape") || matchesKey(event, "c", { ctrl: true })) {
      this.#abort()
      return true
    }
    if (matchesKey(event, "enter") || matchesKey(event, "s", { ctrl: true })) {
      this.#commit()
      return true
    }
    if (matchesKey(event, "tab")) {
      const step = matchesKey(event, "tab", { shift: true }) ? -1 : 1
      const i = SETTINGS_TABS.findIndex((t) => t.id === this.#tab)
      this.#tab = SETTINGS_TABS[(i + step + SETTINGS_TABS.length) % SETTINGS_TABS.length]!.id
      this.#focus = 0
      return true
    }
    if (
      event.type === "key" &&
      !event.ctrl &&
      !event.alt &&
      event.text &&
      ["1", "2", "3"].includes(event.text)
    ) {
      const next = SETTINGS_TABS[Number(event.text) - 1]
      if (next) {
        this.#tab = next.id
        this.#focus = 0
      }
      return true
    }
    const fields = this.#tabFields()
    if (matchesKey(event, "up") || matchesKey(event, "k")) {
      this.#focus = (this.#focus - 1 + fields.length) % fields.length
      return true
    }
    if (matchesKey(event, "down") || matchesKey(event, "j")) {
      this.#focus = (this.#focus + 1) % fields.length
      return true
    }
    if (matchesKey(event, "left") || matchesKey(event, "h") || matchesKey(event, "-")) {
      this.#adjustFocused(-1)
      return true
    }
    if (
      matchesKey(event, "right") ||
      matchesKey(event, "l") ||
      matchesKey(event, "+") ||
      matchesKey(event, "=")
    ) {
      this.#adjustFocused(1)
      return true
    }
    if (matchesKey(event, "space")) {
      this.#adjustFocused(1)
      return true
    }
    if (matchesKey(event, "r") || matchesKey(event, "r", { ctrl: true })) {
      const field = fields[this.#focus]
      if (field) this.#setValue(field.key, field.defaultValue)
      return true
    }
    return true
  }

  #handleMouse(event: MouseInput): boolean {
    if (event.action === "wheel") {
      if (event.button === "up" || event.button === "down") {
        const fields = this.#tabFields()
        this.#focus = (this.#focus + (event.button === "down" ? 1 : -1) + fields.length) % fields.length
        return true
      }
      return false
    }
    const hit = this.#hits.handle(event)
    const action = hit && this.#actions.get(hit.id)
    if (!hit || !action) return true
    switch (action.kind) {
      case "tab":
        this.#tab = action.tab
        this.#focus = 0
        return true
      case "focus": {
        this.#focus = action.index
        const field = this.#tabFields()[action.index]
        if (field?.kind === "toggle") this.#setValue(field.key, !this.#draft[field.key])
        return true
      }
      case "set":
        this.#focus = action.index
        this.#setValue(action.key, action.value as never)
        return true
      case "step": {
        this.#focus = action.index
        const field = this.#tabFields()[action.index]
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

  override render(width: number, ctx: RenderContext): string[] {
    this.#hits.clear()
    this.#actions.clear()
    if (this.#closed) return []
    const { theme } = ctx
    const compact = width < 6 || this.maxRows < 4
    const inner = compact ? Math.max(1, width) : Math.max(1, width - 4)
    const vp = this.#opts.viewport?.() ?? { columns: width, rows: ctx.rows }
    const geom = contentGeometry(vp.columns, vp.rows, this.#draft)
    const sep = ` ${glyphs.separator} `
    const dims = `${geom.width}×${geom.height} (margin ${this.#draft.margin}, rows ${this.#draft.marginRows})`
    const dirtyTag = this.dirty ? ` ${theme.accent(`${glyphs.separator} unsaved`)}` : ""
    const title = `${bold(theme.text("Settings"))} ${theme.muted(`${glyphs.separator} ${dims}`)}${dirtyTag}`

    const body: string[] = []
    const targets: TargetSpec[] = []
    const addTarget = (target: TargetSpec) => targets.push(target)

    // Row 0: Clickable category tabs
    let tabLine = ""
    for (const tab of SETTINGS_TABS) {
      const active = tab.id === this.#tab
      const raw = `[ ${tab.label} ]`
      const styled = active
        ? ctx.color
          ? inverse(bold(theme.accent(raw)))
          : bold(theme.accent(raw))
        : theme.muted(raw)
      if (tabLine) tabLine += "  "
      const x = visibleWidth(tabLine)
      if (x + visibleWidth(raw) <= inner) {
        addTarget({
          id: `tab:${tab.id}`,
          x,
          y: body.length,
          width: visibleWidth(raw),
          action: { kind: "tab", tab: tab.id },
        })
      }
      tabLine += styled
    }
    body.push(tabLine)
    body.push(theme.border(glyphs.rule.repeat(inner)))

    // Settings rows for active tab
    const fields = this.#tabFields()
    const labelCol = Math.min(20, Math.max(12, ...fields.map((f) => visibleWidth(f.label) + 4)))
    const controlRoom = Math.max(12, inner - labelCol - 1)
    const ascii = asciiGlyphs()

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!
      const focused = i === this.#focus
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
            {
              text: pill(String(current), true),
              raw: `[ ${current} ]`,
              action: { kind: "focus", index: i },
            },
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
        const current = String(value)
        const allWidth = field.options.reduce((sum, o) => sum + `[ ${o.label} ]`.length + 1, 0)
        if (allWidth <= controlRoom) {
          for (const opt of field.options) {
            controls.push({
              text: pill(opt.label, opt.value === current),
              raw: `[ ${opt.label} ]`,
              action: { kind: "set", index: i, key: field.key, value: opt.value },
            })
          }
        } else {
          const chosen = field.options.find((o) => o.value === current)?.label ?? current
          const idx = field.options.findIndex((o) => o.value === current)
          const prev = field.options[(idx - 1 + field.options.length) % field.options.length]!
          const next = field.options[(idx + 1) % field.options.length]!
          controls.push(
            {
              text: pill(ascii ? "<" : "‹", false),
              raw: `[ ${ascii ? "<" : "‹"} ]`,
              action: { kind: "set", index: i, key: field.key, value: prev.value },
            },
            {
              text: pill(chosen, true),
              raw: `[ ${chosen} ]`,
              action: { kind: "focus", index: i },
            },
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

      // Label click focuses (or toggles) row
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
          addTarget({
            id: `ctrl:${i}:${c}`,
            x,
            y: controlY,
            width: w,
            action: item.action,
          })
        }
        controlLine += item.text
      }
      const controlWithSuffix =
        suffix && baseX + visibleWidth(controlLine) + visibleWidth(suffix) <= inner
          ? controlLine + suffix
          : controlLine

      if (inline) {
        body.push(labelPart + controlWithSuffix)
      } else {
        body.push(labelPart.trimEnd())
        body.push(`  ${controlWithSuffix}`)
      }
    }

    // Description of focused setting
    const focusedField = fields[this.#focus]
    if (focusedField) {
      body.push("")
      const defaultNote = `Default: ${String(focusedField.defaultValue)}`
      body.push(
        theme.muted(truncateToWidth(`  ${focusedField.description} (${defaultNote})`, inner, viewEllipsis())),
      )
    }

    // Action button bar
    body.push(theme.border(glyphs.rule.repeat(inner)))
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
          action: { kind: "action", action: btn.id },
        })
        actionRow += `${styled}  `
      }
    }
    body.push(actionRow.trimEnd())

    // Keyboard hint footer (last line preserved by dialogFrame)
    const arrows = ascii ? "up/down" : "↑↓"
    const lr = ascii ? "left/right" : "←→"
    const hint = `click buttons${sep}tab section${sep}${arrows} field${sep}${lr} adjust${sep}enter save${sep}esc restore`
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
}
