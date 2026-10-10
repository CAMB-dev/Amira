import { sgrAttributes, sgrGroup } from "@amira/text-width"
import {
  type Background,
  backgroundFromEnv,
  backgroundOf,
  type Capabilities,
  type Rgb,
} from "./capabilities.ts"
import {
  blend,
  type ColorDepth,
  type ColorDepthSetting,
  type ColorHint,
  detectColorDepth,
  type Hex,
  nearest256,
  quantize,
} from "./colors.ts"
import type { Glyphs } from "./glyphs.ts"
import { consoleHost, type Palette, palettes, surfacePalette } from "./palette.ts"

export type StyleFn = (text: string) => string

let colorOn = colorSupported(process.env)

/** Colors are off when `NO_COLOR` is set to a non-empty value, and on a dumb terminal (`TERM=dumb`). */
export function colorSupported(env: Record<string, string | undefined>): boolean {
  return !env.NO_COLOR && env.TERM !== "dumb"
}

/** Sets the default for `RenderContext.color`, used by renderers that are not told otherwise. */
export function setColorEnabled(on: boolean): void {
  colorOn = on
}

export function isColorEnabled(): boolean {
  return colorOn
}

function sgr(open: number | string, close: number): StyleFn {
  const o = `\x1b[${open}m`
  const c = `\x1b[${close}m`
  // Re-open after nested closes so an inner style does not end the outer one.
  return (text) => o + text.replaceAll(c, c + o) + c
}

export const bold = sgr(1, 22)
export const dim = sgr(2, 22)
export const italic = sgr(3, 23)
export const underline = sgr(4, 24)
export const inverse = sgr(7, 27)
export const strikethrough = sgr(9, 29)

export const black = sgr(30, 39)
export const red = sgr(31, 39)
export const green = sgr(32, 39)
export const yellow = sgr(33, 39)
export const blue = sgr(34, 39)
export const magenta = sgr(35, 39)
export const cyan = sgr(36, 39)
export const white = sgr(37, 39)
export const gray = sgr(90, 39)

export const fg256 = (n: number): StyleFn => sgr(`38;5;${n}`, 39)
export const bg256 = (n: number): StyleFn => sgr(`48;5;${n}`, 49)
export const rgb = (r: number, g: number, b: number): StyleFn => sgr(`38;2;${r};${g};${b}`, 39)

export function compose(...fns: StyleFn[]): StyleFn {
  return (text) => fns.reduceRight((acc, fn) => fn(acc), text)
}

/**
 * Semantic color tokens, so components never hardcode colors. The built-in components use the
 * named ones; an app can add tokens of its own (`{ ...defaultTheme, link: blue }`).
 */
export interface Theme {
  text: StyleFn
  accent: StyleFn
  muted: StyleFn
  error: StyleFn
  success: StyleFn
  warning: StyleFn
  /** Borders and rules, such as the frame around the input box. */
  border: StyleFn
  path: StyleFn
  command: StyleFn
  fg2: StyleFn
  dim: StyleFn
  borderFocused: StyleFn
  thinking: StyleFn
  /** The first gradient stop; shimmerEnd and shimmer0…shimmer15 expose quantized steps. */
  shimmer: StyleFn
  [token: string]: StyleFn
}

/**
 * Tokens for rendered Markdown (`MarkdownStream`), part of `defaultTheme`. A theme that leaves
 * one out gets the value from here.
 */
const ansiMarkdownTheme = {
  heading: compose(bold, cyan),
  /** Headings of level 3 and deeper. */
  subheading: bold,
  strong: bold,
  emphasis: italic,
  strike: strikethrough,
  /** Inline `code`. */
  code: magenta,
  link: compose(underline, blue),
  /** The URL shown after a link's text when the terminal cannot make it clickable. */
  linkUrl: gray,
  /** An image shown as its alt text, when it is not a clickable link. */
  image: italic,
  quote: italic,
  quoteBar: gray,
  listMarker: cyan,
  rule: gray,
  /** The frame and language label of a code block. */
  codeFrame: gray,
  tableBorder: gray,
  tableHeader: bold,
  /** Syntax highlighting inside code blocks. */
  keyword: blue,
  string: green,
  number: yellow,
  comment: gray,
} satisfies Record<string, StyleFn>

