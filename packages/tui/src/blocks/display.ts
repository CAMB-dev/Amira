import type { PrintOptions } from "@amira/api"
import { renderMarkdown, wrapText } from "@amira/tui-kit"
import { type NoticeLevel, noticeLines } from "../transcript.ts"
import { Block, type BlockEnv } from "./base.ts"

/** A transcript block that has no corresponding model message. */
export class DisplayBlock extends Block {
  readonly kind = "notice" as const
  #open: boolean | undefined

  constructor(
    readonly level: NoticeLevel,
    readonly text: string,
    readonly options: PrintOptions = {},
  ) {
    super()
  }

  lines(env: BlockEnv): string[] {
    const head = noticeLines(env.theme, this.level, this.text, env.width)
    if (!this.options.details || this.isFolded(env)) return head
    const width = Math.max(1, env.width - 4)
    const rows = this.options.markdown
      ? renderMarkdown(this.options.details, width, env.theme, { hyperlinks: env.hyperlinks })
      : wrapText(this.options.details, width)
    return [...head, ...rows.map((row) => `    ${row}`)]
  }

  copyText(): string {
    return this.options.details ? `${this.text}\n${this.options.details}` : this.text
  }

  override foldable(): boolean {
    return Boolean(this.options.details)
  }

  override isFolded(env: BlockEnv): boolean {
    return !(this.#open ?? env.detail === "full")
  }

  override toggleFold(env: BlockEnv): void {
    this.#open = this.isFolded(env)
    this.touch()
  }

  override get refolded(): boolean {
    return this.#open !== undefined
  }
}
