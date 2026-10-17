import type { FullScreenRenderer } from "./fullscreen.ts"

/** Retained conversation ownership is internal to the TUI, not a renderer package contract. */
const fullscreen = new WeakMap<FullScreenRenderer, (paused: boolean) => void>()

export function registerFullscreenControl(
  renderer: FullScreenRenderer,
  pause: (paused: boolean) => void,
): void {
  fullscreen.set(renderer, pause)
}

export function pauseFullScreen(renderer: FullScreenRenderer, paused: boolean): void {
  fullscreen.get(renderer)?.(paused)
}