export type MarkdownToken = keyof typeof ansiMarkdownTheme

/** Half-block ends use the body's background as their foreground, leaving the outside clear. */
function chip(foreground: number, background: number): StyleFn {
  const edge = fg256(background)
  const body = compose(bg256(background), fg256(foreground))
  return (text) => edge("▐") + body(text) + edge("▌")
}

/** Original ANSI foregrounds, for the terminal theme and depth-16 fallback. */
export const terminalTheme: Theme = {
  text: (s) => s,
  accent: cyan,
  muted: gray,
  error: red,
  success: green,
  warning: yellow,
  border: gray,
  path: blue,
  command: magenta,
  fg2: (s) => s,
  dim: gray,
  borderFocused: cyan,
  thinking: gray,
  shimmer: cyan,
  shimmerEnd: blue,
  /** Chip foregrounds are explicit so their filled labels work on dark and light terminals. */
  chipNeutral: chip(231, 240),
  chipInfo: chip(231, 24),
  chipSuccess: chip(231, 22),
  chipWarning: chip(16, 178),
  chipDanger: chip(231, 124),
  chipAccent: chip(231, 54),
  /** Text selected with the mouse, as in a full-screen transcript. */
  selection: inverse,
  ...ansiMarkdownTheme,
}

const plainText: StyleFn = (s) => s

/**
 * The theme for a terminal without colors (NO_COLOR): what colors told apart is told apart by
 * attributes, which survive `stripColors`. Muted text and borders are dim, the accent and
 * warnings bold, headings by level (H1 bold and underlined, H2 bold, deeper bold italic), and
 * inline code keeps its backticks (`codeTicks`), since nothing else would mark it.
 */
export const monoTheme: Theme = {
  text: plainText,
  accent: bold,
  muted: dim,
  error: bold,
  success: plainText,
  warning: bold,
  border: dim,
  path: underline,
  command: plainText,
  fg2: plainText,
  dim,
  borderFocused: bold,
  thinking: dim,
  shimmer: bold,
  shimmerEnd: bold,
  selection: inverse,
  heading: bold,
  heading1: compose(bold, underline),
  subheading: compose(bold, italic),
  strong: bold,
  emphasis: italic,
  strike: strikethrough,
  code: plainText,
  codeTicks: dim,
  link: underline,
  linkUrl: dim,
  image: italic,
  quote: italic,
  quoteBar: dim,
  listMarker: plainText,
  rule: dim,
  codeFrame: dim,
  tableBorder: dim,
  tableHeader: bold,
  keyword: plainText,
  string: plainText,
  number: plainText,
  comment: dim,
}

/**
 * Background colors for surfaces: the band behind the user's messages and the lines of a diff.
 * Not in `defaultTheme`, since what suits a terminal depends on its background; an app adds
 * them with `surfaceTheme` (and leaves them out without colors, where a band would only be
 * blank rows). Components draw without them as before.
 */
export interface SurfaceTokens {
  /** Behind the user's messages, the width of the screen. */
  userBg: StyleFn
  /** Behind fenced code blocks. */
  codeBg?: StyleFn
  /** Behind added and removed diff lines. */
  diffAddedBg: StyleFn
  diffRemovedBg: StyleFn
  /** Behind the words that changed within a changed line. */
  diffAddedWordBg: StyleFn
  diffRemovedWordBg: StyleFn
  /** Muted text (line numbers, an echoed command) drawn on one of these backgrounds. */
  surfaceMuted: StyleFn
}

