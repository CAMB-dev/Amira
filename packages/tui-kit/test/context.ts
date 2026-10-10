import type { RenderContext } from "../src/component.ts"
import { markdownTheme, type Theme } from "../src/style.ts"

const same = (s: string) => s

/** A render context whose theme adds no styling, so rendered lines are plain text. */
export const plain: RenderContext = {
  theme: {
    text: same,
    accent: same,
    muted: same,
    error: same,
    success: same,
    warning: same,
    border: same,
    path: same,
    command: same,
    fg2: same,
    dim: same,
    borderFocused: same,
    thinking: same,
    shimmer: same,
    ...Object.fromEntries(Object.keys(markdownTheme).map((k) => [k, same])),
  } satisfies Theme,
  color: false,
  rows: 24,
}
