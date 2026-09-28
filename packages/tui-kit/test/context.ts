import type { RenderContext } from "../src/component.ts"
import type { Theme } from "../src/style.ts"

const same = (s: string) => s

/** A render context whose theme adds no styling, so rendered lines are plain text. */
export const plain: RenderContext = {
  theme: { text: same, accent: same, muted: same, error: same, success: same, warning: same } satisfies Theme,
  color: false,
}