/** Palette surfaces, quantized once with the foreground tokens. Unknown backgrounds use dark. */
export function surfaceTheme(
  background: Background | undefined,
  depth: ColorDepth = "truecolor",
  detected?: Rgb,
  platform = "other",
  host: ReturnType<typeof consoleHost> = "other",
  palette: Palette = palettes[background ?? "dark"],
): SurfaceTokens {
  if (depth === "16") {
    const [user, added, removed, addedWord, removedWord] =
      background === "dark"
        ? [236, 22, 52, 28, 88]
        : background === "light"
          ? [254, 194, 224, 157, 217]
          : [242, 65, 131, 71, 167]
    return {
      userBg: bg256(user),
      diffAddedBg: bg256(added),
      diffRemovedBg: bg256(removed),
      diffAddedWordBg: bg256(addedWord),
      diffRemovedWordBg: bg256(removedWord),
      surfaceMuted: background ? gray : plainText,
    }
  }
  const surfaces = surfacePalette(palette, detected, platform, host)
  const added = depth === "256" ? nearest256(surfaces.diffAddedBg, { dominant: "green" }) : undefined
  const removed = depth === "256" ? nearest256(surfaces.diffRemovedBg, { dominant: "red" }) : undefined
  const bg = (name: keyof typeof surfaces, fallback: number) => {
    const hint: ColorHint | undefined = name.startsWith("diff")
      ? {
          dominant: name.includes("Added") ? "green" : "red",
          strongerThan: name.includes("Word") ? (name.includes("Added") ? added : removed) : undefined,
        }
      : undefined
    return sgr(quantize(surfaces[name], depth, fallback, true, hint), 49)
  }
  return {
    userBg: bg("userBg", background === "light" ? 47 : 40),
    codeBg: bg("codeBg", background === "light" ? 47 : 40),
    diffAddedBg: bg("diffAddedBg", 42),
    diffRemovedBg: bg("diffRemovedBg", 41),
    diffAddedWordBg: bg("diffAddedWordBg", 102),
    diffRemovedWordBg: bg("diffRemovedWordBg", 101),
    surfaceMuted: sgr(quantize(palette.fg2, depth, 90), 39),
  }
}

/** A registry name or the legacy auto/dark/light/terminal selection. */
export type ThemeSetting = string
export type ThemeVariant = "auto" | "dark" | "light"
/** Structural theme data; named definitions are resolved by the caller's registry. */
export interface ThemeDefinition {
  dark?: Partial<Palette> & { shimmer?: Hex; shimmerEnd?: Hex }
  light?: Partial<Palette> & { shimmer?: Hex; shimmerEnd?: Hex }
  glyphs?: Partial<Glyphs>
}
export interface ThemeOptions {
  theme?: ThemeSetting
  themeVariant?: ThemeVariant
  definition?: ThemeDefinition
  colorDepth?: ColorDepthSetting
  env?: Record<string, string | undefined>
  capabilities?: Partial<Capabilities>
  platform?: string
  /** Renderers may disable colour independently of the environment. */
  color?: boolean
}

