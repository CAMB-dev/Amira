import type { MouseInput } from "./keys.ts"

/** Shared timing for repeated clicks in controls and transcript selection. */
export const MULTI_CLICK_MS = 400

/** A rectangle in zero-based terminal cells, relative to the component's origin. */
export interface HitRect {
  x: number
  y: number
  width: number
  height: number
}

/** A completed left click; coordinates are relative to the activated rectangle. */
export interface HitActivation {
  id: string
  x: number
  y: number
  double: boolean
}

/** Translate a screen report into a rendered component's coordinate space. */
export function translateMouse(event: MouseInput, x: number, y: number): MouseInput {
  return { ...event, x: event.x - x, y: event.y - y }
}

/** Rendered hit regions. Later regions win, so a control can refine a larger focus target. */
export class HitRegions {
  private regions: { id: string; rect: HitRect }[] = []
  private pressed: string | undefined
  private last: { id: string; at: number } | undefined

  /** Rebuild regions each frame without losing an in-progress press. */
  clear(): void {
    this.regions.length = 0
  }

  reset(): void {
    this.clear()
    this.pressed = undefined
    this.last = undefined
  }

  add(id: string, rect: HitRect): void {
    if (rect.width > 0 && rect.height > 0) this.regions.push({ id, rect: { ...rect } })
  }

  handle(event: MouseInput): HitActivation | undefined {
    if (event.button !== "left") return
    if (event.action !== "press" && event.action !== "release") return
    const hit = this.regions.findLast(
      ({ rect }) =>
        event.x >= rect.x &&
        event.x < rect.x + rect.width &&
        event.y >= rect.y &&
        event.y < rect.y + rect.height,
    )
    if (event.action === "press") {
      this.pressed = hit?.id
      return
    }
    const pressed = this.pressed
    this.pressed = undefined
    if (!hit || hit.id !== pressed) {
      this.last = undefined
      return
    }
    const now = Date.now()
    const double = this.last?.id === hit.id && now - this.last.at <= MULTI_CLICK_MS
    this.last = double ? undefined : { id: hit.id, at: now }
    return { id: hit.id, x: event.x - hit.rect.x, y: event.y - hit.rect.y, double }
  }
}
