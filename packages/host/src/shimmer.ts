import type { ShimmerColors, ShimmerEffect, ShimmerOptions, ShimmerPreset, ThemeHex } from "@amira/api"

type ShimmerKnobs = Required<Omit<ShimmerOptions, "preset" | "colors">>

/** Presets never supply colors: every style inherits the theme's gradient stops. */
export const SHIMMER_PRESETS: Readonly<Record<ShimmerPreset, ShimmerKnobs>> = Object.freeze({
  off: Object.freeze({ style: "off", width: 6, period: 1800, edge: "soft", direction: "ltr" }),
  soft: Object.freeze({ style: "sweep", width: 6, period: 1800, edge: "soft", direction: "ltr" }),
  sharp: Object.freeze({ style: "sweep", width: 3, period: 1100, edge: "hard", direction: "ltr" }),
  wide: Object.freeze({ style: "sweep", width: 12, period: 2600, edge: "soft", direction: "ltr" }),
  bounce: Object.freeze({ style: "bounce", width: 6, period: 2400, edge: "soft", direction: "ltr" }),
  pulse: Object.freeze({ style: "pulse", width: 6, period: 2000, edge: "soft", direction: "ltr" }),
  wave: Object.freeze({ style: "wave", width: 6, period: 2200, edge: "soft", direction: "ltr" }),
  reveal: Object.freeze({ style: "reveal", width: 6, period: 2000, edge: "soft", direction: "ltr" }),
})

const FIELDS = new Set(["preset", "style", "width", "period", "edge", "direction", "colors"])
const STYLES = new Set(["off", "sweep", "bounce", "pulse", "wave", "reveal"])

/** Keep valid fields, clamp finite numeric knobs, and report at most one notice per block. */
export function normalizeShimmer(
  value: unknown,
  notice?: (text: string) => void,
): ShimmerOptions | undefined {
  if (value === undefined) return undefined
  const issues: string[] = []
  const result: ShimmerOptions = {}
  let empty = false
  try {
    if (typeof value === "string") {
      if (isPreset(value)) result.preset = value
      else issues.push("unknown preset")
    } else if (isRecord(value)) {
      const keys = Object.keys(value)
      empty = keys.length === 0
      for (const key of keys) {
        if (!FIELDS.has(key)) {
          issues.push(`unknown field "${key}"`)
          continue
        }
        try {
          const field = value[key]
          switch (key) {
            case "preset":
              if (field === "sweep") result.preset = "soft"
              else if (isPreset(field)) result.preset = field
              else issues.push("invalid preset")
              break
            case "style":
              if (typeof field === "string" && STYLES.has(field))
                result.style = field as ShimmerOptions["style"]
              else issues.push("invalid style")
              break
            case "width":
            case "period": {
              if (typeof field !== "number" || !Number.isFinite(field)) {
                issues.push(`${key} must be a finite number`)
                break
              }
              const normalized =
                key === "width"
                  ? Math.min(20, Math.max(1, Math.round(field)))
                  : Math.min(5000, Math.max(400, field))
              result[key] = normalized
              if (normalized !== field) issues.push(`${key} clamped${key === "width" ? " or rounded" : ""}`)
              break
            }
            case "edge":
              if (field === "soft" || field === "linear" || field === "hard") result.edge = field
              else issues.push("invalid edge")
              break
            case "direction":
              if (field === "ltr" || field === "rtl") result.direction = field
              else issues.push("invalid direction")
              break
            case "colors": {
              const colors = normalizeColors(field, issues)
              if (colors) result.colors = colors
              else issues.push("colors must be two hex colors or dark/light pairs (#RGB or #RRGGBB)")
              break
            }
          }
        } catch {
          issues.push(`unreadable field "${key}"`)
        }
      }
    } else {
      issues.push("expected a preset name or an options object")
    }
  } catch {
    issues.push("unreadable options object")
  }
  if (issues.length) {
    try {
      notice?.(
        `Invalid shimmer configuration: ${issues.join("; ")}. Invalid fields are ignored; numeric values are clamped.`,
      )
    } catch {
      // Reporting must not turn an invalid setting or theme into a startup failure.
    }
  }
  return empty || Object.keys(result).length ? result : undefined
}

/** Expand each preset before its explicit knobs, then layer user overrides over the theme. */
export function resolveShimmer(
  theme?: ShimmerEffect,
  user?: ShimmerEffect,
): ShimmerKnobs & { colors?: ShimmerColors } {
  return { ...SHIMMER_PRESETS.soft, ...expand(theme), ...expand(user) }
}

function expand(value: ShimmerEffect | undefined): Partial<ShimmerKnobs> & { colors?: ShimmerColors } {
  const normalized = normalizeShimmer(value)
  if (!normalized) return {}
  const { preset, ...knobs } = normalized
  return { ...(preset ? SHIMMER_PRESETS[preset === "sweep" ? "soft" : preset] : {}), ...knobs }
}

function isPreset(value: unknown): value is ShimmerPreset {
  return typeof value === "string" && Object.hasOwn(SHIMMER_PRESETS, value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function normalizeColors(value: unknown, issues: string[]): ShimmerColors | undefined {
  if (Array.isArray(value)) return normalizePair(value)
  if (!isRecord(value)) return undefined
  const dark = normalizePair(value.dark)
  const light = normalizePair(value.light)
  if (!dark || !light) return undefined
  for (const key of Object.keys(value)) {
    if (key !== "dark" && key !== "light") issues.push(`unknown colors field "${key}"`)
  }
  return Object.freeze({ dark, light })
}

function normalizePair(value: unknown): readonly [ThemeHex, ThemeHex] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined
  const first = normalizeHex(value[0])
  const second = normalizeHex(value[1])
  return first && second ? Object.freeze([first, second] as const) : undefined
}

function normalizeHex(value: unknown): ThemeHex | undefined {
  if (typeof value !== "string" || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) return undefined
  const hex = value.toLowerCase()
  return (hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex) as ThemeHex
}
