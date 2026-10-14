import type { FullScreenRenderer } from "./fullscreen.ts"
import type { LiveRenderer } from "./renderer.ts"

/** Retained conversation ownership is internal to the TUI, not a renderer package contract. */
const fullscreen = new WeakMap<FullScreenRenderer, (paused: boolean) => void>()
const live = new WeakMap<LiveRenderer, { discard(): void; boundary(rows: string[]): void }>()

export function registerFullscreenControl(
  renderer: FullScreenRenderer,
  pause: (paused: boolean) => void,
): void {
  fullscreen.set(renderer, pause)
}

export function registerLiveControl(
  renderer: LiveRenderer,
  control: { discard(): void; boundary(rows: string[]): void },
): void {
  live.set(renderer, control)
}

export function pauseFullScreen(renderer: FullScreenRenderer, paused: boolean): void {
  fullscreen.get(renderer)?.(paused)
}

export function discardLive(renderer: LiveRenderer): void {
  live.get(renderer)?.discard()
}

/** Stages chrome before renderer-held commits and the next root frame, without writing. */
export function prependLiveBoundary(renderer: LiveRenderer, rows: string[]): void {
  live.get(renderer)?.boundary(rows)
}
