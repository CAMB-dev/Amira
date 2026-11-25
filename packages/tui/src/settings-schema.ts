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
  DEFAULT_TUI_THEME,
  DEFAULT_TUI_THEME_VARIANT,
  DEFAULT_TUI_TITLE,
  DEFAULT_TUI_TOKEN_SPEED,
  type ShimmerEffect,
  type ShimmerPreset,
  type TuiSettings,
} from "@amira/api"
import { normalizeShimmer, SHIMMER_PRESETS } from "@amira/host"
import { contentGeometry } from "./margins.ts"

export type SettingsSectionId = "layout" | "appearance" | "behavior" | "alerts"

export type ShimmerChoice = "theme" | ShimmerPreset | "custom"

export interface EditableTuiSettings {
  margin: number
  marginRows: number
  shellOutputLines: number
  theme: string
  themeVariant: NonNullable<TuiSettings["themeVariant"]>
  colorDepth: NonNullable<TuiSettings["colorDepth"]>
  shimmer: ShimmerChoice
  images: NonNullable<TuiSettings["images"]>
  submitWhileWorking: NonNullable<TuiSettings["submitWhileWorking"]>
  clock: NonNullable<TuiSettings["clock"]>
  tokenSpeed: boolean
  bell: boolean
  notify: NonNullable<TuiSettings["notify"]>
  title: boolean
  progress: boolean
}

export type EditableTuiKey = keyof EditableTuiSettings

export interface NumberField {
  kind: "number"
  key: "margin" | "marginRows" | "shellOutputLines"
  section: SettingsSectionId
  label: string
  description: string
  min: number
  max: number
  defaultValue: number
  presets: readonly number[]
  liveSuffix?: (draft: EditableTuiSettings, viewport: { columns: number; rows: number }) => string
}

export interface ChoiceField<K extends EditableTuiKey = EditableTuiKey> {
  kind: "choice"
  key: K
  section: SettingsSectionId
  label: string
  description: string
  defaultValue: EditableTuiSettings[K]
  options:
    | readonly { value: EditableTuiSettings[K]; label: string }[]
    | ((themeNames: readonly string[]) => readonly { value: EditableTuiSettings[K]; label: string }[])
}

export interface ToggleField {
  kind: "toggle"
  key: "tokenSpeed" | "bell" | "title" | "progress"
  section: SettingsSectionId
  label: string
  description: string
  defaultValue: boolean
}

export type SettingsField = NumberField | ChoiceField | ToggleField

export interface SettingsSection {
  id: SettingsSectionId
  label: string
  description: string
  summary: (draft: EditableTuiSettings) => string
}

const DEFAULT_THEME_NAMES = ["amira", "amber", "burnt", "lavender", "mono", "ascii", "terminal"]
const SHIMMER_PRESET_NAMES = Object.keys(SHIMMER_PRESETS) as ShimmerPreset[]

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "layout",
    label: "Layout & Display",
    description: "Screen side margins (live preview), top/bottom padding, and shell output lines.",
    summary: (d) => `margin ${d.margin} · rows ${d.marginRows} · shell ${d.shellOutputLines}`,
  },
  {
    id: "appearance",
    label: "Theme & Appearance",
    description: "Color theme, light/dark mode, color depth, activity shimmer, and inline images.",
    summary: (d) => `${d.theme} (${d.themeVariant}) · ${d.colorDepth} · shimmer ${d.shimmer}`,
  },
  {
    id: "behavior",
    label: "Behavior & Input",
    description: "What Enter does while a turn runs, timestamp clock cycle, and live token speed.",
    summary: (d) => `busy: ${d.submitWhileWorking} · clock ${d.clock} · tok/s ${d.tokenSpeed ? "on" : "off"}`,
  },
  {
    id: "alerts",
    label: "Alerts & Terminal",
    description: "Terminal bell, desktop notifications, window title markers, and taskbar progress.",
    summary: (d) =>
      `bell ${d.bell ? "on" : "off"} · notify ${d.notify} · title ${d.title ? "on" : "off"} · bar ${d.progress ? "on" : "off"}`,
  },
]

