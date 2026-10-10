import type { Capabilities } from "./capabilities.ts"

export type ColorDepth = "truecolor" | "256" | "16"
export type ColorDepthSetting = "auto" | ColorDepth
export type Hex = `#${string}`

/** Explicit environment hints win; a modern keyboard/graphics probe is a fallback hint. */
export function detectColorDepth(
  env: Record<string, string | undefined>,
  capabilities: Partial<Capabilities> = {},
): ColorDepth {
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) return "truecolor"
  if (env.WT_SESSION) return "truecolor"
  if (["iTerm.app", "WezTerm", "vscode", "ghostty"].includes(env.TERM_PROGRAM ?? "")) {
    return "truecolor"
  }
  const term = env.TERM ?? ""
  if (/direct/.test(term)) return "truecolor"
  if (/256color/.test(term)) return "256"
  if (capabilities.kittyKeyboard || capabilities.win32InputMode || capabilities.graphics?.kitty) {
    return "truecolor"
  }
  return "16"
}

export function channels(hex: Hex): [number, number, number] {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

export function blend(a: Hex, b: Hex, amount: number): Hex {
  const end = channels(b)
  return `#${channels(a)
    .map((v, i) =>
      Math.round(v + (end[i]! - v) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
}

/** OKLab distance avoids RGB's preference for overly bright, saturated cube colours. */
function lab(hex: Hex): [number, number, number] {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function cubeHex(index: number): Hex {
  const n = index - 16
  const steps = [0, 95, 135, 175, 215, 255]
  const values =
    index >= 232
      ? [8 + (index - 232) * 10].flatMap((v) => [v, v, v])
      : [steps[Math.floor(n / 36)]!, steps[Math.floor(n / 6) % 6]!, steps[n % 6]!]
  return `#${values.map((v) => v.toString(16).padStart(2, "0")).join("")}`
}

// Never select 0–15: their RGB values are user-defined, unlike the cube and grey ramp.
const xterm = Array.from({ length: 240 }, (_, i) => lab(cubeHex(i + 16)))
export interface ColorHint {
  dominant: "red" | "green"
  /** Word backgrounds must retain more chroma than their line background. */
  strongerThan?: number
}
const cubeChannels = Array.from({ length: 216 }, (_, i) => channels(cubeHex(i + 16)))
const chroma = (color: readonly number[]) => color[1]! ** 2 + color[2]! ** 2
const nearestCache = new Map<string, number>()
export function nearest256(hex: Hex, hint?: ColorHint): number {
  const key = `${hex}:${hint?.dominant ?? "any"}:${hint?.strongerThan ?? ""}`
  const cached = nearestCache.get(key)
  if (cached !== undefined) return cached
  const target = lab(hex)
  let best = 16
  let distance = Infinity
  for (let i = 0; i < xterm.length; i++) {
    if (hint) {
      const rgb = cubeChannels[i]
      const dominant = hint.dominant === "red" ? 0 : 1
      if (!rgb || rgb.some((v, channel) => channel !== dominant && v >= rgb[dominant]!)) continue
      if (hint.strongerThan !== undefined && chroma(xterm[i]!) <= chroma(xterm[hint.strongerThan - 16]!))
        continue
    }
    const d = xterm[i]!.reduce((sum, v, j) => sum + (v - target[j]!) ** 2, 0)
    if (d < distance) {
      distance = d
      best = i + 16
    }
  }
  if (distance === Infinity && hint) best = nearest256(hex, { dominant: hint.dominant })
  nearestCache.set(key, best)
  return best
}

/** SGR parameters only; the caller supplies the semantic ANSI fallback at depth 16. */
export function quantize(
  hex: Hex,
  depth: ColorDepth,
  fallback: number,
  background = false,
  hint?: ColorHint,
): string {
  const prefix = background ? 48 : 38
  if (depth === "16") return String(fallback)
  if (depth === "256") return `${prefix};5;${nearest256(hex, hint)}`
  return `${prefix};2;${channels(hex).join(";")}`
}
