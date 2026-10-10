import {
  DEFAULT_THEME_GLYPHS,
  THEME_PALETTE_TOKENS,
  type ThemeDefinition,
  type ThemeGlyphs,
  type ThemeHex,
  type ThemePalette,
  type ThemeSource,
  textCells,
} from "@amira/api"

export interface ThemeFileEntry {
  theme: ThemeDefinition
  source: Exclude<ThemeSource, "extension">
  origin?: string
}

interface Entry {
  theme: ThemeDefinition
  source: ThemeSource
  origin?: string
}

type Notice = (text: string, origin?: string) => void

const PALETTE_TOKENS = new Set<string>(THEME_PALETTE_TOKENS)
const SOURCES = new Set<string>(["built-in", "user", "project", "package", "extension"])
const THEME_KEYS = new Set(["name", "description", "dark", "light", "glyphs"])
// tui.theme keywords; a theme with one of these names could never be selected.
const RESERVED_NAMES = new Set(["auto", "dark", "light", "terminal"])
// biome-ignore lint/suspicious/noControlCharactersInRegex: glyphs must never contain terminal controls
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u

/**
 * Named theme layers. Later registrations win; removing one restores the previous definition.
 * Validation is frontend-independent and reports notices instead of breaking startup or reload.
 */
export class ThemeRegistry {
  #entries: Entry[] = []
  #listeners = new Set<() => void>()
  #notice: Notice

  constructor(notice: Notice = () => {}) {
    this.#notice = notice
  }

  get(name: string): ThemeDefinition | undefined {
    return this.#entries.findLast((entry) => entry.theme.name === name)?.theme
  }

  /** Provenance of the winning definition, for theme pickers. */
  source(name: string): ThemeSource | undefined {
    return this.#entries.findLast((entry) => entry.theme.name === name)?.source
  }