export const SETTINGS_FIELDS: readonly SettingsField[] = [
  {
    kind: "number",
    key: "margin",
    section: "layout",
    label: "Side margin",
    description: "Left/right outer margin in cells (0–12). Previews live; shrinks on narrow terminals.",
    min: 0,
    max: 12,
    defaultValue: DEFAULT_TUI_MARGIN,
    presets: [0, 1, 2, 3, 4, 6, 8],
    liveSuffix: (draft, vp) =>
      `${contentGeometry(vp.columns, vp.rows, { margin: draft.margin, marginRows: draft.marginRows }).width} cols`,
  },
  {
    kind: "number",
    key: "marginRows",
    section: "layout",
    label: "Top/bottom rows",
    description: "Outer top/bottom padding in rows (0–2). Dropped automatically below 24 rows.",
    min: 0,
    max: 2,
    defaultValue: DEFAULT_TUI_MARGIN_ROWS,
    presets: [0, 1, 2],
    liveSuffix: (draft, vp) =>
      `${contentGeometry(vp.columns, vp.rows, { margin: draft.margin, marginRows: draft.marginRows }).height} rows`,
  },
  {
    kind: "number",
    key: "shellOutputLines",
    section: "layout",
    label: "Shell preview",
    description: "Tail lines shown under succeeded shell calls in summary detail mode (0–20).",
    min: 0,
    max: 20,
    defaultValue: DEFAULT_SHELL_OUTPUT_LINES,
    presets: [0, 3, 6, 10],
  },
  {
    kind: "choice",
    key: "theme",
    section: "appearance",
    label: "Theme",
    description: "Terminal color palette and glyph theme. Previews live on the conversation above.",
    defaultValue: "amira",
    options: (names) =>
      (names.length ? names : DEFAULT_THEME_NAMES).map((name) => ({ value: name, label: name })),
  },
  {
    kind: "choice",
    key: "themeVariant",
    section: "appearance",
    label: "Appearance",
    description: "Follow terminal background automatically, or force dark or light palette.",
    defaultValue: DEFAULT_TUI_THEME_VARIANT,
    options: [
      { value: "auto", label: "auto" },
      { value: "dark", label: "dark" },
      { value: "light", label: "light" },
    ],
  },
  {
    kind: "choice",
    key: "colorDepth",
    section: "appearance",
    label: "Color depth",
    description: "Terminal color depth; auto detects capabilities from your terminal.",
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
    key: "shimmer",
    section: "appearance",
    label: "Shimmer",
    description: "Activity row highlight animation preset, or inherit the selected theme's default.",
    defaultValue: "theme",
    options: [
      { value: "theme", label: "theme" },
      ...SHIMMER_PRESET_NAMES.map((preset) => ({ value: preset, label: preset })),
    ],
  },
  {
    kind: "choice",
    key: "images",
    section: "appearance",
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
    kind: "choice",
    key: "submitWhileWorking",
    section: "behavior",
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
    key: "clock",
    section: "behavior",
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
    kind: "toggle",
    key: "tokenSpeed",
    section: "behavior",
    label: "Token speed",
    description: "Show live generation speed (tok/s) and thinking duration in the status strip.",
    defaultValue: DEFAULT_TUI_TOKEN_SPEED,
  },
  {
    kind: "toggle",
    key: "bell",
    section: "alerts",
    label: "Terminal bell",
    description: "Ring the terminal bell once when a turn finishes in the background or waits on you.",
    defaultValue: DEFAULT_TUI_BELL,
  },
  {
    kind: "choice",
    key: "notify",
    section: "alerts",
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
    section: "alerts",
    label: "Window title",
    description: "Update the terminal tab/window title with session status markers (●, ✓, ◆).",
    defaultValue: DEFAULT_TUI_TITLE,
  },
  {
    kind: "toggle",
    key: "progress",
    section: "alerts",
    label: "Taskbar progress",
    description: "Show running/waiting progress on supported terminal tabs and taskbars (OSC 9;4).",
    defaultValue: DEFAULT_TUI_PROGRESS,
  },
]

export function shimmerChoiceOf(effect: ShimmerEffect | undefined): ShimmerChoice {
  const normalized = normalizeShimmer(effect)
  if (!normalized || !Object.keys(normalized).length) return "theme"
  if (
    normalized.preset &&
    Object.keys(normalized).every(
      (k) => k === "preset" || normalized[k as keyof typeof normalized] === undefined,
    )
  ) {
    return normalized.preset === "sweep" ? "soft" : normalized.preset
  }
  return "custom"
}

export function shimmerEffectFromChoice(
  choice: ShimmerChoice,
  original: ShimmerEffect | undefined,
): ShimmerEffect | undefined {
  if (choice === "theme") return undefined
  if (choice === "custom") return original
  return choice
}

export function resolveEditableSettings(
  source: TuiSettings,
  runtimeTheme?: {
    name: string
    themeVariant: NonNullable<TuiSettings["themeVariant"]>
    shimmer?: ShimmerEffect
  },
): EditableTuiSettings {
  const rawTheme = runtimeTheme?.name ?? source.theme ?? DEFAULT_TUI_THEME
  const theme = rawTheme === "auto" || rawTheme === "dark" || rawTheme === "light" ? "amira" : rawTheme
  const themeVariant =
    runtimeTheme?.themeVariant ??
    (rawTheme === "dark" || rawTheme === "light"
      ? rawTheme
      : (source.themeVariant ?? DEFAULT_TUI_THEME_VARIANT))
  return {
    margin: source.margin ?? DEFAULT_TUI_MARGIN,
    marginRows: source.marginRows ?? DEFAULT_TUI_MARGIN_ROWS,
    shellOutputLines: source.shellOutputLines ?? DEFAULT_SHELL_OUTPUT_LINES,
    theme,
    themeVariant,
    colorDepth: source.colorDepth ?? DEFAULT_TUI_COLOR_DEPTH,
    shimmer: shimmerChoiceOf(runtimeTheme ? runtimeTheme.shimmer : source.shimmer),
    images: source.images ?? DEFAULT_TUI_IMAGES,
    submitWhileWorking: source.submitWhileWorking ?? DEFAULT_TUI_SUBMIT_WHILE_WORKING,
    clock: source.clock ?? DEFAULT_TUI_CLOCK,
    tokenSpeed: source.tokenSpeed ?? DEFAULT_TUI_TOKEN_SPEED,
    bell: source.bell ?? DEFAULT_TUI_BELL,
    notify: source.notify ?? DEFAULT_TUI_NOTIFY,
    title: source.title ?? DEFAULT_TUI_TITLE,
    progress: source.progress ?? DEFAULT_TUI_PROGRESS,
  }
}

export function defaultEditableSettings(): EditableTuiSettings {
  return resolveEditableSettings({})
}

export function diffEditableSettings(
  initial: EditableTuiSettings,
  draft: EditableTuiSettings,
  originalShimmer?: ShimmerEffect,
): Partial<TuiSettings> {
  const patch: Partial<TuiSettings> = {}
  for (const field of SETTINGS_FIELDS) {
    const k = field.key
    if (draft[k] === initial[k]) continue
    if (k === "shimmer") {
      patch.shimmer = shimmerEffectFromChoice(draft.shimmer, originalShimmer)
    } else {
      Object.assign(patch, { [k]: draft[k] })
    }
  }
  return patch
}
