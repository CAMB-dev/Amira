// A visible shimmer gets its own cadence; spinner glyphs remain on their 80 ms clock.
import type { RenderContext, Terminal } from "@amira/tui-kit"
import type { TurnActivity } from "./activity.ts"
import type { OverlayManager } from "./overlays.ts"
import { hasAnimatedShimmer } from "./shimmer.ts"
import type { RuntimeThemes } from "./themes.ts"

type ClockTimer = ReturnType<typeof setInterval> | number

export function createActivityShimmer(
  terminal: Terminal,
  activity: TurnActivity | (() => TurnActivity),
  themes: RuntimeThemes,
  overlays: OverlayManager,
  requestRender: () => void,
) {
  return createShimmerClock({
    terminal,
    active: () => {
      const current = typeof activity === "function" ? activity() : activity
      return current.shimmerVisible && (current.working || current.compacting || themes.previewing)
    },
    covered: () => overlays.hasFullscreen,
    requestRender,
  })
}

export function createShimmerClock(deps: {
  terminal: Pick<Terminal, "suspend">
  active: () => boolean
  covered: () => boolean
  requestRender: () => void
  schedule?: (tick: () => void, ms: number) => ClockTimer
  cancel?: (timer: ClockTimer) => void
}) {
  let timer: ClockTimer | undefined
  let context: RenderContext | undefined
  let visible = false
  let focused = true // Unknown focus is visible until a reporting terminal says otherwise.
  let suspended = false
  let disposed = false
  const schedule = deps.schedule ?? ((tick: () => void, ms: number) => setInterval(tick, ms))
  const cancel = deps.cancel ?? clearInterval
  const eligible = () =>
    !disposed &&
    !suspended &&
    focused &&
    visible &&
    context !== undefined &&
    deps.active() &&
    !deps.covered() &&
    hasAnimatedShimmer(context)
  function sync() {
    if (!eligible()) {
      if (timer !== undefined) cancel(timer)
      timer = undefined
    } else if (timer === undefined) {
      timer = schedule(() => {
        sync()
        if (eligible()) deps.requestRender()
      }, 33)
    }
  }
  const suspend = deps.terminal.suspend
  const boundSuspend = () => {
    suspended = true
    sync()
    const resume = suspend?.call(deps.terminal)
    return () => {
      resume?.()
      suspended = false
      sync()
    }
  }
  if (suspend) deps.terminal.suspend = boundSuspend
  return {
    sync,
    visibility(shown: boolean, ctx: RenderContext) {
      visible = shown
      context = ctx
      sync()
    },
    focus(on: boolean) {
      focused = on
      sync()
    },
    dispose() {
      disposed = true
      sync()
      if (deps.terminal.suspend === boundSuspend) deps.terminal.suspend = suspend
    },
  }
}
