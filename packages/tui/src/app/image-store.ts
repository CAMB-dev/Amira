import { type chooseImageSupport, ImageStore } from "@amira/tui-kit"
import type { ImageSource } from "../markdown-nodes.ts"

/** Terminal-local images share one store across main/focused transcript presentation. */
export function interactiveImages(
  providers: ImageSource | undefined,
  support: ReturnType<typeof chooseImageSupport>,
  cwd: () => string,
  rows: () => number,
): (() => ImageStore | undefined) | undefined {
  if (!support || !providers) return undefined
  const store = new ImageStore({
    support,
    open: (input, context) => providers.open(input, context),
    cwd,
    maxRows: () => Math.max(1, Math.min(20, Math.floor(rows() * 0.4))),
  })
  return () => (providers.size > 0 ? store : undefined)
}