/** Builds semantic styles for a selection. Never paints the terminal's base fg or bg. */
export function createTheme(options: ThemeOptions = {}): Theme {
  const env = options.env ?? process.env
  if (options.color === false || !colorSupported(env)) return monoTheme
  const capabilities = options.capabilities ?? {}
  const depth =
    options.theme === "terminal"
      ? "16"
      : options.colorDepth && options.colorDepth !== "auto"
        ? options.colorDepth
        : detectColorDepth(env, capabilities)
  const background =
    options.theme === "dark" || options.theme === "light"
      ? options.theme
      : options.themeVariant === "dark" || options.themeVariant === "light"
        ? options.themeVariant
        : (capabilities.background ??
          (capabilities.backgroundRgb ? backgroundOf(capabilities.backgroundRgb) : backgroundFromEnv(env)))
  // A missing variant falls back to the default of that variant, not the other palette.
  const variant = background ?? "dark"
  const overrides = options.definition?.[variant]
  const p = { ...palettes[variant], ...overrides }
  const shimmer = p.shimmer
  const shimmerEnd = p.shimmerEnd
  const fg = (hex: Hex, fallback = gray) => (depth === "16" ? fallback : sgr(quantize(hex, depth, 90), 39))
  const theme: Theme = {
    ...terminalTheme,
    ...surfaceTheme(
      background,
      depth,
      capabilities.backgroundRgb,
      options.platform ?? process.platform,
      consoleHost(env),
      p,
    ),
    accent: fg(p.accent, cyan),
    muted: fg(p.muted),
    error: fg(p.error, red),
    success: fg(p.success, green),
    warning: fg(p.warning, yellow),
    border: fg(p.border),
    path: fg(p.path, blue),
    command: fg(p.command, magenta),
    fg2: fg(p.fg2, plainText),
    dim: fg(p.dim),
    borderFocused: fg(p.borderFocused, cyan),
    thinking: fg(p.thinking),
    heading1: depth === "16" ? ansiMarkdownTheme.heading : compose(bold, fg(p.heading1)),
    heading: depth === "16" ? ansiMarkdownTheme.heading : compose(bold, fg(p.heading)),
    subheading: depth === "16" ? bold : compose(bold, fg(p.fg2)),
    code: fg(p.command, magenta),
    link: compose(underline, fg(p.path, blue)),
    linkUrl: fg(p.muted),
    quoteBar: fg(p.dim),
    listMarker: fg(p.accent, cyan),
    rule: fg(p.dim),
    codeFrame: fg(p.dim),
    tableBorder: fg(p.dim),
    keyword: fg(p.keyword, blue),
    string: fg(p.string, green),
    number: fg(p.number, yellow),
    comment: fg(p.muted),
    shimmer: fg(shimmer, cyan),
    shimmerEnd: fg(shimmerEnd, blue),
  }
  if (depth === "16") return theme
  for (let i = 0; i < 16; i++) {
    const highlight = blend(shimmer, shimmerEnd, i / 15)
    theme[`shimmer${i}`] = fg(highlight)
    // Quantize the soft edges once, not on each spinner frame.
    for (let fade = 1; fade <= 8; fade++) {
      theme[`shimmer${i}Fade${fade}`] = fg(blend(p.muted, highlight, fade / 8))
    }
  }
  const chipStyle = (background: Hex, fallback: number) => {
    const edge = sgr(quantize(background, depth, fallback - 10), 39)
    const body = compose(sgr(quantize(background, depth, fallback, true), 49), fg(p.bg, black))
    return (text: string) => edge("▐") + body(text) + edge("▌")
  }
  theme.chipNeutral = chipStyle(p.fg2, 47)
  theme.chipInfo = chipStyle(p.heading1, 44)
  theme.chipSuccess = chipStyle(p.success, 42)
  theme.chipWarning = chipStyle(p.warning, 43)
  theme.chipDanger = chipStyle(p.error, 41)
  theme.chipAccent = chipStyle(p.accent, 46)
  return theme
}

/** Safe ANSI defaults; palette colours and surfaces require createTheme at startup. */
export const defaultTheme: Theme = { ...terminalTheme }
export const markdownTheme = ansiMarkdownTheme

/** A token of `theme` that it may not have, such as the surface colors. */
export function themeToken(theme: Theme, name: string): StyleFn | undefined {
  return (theme as Record<string, StyleFn | undefined>)[name]
}

export { sgrAttributes, sgrGroup }

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR sequences
const SGR_SEQUENCE = /\x1b\[([0-9;:]*)m/g

/** Removes colors from SGR sequences, keeping text attributes such as bold and underline. */
export function stripColors(s: string): string {
  if (!s.includes("\x1b[")) return s
  return s.replace(SGR_SEQUENCE, (_, params: string) => {
    const kept = sgrAttributes(params).filter((a) => {
      const g = sgrGroup(a)
      return g !== "fg" && g !== "bg" && g !== "ul"
    })
    return kept.length > 0 ? `\x1b[${kept.join(";")}m` : ""
  })
}
