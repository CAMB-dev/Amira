import { expect, test } from "bun:test"
import type { ShimmerPreset } from "@amira/api"
import { resolveShimmer, SHIMMER_PRESETS } from "@amira/core"
import { createTheme, themeToken } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { configureShimmer, paintShimmer } from "../src/app/shimmer.ts"

// Independent transcription of shimmer-proto.ts paint(): quantization happens only at the end.
function prototype(n: number, e: ReturnType<typeof resolveShimmer>, t: number) {
  const phase = (t % e.period) / e.period
  const half = e.width / 2
  const edge = (d: number) =>
    d >= half
      ? 0
      : e.edge === "hard"
        ? 1
        : e.edge === "linear"
          ? 1 - d / half
          : Math.cos(((d / half) * Math.PI) / 2) ** 2
  return Array.from({ length: n }, (_, i0) => {
    const i = e.direction === "rtl" ? n - 1 - i0 : i0
    let k = 0
    let stop = i / Math.max(1, n - 1)
    if (e.style === "sweep") k = edge(Math.abs(i - (phase * (n + e.width) - half)))
    else if (e.style === "bounce") {
      const p = phase < 0.5 ? phase * 2 : 2 - phase * 2
      k = edge(Math.abs(i - (p * (n - 1 + e.width) - half)))
    } else if (e.style === "pulse")
      k = (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI)) * (e.edge === "hard" ? 1 : 0.9)
    else if (e.style === "wave") {
      k = 0.85
      stop = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i / Math.max(4, e.width * 2) - phase))
    } else if (e.style === "reveal") {
      const lit = phase * (n + 4)
      k =
        i < lit
          ? Math.min(1, (lit - i) / (e.edge === "hard" ? 1 : 3)) *
            (lit > n + 2 ? Math.max(0, (n + 4 - lit) / 2) : 1)
          : 0
    }
    if (e.edge === "hard" && e.style !== "pulse") k = k > 0 ? 1 : 0
    return { k, stop }
  })
}

for (const preset of Object.keys(SHIMMER_PRESETS) as ShimmerPreset[]) {
  test(`${preset}: prototype sampling parity, every edge/direction, truecolor and fallback`, () => {
    for (const depth of ["truecolor", "256"] as const) {
      const theme = createTheme({ env: {}, colorDepth: depth })
      const fades = depth === "truecolor" ? 32 : 8
      for (const edge of ["soft", "hard", "linear"] as const) {
        for (const direction of ["ltr", "rtl"] as const) {
          const effect = resolveShimmer(undefined, { preset, edge, direction })
          configureShimmer(theme, effect)
          for (const t of [0, 33, 700, 1400, effect.period - 1]) {
            const label = "Responding…"
            const expected = [...label]
              .map((ch, i) => {
                const { k, stop } = prototype(label.length, effect, t)[i]!
                const fade = Math.round(k * fades)
                return (
                  fade ? themeToken(theme, `shimmer${Math.round(stop * 15)}Fade${fade}`)! : theme.muted
                )(ch)
              })
              .join("")
            expect(paintShimmer(label, { ...plain, color: true, theme }, t)).toBe(
              effect.style === "off" ? theme.muted(label) : expected,
            )
          }
        }
      }
    }
  })
}

test("truecolor soft edges move in small RGB steps across adjacent 33 ms frames", () => {
  const theme = createTheme({ env: {}, colorDepth: "truecolor" })
  const ctx = { ...plain, color: true, theme }
  const rgb = (time: number) =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: inspect actual ANSI truecolor values
    [...paintShimmer("Responding…", ctx, time).matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((m) =>
      m.slice(1).map(Number),
    )
  const a = rgb(700)
  const b = rgb(733)
  const deltas = a.flatMap((channels, i) => channels.map((value, c) => Math.abs(value - b[i]![c]!)))
  // The outer soft edge changes by 2/3/4 RGB levels, not the old 1/8-fade jump.
  // Interior cells legitimately travel farther at the prototype's original speed (max 21).
  expect(deltas).toEqual([
    0, 0, 0, 2, 3, 4, 12, 17, 21, 10, 14, 17, 2, 4, 4, 13, 18, 20, 10, 15, 17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0,
  ])
})
