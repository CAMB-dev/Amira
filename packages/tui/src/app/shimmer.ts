import { resolveShimmer } from "@amira/core"
import { graphemes, type RenderContext, type Theme, themeToken, visibleWidth } from "@amira/tui-kit"

type ResolvedShimmer = ReturnType<typeof resolveShimmer>
const effects = new WeakMap<Theme, ResolvedShimmer>()
const soft = resolveShimmer()

/** Configuration belongs to a built theme, just like its precomputed colour tokens. */
export function configureShimmer(theme: Theme, effect: ResolvedShimmer): void {
  effects.set(theme, effect)
}

function falloff(distance: number, half: number, edge: ResolvedShimmer["edge"]): number {
  if (distance >= half) return 0
  const x = distance / half
  return edge === "hard" ? 1 : edge === "linear" ? 1 - x : Math.cos((x * Math.PI) / 2) ** 2
}

export function hasAnimatedShimmer(ctx: RenderContext): boolean {
  return (
    (effects.get(ctx.theme) ?? soft).style !== "off" && ctx.color && !!themeToken(ctx.theme, "shimmer0Fade8")
  )
}

/** Sample the prototype's motion in terminal cells, using only prequantized theme styles. */
export function paintShimmer(label: string, ctx: RenderContext, animationMs: number): string {
  const effect = effects.get(ctx.theme) ?? soft
  if (effect.style === "off" || !ctx.color || !themeToken(ctx.theme, "shimmer0Fade8"))
    return ctx.theme.muted(label)
  const fades = themeToken(ctx.theme, "shimmer0Fade32") ? 32 : 8
  const cells = visibleWidth(label)
  const phase = (animationMs % effect.period) / effect.period
  const half = effect.width / 2
  let cell = 0
  return graphemes(label)
    .map((char) => {
      const i = effect.direction === "rtl" ? cells - 1 - cell : cell
      let intensity = 0
      let stop = i / Math.max(1, cells - 1)
      if (effect.style === "sweep") {
        intensity = falloff(Math.abs(i - (phase * (cells + effect.width) - half)), half, effect.edge)
      } else if (effect.style === "bounce") {
        const p = phase < 0.5 ? phase * 2 : 2 - phase * 2
        intensity = falloff(Math.abs(i - (p * (cells - 1 + effect.width) - half)), half, effect.edge)
      } else if (effect.style === "pulse") {
        intensity = (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI)) * (effect.edge === "hard" ? 1 : 0.9)
      } else if (effect.style === "wave") {
        intensity = 0.85
        stop = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i / Math.max(4, effect.width * 2) - phase))
      } else if (effect.style === "reveal") {
        const lit = phase * (cells + 4)
        intensity =
          i < lit
            ? Math.min(1, (lit - i) / (effect.edge === "hard" ? 1 : 3)) *
              (lit > cells + 2 ? Math.max(0, (cells + 4 - lit) / 2) : 1)
            : 0
      }
      if (effect.edge === "hard" && effect.style !== "pulse") intensity = intensity > 0 ? 1 : 0
      const fade = Math.round(intensity * fades)
      const index = Math.round(stop * 15)
      cell += visibleWidth(char)
      const style = fade ? themeToken(ctx.theme, `shimmer${index}Fade${fade}`) : undefined
      return (style ?? ctx.theme.muted)(char)
    })
    .join("")
}
