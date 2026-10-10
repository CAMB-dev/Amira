import type { Background, Rgb } from "./capabilities.ts"
import { blend, channels, type Hex } from "./colors.ts"

/** RGB source of truth. bg/fg are references for surfaces, never the base terminal colours. */
export const palettes = {
  dark: {
    bg: "#121212",
    fg: "#e4e4e4",
    accent: "#78dbe2",
    heading1: "#6fb3e8",
    heading: "#78dbe2",
    path: "#9ab8f0",
    command: "#a8e6ea",
    fg2: "#bdbdbd",
    muted: "#727272",
    dim: "#4a4a4a",
    border: "#333333",
    borderFocused: "#565656",
    success: "#8fc46a",
    error: "#e5737a",
    warning: "#e2b356",
    thinking: "#a8927a",
    shimmer: "#bcdcf6",
    shimmerEnd: "#c6f1f4",
    userBg: "#202020",
    codeBg: "#191919",
    diffAddedBg: "#0f3a12",
    diffRemovedBg: "#47141a",
    diffAddedWordBg: "#17551c",
    diffRemovedWordBg: "#66212a",
    keyword: "#6fb3e8",
    string: "#8dd8bd",
    number: "#b5b4ee",
  },
  light: {
    bg: "#f6f5f2",
    fg: "#222222",
    accent: "#157c84",
    heading1: "#1f6aa8",
    heading: "#126f76",
    path: "#3f5fb0",
    command: "#1a6a70",
    fg2: "#444444",
    muted: "#8a8a8a",
    dim: "#bdbab4",
    border: "#d2cfc8",
    borderFocused: "#9d9a93",
    success: "#3f8a2a",
    error: "#c23b47",
    warning: "#a87412",
    thinking: "#8d7a63",
    shimmer: "#123f6a",
    shimmerEnd: "#0b4f55",
    userBg: "#e8e6e1",
    codeBg: "#efede9",
    diffAddedBg: "#d6f0cf",
    diffRemovedBg: "#f6d5d8",
    diffAddedWordBg: "#bce5b1",
    diffRemovedWordBg: "#edb5bd",
    keyword: "#1f6aa8",
    string: "#23765d",
    number: "#6356a6",
  },
} satisfies Record<Background, Record<string, Hex>>

export type Palette = Record<keyof typeof palettes.dark, Hex>
export type SurfaceName =
  | "userBg"
  | "codeBg"
  | "diffAddedBg"
  | "diffRemovedBg"
  | "diffAddedWordBg"
  | "diffRemovedWordBg"
const surfaceNames: SurfaceName[] = [
  "userBg",
  "codeBg",
  "diffAddedBg",
  "diffRemovedBg",
  "diffAddedWordBg",
  "diffRemovedWordBg",
]

export type ConsoleHost = "windows-terminal" | "conhost" | "other"
export function consoleHost(env: Record<string, string | undefined>): ConsoleHost {
  if (env.TERM_PROGRAM || env.TMUX || env.STY || env.WSL_DISTRO_NAME) return "other"
  if (env.WT_SESSION) return "windows-terminal"
  return env.TERM && env.TERM !== "dumb" ? "other" : "conhost"
}

/** Small extra separation for Windows console renderers, without changing foregrounds. */
export function boostSurface(surface: Hex, base: Hex, fg: Hex, platform: string, host: ConsoleHost): Hex {
  if (platform !== "win32" || host === "other") return surface
  const separation = Math.max(...channels(surface).map((v, i) => Math.abs(v - channels(base)[i]!)))
  return blend(surface, fg, separation < 24 ? 0.035 : 0.015)
}

export function surfacePalette(
  palette: Palette,
  detected: Rgb | undefined,
  platform: string,
  host: ConsoleHost,
): Record<SurfaceName, Hex> {
  const base: Hex = detected
    ? `#${[detected.r, detected.g, detected.b]
        .map((v) =>
          Math.round(v * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`
    : palette.bg
  // A 32-channel gap covers near-black/near-white themes, but not mid-grey or coloured ones.
  const unusual = channels(base).some((v, i) => Math.abs(v - channels(palette.bg)[i]!) > 32)
  const out = {} as Record<SurfaceName, Hex>
  for (const name of surfaceNames) {
    let value = palette[name]
    if (unusual) {
      const word = name.includes("Word")
      const amount = name === "userBg" ? 0.1 : name === "codeBg" ? 0.06 : word ? 0.24 : 0.14
      value = blend(base, palette.fg, amount)
      if (name.startsWith("diff")) {
        value = blend(value, name.includes("Added") ? palette.success : palette.error, word ? 0.25 : 0.15)
      }
    }
    out[name] = boostSurface(value, base, palette.fg, platform, host)
  }
  return out
}
