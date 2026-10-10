import type { CompactionInfo } from "@amira/api"
import { reasoningLines } from "../format.ts"
import { summaryLines } from "../history.ts"
import type { CopyRow } from "../text-selection.ts"
import { Block, type BlockEnv } from "./base.ts"

/**
 * What the model thought before it answered: one folded line, "∴ Thought for 12s", that
 * unfolds to the text (and shows it at the "full" level). While the thinking streams in it
 * reads "∴ Thinking".
 */
export class ReasoningBlock extends Block {
  readonly kind = "reasoning"
  /** Set by folding it: whether its text shows, whatever the level. */
  expanded: boolean | undefined
  #thinking: boolean
  #textVersion = 0

  constructor(
    public text: string,
    /** How long it thought; unknown for a resumed session. */
    public durationMs: number | undefined,
    readonly startedAt: number | undefined = undefined,
    thinking = false,
  ) {
    super()
    this.#thinking = thinking
  }

  get thinking(): boolean {
    return this.#thinking
  }

  append(text: string): void {
    if (!text) return
    const expandable = this.foldable()
    this.text += text
    this.#textVersion++
    // The disclosure hint is visible even collapsed; the streamed body is not.
    if (this.foldable() !== expandable) this.touch()
  }

  /** The thinking is over, at `at`. */
  finish(at = Date.now()): void {
    if (!this.#thinking) return
    this.#thinking = false
    this.durationMs = this.startedAt === undefined ? undefined : at - this.startedAt
    this.touch()
  }

  private shows(env: BlockEnv): boolean {
    return this.expanded ?? env.detail === "full"
  }

  override cacheVersion(env: BlockEnv): number | string {
    return this.shows(env) ? `${this.version}/${this.#textVersion}` : this.version
  }

  lines(env: BlockEnv): string[] {
    return reasoningLines(
      env.theme,
      this.text,
      {
        ...(this.durationMs !== undefined ? { durationMs: this.durationMs } : {}),
        thinking: this.#thinking,
        expanded: this.shows(env),
        // A manually folded block keeps its override when global detail changes.
        expandKey:
          this.expanded === undefined && env.detail === "summary" ? env.reasoningExpandKey : undefined,
      },
      env.width,
    )
  }

  copyText(): string {
    return this.text.trim()
  }

  override copyRows(plain: readonly string[]): CopyRow[] {
    // The head is chrome; the text copies without its indent.
    return plain.map((_, i) => (i === 0 ? { from: 0, skip: true } : { from: 4 }))
  }

  override foldable(): boolean {
    return this.text.trim() !== ""
  }

  override toggleFold(env: BlockEnv): void {
    const next = !this.shows(env)
    this.expanded = next === (env.detail === "full") ? undefined : next
    this.touch()
  }

  override isFolded(env: BlockEnv): boolean {
    return !this.shows(env)
  }

  override get refolded(): boolean {
    return this.expanded !== undefined
  }

  override printLines(env: BlockEnv): string[] {
    const expanded = this.expanded
    this.expanded = undefined
    try {
      return this.lines({ ...env, reasoningExpandKey: undefined })
    } finally {
      this.expanded = expanded
    }
  }
}

/** The summary a compaction left, in a resumed history: folded to one line until unfolded. */
export class SummaryBlock extends Block {
  readonly kind = "summary"
  folded = true

  /** `info`: why the compaction happened, when the session kept it. */
  constructor(
    readonly summary: string,
    readonly info?: CompactionInfo,
  ) {
    super()
  }

  lines(env: BlockEnv): string[] {
    return summaryLines(env.theme, this.summary, env.width, this.folded, this.info, env.glyphs)
  }

  copyText(): string {
    return this.summary
  }

  override foldable(): boolean {
    return true
  }

  override toggleFold(): void {
    this.folded = !this.folded
    this.touch()
  }

  override isFolded(): boolean {
    return this.folded
  }

  /** Unfolded by hand, it prints unfolded: nothing shown is lost. */
  override get refolded(): boolean {
    return !this.folded
  }
}
