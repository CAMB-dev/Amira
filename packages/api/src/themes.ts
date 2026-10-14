/** Terminal colors are opaque RGB hex strings (#RGB or #RRGGBB). */
export type ThemeHex = `#${string}`

export type ShimmerPreset = "off" | "soft" | "sharp" | "wide" | "bounce" | "pulse" | "wave" | "reveal"
export type ShimmerStyle = "off" | "sweep" | "bounce" | "pulse" | "wave" | "reveal"

/** Two gradient stops, shared by both appearances or selected by appearance. */
export type ShimmerColors =
  | readonly [ThemeHex, ThemeHex]
  | { dark: readonly [ThemeHex, ThemeHex]; light: readonly [ThemeHex, ThemeHex] }

export interface ShimmerOptions {
  preset?: ShimmerPreset | "sweep"
  style?: ShimmerStyle
  /** Highlight width in terminal cells, rounded and clamped to 1–20. */
  width?: number
  /** Animation cycle in milliseconds, clamped to 400–5000. */
  period?: number
  edge?: "soft" | "linear" | "hard"
  direction?: "ltr" | "rtl"
  /** Omitted colors use the theme's shimmer/shimmerEnd tokens, including wave. */
  colors?: ShimmerColors
}

export type ShimmerEffect = ShimmerPreset | ShimmerOptions

/** Canonical palette keys shared by the host and terminal frontends. */
export const THEME_PALETTE_TOKENS = [
  "bg",
  "fg",
  "accent",
  "heading1",
  "heading",
  "path",
  "command",
  "fg2",
  "muted",
  "dim",
  "border",
  "borderFocused",
  "success",
  "error",
  "warning",
  "thinking",
  "userBg",
  "codeBg",
  "diffAddedBg",
  "diffRemovedBg",
  "diffAddedWordBg",
  "diffRemovedWordBg",
  "keyword",
  "string",
  "number",
  "shimmer",
  "shimmerEnd",
] as const

export type ThemePaletteToken = (typeof THEME_PALETTE_TOKENS)[number]

/** Shimmer stops are independent overrides, not derived from the accent. */
export type ThemePalette = Record<Exclude<ThemePaletteToken, "shimmer" | "shimmerEnd">, ThemeHex> & {
  shimmer?: ThemeHex
  shimmerEnd?: ThemeHex
}

/** The display vocabulary shared by agent trees, pickers and extension views. */
export const AGENT_STATUS_BADGES = {
  queued: { symbol: "·", ascii: ".", role: "dim", label: "queued" },
  working: { symbol: "⠋", ascii: "*", role: "accent", label: "working" },
  idle: { symbol: "○", ascii: "o", role: "muted", label: "idle" },
  paused: { symbol: "‖", ascii: "|", role: "warning", label: "paused" },
  done: { symbol: "✓", ascii: "v", role: "success", label: "done" },
  failed: { symbol: "✗", ascii: "x", role: "error", label: "failed" },
  stopped: { symbol: "‖", ascii: "|", role: "warning", label: "stopped" },
} as const

export type AgentStatusState = keyof typeof AGENT_STATUS_BADGES

/** Default symbols from both terminal glyph sets; overrides use these flat keys. */
export const DEFAULT_THEME_GLYPHS = Object.freeze({
  bullets: ["•", "◦", "▪"],
  taskOpen: "[ ]",
  taskDone: "[✓]",
  quoteBar: "▎",
  rule: "─",
  codeTop: "╭─",
  codeSide: "│",
  codeBottom: "╰─",
  tableColumn: "│",
  tableRule: "─",
  tableCross: "┼",
  boxTopLeft: "╭",
  boxTopRight: "╮",
  boxBottomLeft: "╰",
  boxBottomRight: "╯",
  image: "🖼\uFE0F",
  user: "›",
  assistant: "  ",
  toolDone: "✓",
  toolRunning: "●",
  toolFailed: "✗",
  toolInterrupted: "⊘",
  toolBlocked: "⊘",
  toolUnknown: "⊘",
  toolInvalid: "⊘",
  result: "└",
  treeBranch: "├",
  treeLast: "└",
  treePipe: "│",
  turnOutput: "⇣",
  output: "│",
  subagent: "◆",
  subagentDone: "✓",
  subagentFailed: "✗",
  subagentAborted: "⊘",
  statusQueued: AGENT_STATUS_BADGES.queued.symbol,
  statusWorking: AGENT_STATUS_BADGES.working.symbol,
  statusIdle: AGENT_STATUS_BADGES.idle.symbol,
  statusPaused: AGENT_STATUS_BADGES.paused.symbol,
  statusDone: AGENT_STATUS_BADGES.done.symbol,
  statusFailed: AGENT_STATUS_BADGES.failed.symbol,
  statusStopped: AGENT_STATUS_BADGES.stopped.symbol,
  thought: "∴",
  question: "?",
  dialogBar: "┃",
  choice: "❯",
  checked: "[x]",
  unchecked: "[ ]",
  info: "•",
  success: "✓",
  warning: "⚠\uFE0F",
  error: "✗",
  interrupted: "⊘",
  more: "…",
  folded: "▸",
  pointer: "❯",
  search: "⌕",
  searchPrompt: "›",
  working: "●",
  branch: "⎇",
  separator: "·",
})
Object.freeze(DEFAULT_THEME_GLYPHS.bullets)

export type ThemeGlyphs = {
  -readonly [K in keyof typeof DEFAULT_THEME_GLYPHS]: K extends "bullets" ? string[] : string
}

/** Missing colors and glyphs inherit the frontend's default for the current appearance. */
export interface ThemeDefinition {
  name: string
  description?: string
  dark?: Partial<ThemePalette>
  light?: Partial<ThemePalette>
  glyphs?: Partial<ThemeGlyphs>
  /** Activity-label animation; user tui.shimmer overrides individual knobs. */
  shimmerEffect?: ShimmerEffect
}

export type ThemeSource = "built-in" | "user" | "project" | "package" | "extension"