  /** One winning definition per name, in registration order. Missing fields still inherit defaults. */
  list(): ThemeDefinition[] {
    const themes = new Map<string, ThemeDefinition>()
    for (const entry of this.#entries) themes.set(entry.theme.name, entry.theme)
    return [...themes.values()]
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  register(theme: ThemeDefinition, source: ThemeSource, origin?: string): () => void {
    const entry = this.#validate(theme, source, origin)
    if (!entry) return () => {}
    this.#warnClash(entry, this.#entries)
    this.#entries.push(entry)
    this.#changed()
    return () => {
      const at = this.#entries.indexOf(entry)
      if (at < 0) return
      this.#entries.splice(at, 1)
      this.#changed()
    }
  }

  /**
   * Atomically replaces all non-extension layers (including built-ins). Callers supply the full
   * file snapshot in precedence order. Existing extension layers stay above the new files.
   * Invalid entries are skipped, and subscribers see only the completed replacement.
   */
  replaceFiles(entries: readonly ThemeFileEntry[]): void {
    const files: Entry[] = []
    for (const candidate of entries) {
      const entry = this.#validate(candidate.theme, candidate.source, candidate.origin)
      if (!entry) continue
      if (entry.source === "extension") {
        this.#warn("Theme file layers cannot use the extension source; skipped", entry.origin)
        continue
      }
      this.#warnClash(entry, files)
      files.push(entry)
    }
    const extensions = this.#entries.filter((entry) => entry.source === "extension")
    const next = [...files]
    for (const entry of extensions) {
      this.#warnClash(entry, next)
      next.push(entry)
    }
    this.#entries = next
    this.#changed()
  }

  #validate(raw: unknown, source: ThemeSource, origin?: string): Entry | undefined {
    try {
      if (!SOURCES.has(source)) throw new Error("unknown source")
      if (!isRecord(raw)) throw new Error("definition must be an object")
      const name = raw.name
      if (typeof name !== "string" || !name.trim() || name !== name.trim() || CONTROLS.test(name))
        throw new Error("name must be a non-empty string without surrounding whitespace or controls")
      if (RESERVED_NAMES.has(name)) throw new Error(`name "${name}" is reserved for the tui.theme setting`)
      const label = `Theme "${name}"`
      const warn = (text: string) => this.#warn(`${label}: ${text}`, origin)
      for (const key of Object.keys(raw)) {
        if (!THEME_KEYS.has(key)) warn(`unknown field "${key}"; ignored`)
      }
      if (raw.description !== undefined && typeof raw.description !== "string")
        throw new Error("description must be a string")
      const theme: ThemeDefinition = { name }
      if (raw.description !== undefined) theme.description = raw.description as string
      for (const appearance of ["dark", "light"] as const) {
        if (raw[appearance] === undefined) continue
        if (!isRecord(raw[appearance])) throw new Error(`${appearance} must be a palette object`)
        const palette: Partial<ThemePalette> = {}
        for (const [key, value] of Object.entries(raw[appearance])) {
          if (!PALETTE_TOKENS.has(key)) {
            warn(`unknown ${appearance} token "${key}"; ignored`)
            continue
          }
          if (typeof value !== "string" || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value))
            throw new Error(`${appearance}.${key} must be a #RGB or #RRGGBB hex color`)
          const hex = value.toLowerCase()
          palette[key as keyof ThemePalette] = (
            hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex
          ) as ThemeHex
        }
        theme[appearance] = Object.freeze(palette)
      }
      if (raw.glyphs !== undefined) {
        if (!isRecord(raw.glyphs)) throw new Error("glyphs must be an object")
        const glyphs: Partial<ThemeGlyphs> = {}
        for (const [key, value] of Object.entries(raw.glyphs)) {
          if (!Object.hasOwn(DEFAULT_THEME_GLYPHS, key)) {
            warn(`unknown glyph "${key}"; ignored`)
            continue
          }
          const glyphKey = key as keyof ThemeGlyphs
          if (glyphKey === "bullets") {
            if (!Array.isArray(value) || !value.length) {
              warn("glyph bullets must be a non-empty string array; ignored")
              continue
            }
            const bullets = [...value]
            const defaults = DEFAULT_THEME_GLYPHS.bullets
            if (
              !bullets.every((glyph, index) =>
                validGlyph(glyph, defaults[Math.min(index, defaults.length - 1)]!, `bullets[${index}]`, warn),
              )
            )
              continue
            glyphs.bullets = bullets as string[]
            Object.freeze(glyphs.bullets)
          } else if (validGlyph(value, DEFAULT_THEME_GLYPHS[glyphKey], glyphKey, warn)) {
            glyphs[glyphKey] = value as string
          }
        }
        theme.glyphs = Object.freeze(glyphs)
      }
      return { theme: Object.freeze(theme), source, ...(origin !== undefined ? { origin } : {}) }
    } catch (error) {
      this.#warn(`Theme skipped: ${error instanceof Error ? error.message : String(error)}`, origin)
      return undefined
    }
  }

  #warnClash(entry: Entry, entries: Entry[]): void {
    const previous = entries.findLast((other) => other.theme.name === entry.theme.name)
    if (!previous) return
    this.#warn(
      `Theme "${entry.theme.name}" from ${entry.origin ?? entry.source} replaces the registration from ${previous.origin ?? previous.source}`,
      entry.origin,
    )
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch {
        this.#warn("Theme subscriber failed")
      }
    }
  }

  #warn(text: string, origin?: string): void {
    try {
      this.#notice(text, origin)
    } catch {
      // A reporting sink must not turn an invalid theme into a failed extension load.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validGlyph(value: unknown, fallback: string, key: string, warn: (text: string) => void): boolean {
  if (typeof value !== "string" || CONTROLS.test(value)) {
    warn(`glyph ${key} must be plain single-line text without controls; ignored`)
    return false
  }
  const width = textCells(value)
  const expected = textCells(fallback)
  // Warning layouts already measure their prefix instead of assuming the default two cells.
  if (width !== expected && (key !== "warning" || width === 0)) {
    warn(
      `glyph ${key} measures ${width} cells with @amira/text-width; the default measures ${expected}. Terminal/font widths may differ; ignored`,
    )
    return false
  }
  return true
}
