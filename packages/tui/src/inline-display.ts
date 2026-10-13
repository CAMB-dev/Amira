import type { PrintOptions, ToolDetailLevel } from "@amira/api"
import type { RenderContext, Theme } from "@amira/tui-kit"
import type { BlockEnv } from "./blocks/base.ts"
import { DisplayBlock } from "./blocks/display.ts"
import type { NoticeLevel, Transcript } from "./transcript.ts"
import type { ViewHost } from "./view.ts"

export function displayEnv(
  theme: Theme,
  width: number,
  detail: ToolDetailLevel,
  hyperlinks = false,
): BlockEnv {
  return {
    theme,
    width,
    detail,
    hyperlinks,
    now: Date.now(),
    spinner: "",
    presenters: undefined,
    nodes: new Map(),
  }
}

/** Queue a semantic display block alongside ordinary inline commits. */
export function displayCommit(
  host: ViewHost,
  transcript: Transcript,
  level: NoticeLevel,
  text: string,
  options: PrintOptions = {},
): (width: number, ctx: RenderContext) => string[] {
  const block = new DisplayBlock(level, text, options)
  const gap = transcript.gapBefore("notice")
  // Advance transcript spacing once, not every time the saved block is repainted.
  transcript.block("notice", [])
  return (width, ctx) => {
    const lines = block.lines(displayEnv(ctx.theme, width, host.detail(), host.hyperlinks))
    return [...(gap ? [""] : []), ...lines]
  }
}
