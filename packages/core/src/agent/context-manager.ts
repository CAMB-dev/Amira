import {
  isNoModel,
  type Message,
  type ModelInfo,
  type ReplayTarget,
  type ToolCallBlock,
  type ToolResultMessage,
} from "@amira/ai"
import { artifactIdOf, outputPreview, outputSize, type ToolDefinition, type ToolResult } from "@amira/api"
import type { ArtifactStore } from "../artifacts.ts"
import { contextTokens, estimateTokens } from "../compaction.ts"
import {
  AGING_DEFAULTS,
  agedStub,
  agingCandidates,
  type ContextOptions,
  type ContextView,
  duplicateView,
  lastSealedIndex,
  pairCalls,
  projectMessages,
  resultText,
} from "../context.ts"
import type { ToolRegistry } from "../tool-registry.ts"
import { toolTraits } from "../tool-traits.ts"
import type { History } from "./history.ts"
import { formatK } from "./messages.ts"
import type { Emit, Turn } from "./types.ts"

interface ContextManagerDeps {
  history: History
  artifacts: ArtifactStore
  tools: ToolRegistry
  toolFor: (call: ToolCallBlock) => ToolDefinition | undefined
  cwd: string
  options: ContextOptions
  model: () => ModelInfo
  replayTarget: () => ReplayTarget
  fixedChars: () => number
  emit: Emit
}

/** Tool-result projections and context-size estimates; compaction stays with the caller. */
export class ContextManager {
  #deps: ContextManagerDeps
  /** Aging rounds so far (A3), for the next round's number. */
  #agingEpoch = 0
  /** Tokens aging freed since the last reply told the context size (an estimate). */
  #contextFreed = 0
  /** The aging round the last reported context size was counted after. */
  #epochAtReply = 0
  /** Context size reported with the last reply; unknown right after a compaction. */
  #contextTokens: number | undefined

  constructor(deps: ContextManagerDeps, init: { contextTokens: number | undefined }) {
    this.#deps = deps
    this.#contextTokens = init.contextTokens
    for (const v of deps.history.views.values()) {
      if (v.kind === "aged") this.#agingEpoch = Math.max(this.#agingEpoch, v.epoch)
    }
    this.#epochAtReply = this.#agingEpoch
  }

  get tokens(): number | undefined {
    return this.#contextTokens
  }

  get freed(): number {
    return this.#contextFreed
  }

  noteReply(tokens: number): void {
    this.#contextTokens = tokens
    this.#contextFreed = 0
    this.#epochAtReply = this.#agingEpoch
  }

  reset(): void {
    this.#contextTokens = undefined
    this.#contextFreed = 0
  }

  #readKey(call: ToolCallBlock, cwd = this.#deps.cwd): string | undefined {
    const tool = this.#deps.toolFor(call)
    if (!tool?.readKey) return undefined
    try {
      return tool.readKey(call.args, { cwd })
    } catch {
      return undefined
    }
  }

  /**
   * A1: a result whose text is over the size limit (a tool that does not cut its own output,
   * such as an MCP server's) is saved whole as an artifact; the model gets a preview with the
   * artifact's id. Saving that fails leaves a preview that says so. Images stay as they are.
   */
  async keepLarge(call: ToolCallBlock, result: ToolResult): Promise<ToolResult> {
    const reader = this.#deps.toolFor(call)
    if (reader && toolTraits(reader)?.artifactReader) return result
    const texts = result.content.flatMap((b) => (b.type === "text" ? [b.text] : []))
    const text = texts.join("\n")
    if (outputSize(text) <= this.#deps.artifacts.limits.saveAbove) return result
    let artifact: Awaited<ReturnType<ArtifactStore["save"]>> | undefined
    let saveError: string | undefined
    try {
      artifact = await this.#deps.artifacts.save({ text, tool: call.name, toolCallId: call.id })
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err)
    }
    const preview = outputPreview({
      text,
      ...(artifact ? { artifact } : {}),
      ...(saveError ? { saveError } : {}),
      ...(result.isError ? { facts: ["the tool reported an error"] } : {}),
      previewChars: this.#deps.artifacts.limits.previewChars,
    })
    const images = result.content.filter((b) => b.type !== "text")
    return { ...result, content: [{ type: "text", text: preview }, ...images] }
  }

  /** A2: views for the reads among a batch's results that repeat an earlier read still in context. */
  dedupe(results: ToolResultMessage[]): [ToolResultMessage, ContextView][] {
    if (this.#deps.options.dedupeReads === false) return []
    // Only a tool that names repeatable reads can repeat one.
    if (!results.some((r) => this.#deps.tools.get(r.toolName)?.readKey)) return []
    const all = [...this.#deps.history.messages, ...results]
    const pairs = pairCalls(all)
    const out: [ToolResultMessage, ContextView][] = []
    for (const [i, result] of results.entries()) {
      const call = pairs.get(result)
      if (!call || !this.#readKey(call)) continue
      const history = all.slice(0, this.#deps.history.messages.length + i)
      const view = duplicateView(
        history,
        this.#deps.history.views,
        pairs,
        result,
        call,
        this.#deps.cwd,
        (c, cwd) => this.#readKey(c, cwd),
      )
      if (!view) continue
      this.#deps.history.views.set(result, view)
      out.push([result, view])
    }
    return out
  }

  /**
   * The size of the next request, estimated: the context the last reply reported, less what
   * aging freed since, plus what was added after it, counted in characters and scaled by how
   * the model's own count compared for what it saw (so text of any script comes out close).
   */
  estimateNext(): number {
    const projected = projectMessages(this.#deps.history.messages, this.#deps.history.views)
    const fixed = Math.ceil(this.#deps.fixedChars() / 4)
    const last = this.#deps.history.messages.findLastIndex(
      (m) => m.role === "assistant" && m.usage !== undefined && contextTokens(m.usage) > 0,
    )
    const observed = this.#contextTokens
    if (observed === undefined || last === -1) return fixed + estimateTokens(projected)
    const seen =
      fixed +
      estimateTokens(projectMessages(this.#deps.history.messages.slice(0, last + 1), this.#seenViews()))
    const scale = Math.min(4, Math.max(0.5, observed / Math.max(1, seen)))
    return (
      Math.max(0, observed - this.#contextFreed) +
      Math.round(scale * estimateTokens(projected.slice(last + 1)))
    )
  }

  /** How the model's count compares with estimateTokens for this session's history. */
  #tokenScale(): number {
    const observed = this.#contextTokens
    const last = this.#deps.history.messages.findLastIndex(
      (m) => m.role === "assistant" && m.usage !== undefined && contextTokens(m.usage) > 0,
    )
    if (observed === undefined || last === -1) return 1
    const seen = estimateTokens(
      projectMessages(this.#deps.history.messages.slice(0, last + 1), this.#seenViews()),
    )
    return Math.min(4, Math.max(0.5, observed / Math.max(1, seen)))
  }

  /**
   * The views the last reported context size was counted with: aging rounds since then are
   * left out (that size is from before them), so comparing it with an estimate stays fair.
   */
  #seenViews(): ReadonlyMap<Message, ContextView> {
    const since = [...this.#deps.history.views].filter(
      ([, v]) => v.kind === "aged" && v.epoch > this.#epochAtReply,
    )
    if (!since.length) return this.#deps.history.views
    const out = new Map(this.#deps.history.views)
    for (const [m] of since) out.delete(m)
    return out
  }

  /**
   * A3: when the next request would pass `start` of the window (or passed it: `overflow`), old
   * tool results are cleared in one batch down to `target`: each is sent from then on as a short
   * stub that says how to get it back, and its whole text is kept as an artifact. Only where the
   * history may be rewritten: nothing before signed or encrypted provider data that a request
   * would send back. A round freeing less than minSavedTokens is skipped, keeping the prompt
   * prefix as it is. Undefined when there is nothing to age; else resolves whether it cleared
   * anything.
   */
  age(turn: Turn, overflow = false): Promise<boolean> | undefined {
    const o = { ...AGING_DEFAULTS, ...this.#deps.options.aging }
    if (!o.enabled || isNoModel(this.#deps.model())) return undefined
    const window = this.#deps.model().contextWindow
    const estimate = this.estimateNext()
    const pressure = overflow || estimate > o.start * window
    if (!pressure && o.afterTurns <= 0) return undefined
    const sealed = lastSealedIndex(this.#deps.history.messages, this.#deps.replayTarget())
    const candidates = agingCandidates(this.#deps.history.messages, this.#deps.history.views, {
      keepTurns: o.keepTurns,
      keepSteps: o.keepSteps,
      sealed,
      cwd: this.#deps.cwd,
      ...(pressure ? {} : { olderThanTurns: o.afterTurns }),
    })
    if (!candidates.length) return undefined
    const scale = this.#tokenScale()
    // After an overflow the window or the estimate was wrong: free a good part whatever they say.
    const down = estimate - Math.min(o.target, o.start) * window
    const goal = overflow ? Math.max(down, 0.3 * estimate) : pressure ? down : Number.POSITIVE_INFINITY
    const picks: { m: ToolResultMessage; call: ToolCallBlock | undefined; saved: number }[] = []
    let saved = 0
    for (const c of candidates) {
      if (saved >= goal) break
      // A stub is about 100 tokens.
      const gain = Math.max(0, Math.round(scale * (c.tokens - 100)))
      picks.push({ m: c.message, call: c.call, saved: gain })
      saved += gain
    }
    // A window whose aging band is narrower than minSavedTokens still ages: never ask for more than the band.
    const minSaved = Math.min(o.minSavedTokens, Math.max(0, (o.start - Math.min(o.target, o.start)) * window))
    if (saved <= 0 || (!overflow && saved < minSaved)) return undefined
    return this.#applyAging(turn, picks)
  }

  /** Sends the picked results as stubs from now on, each with its whole text kept as an artifact. */
  async #applyAging(
    turn: Turn,
    picks: { m: ToolResultMessage; call: ToolCallBlock | undefined; saved: number }[],
  ): Promise<boolean> {
    const epoch = this.#agingEpoch + 1
    const aged: [Message, ContextView][] = []
    let freed = 0
    for (const p of picks) {
      if (turn.signal.aborted) break
      const text = resultText(p.m) ?? ""
      let artifact = artifactIdOf(text)
      if (!artifact) {
        try {
          artifact = (
            await this.#deps.artifacts.save({ text, tool: p.m.toolName, toolCallId: p.m.toolCallId })
          ).id
        } catch {
          // Without its artifact only a file read can be read again.
          if (!p.call || !this.#readKey(p.call)) continue
        }
      }
      const tool = p.call ? this.#deps.toolFor(p.call) : undefined
      // A tool no longer registered (disabled, unloaded) is judged by its name, as built-ins were.
      const traits = toolTraits(tool ?? { name: p.m.toolName })
      const view: ContextView = {
        kind: "aged",
        text: agedStub(p.m, p.call, artifact, {
          read: tool ? tool.readKey !== undefined : p.m.toolName === "read",
          shell: traits?.shell !== undefined || tool?.shellKind !== undefined,
        }),
        epoch,
      }
      this.#deps.history.views.set(p.m, view)
      aged.push([p.m, view])
      freed += p.saved
    }
    if (!aged.length) return false
    this.#agingEpoch = epoch
    this.#contextFreed += freed
    this.#deps.history.storeViews(aged)
    this.#deps.emit(turn, "extension.notice", {
      source: "context",
      text: `Cleared ${aged.length} old tool ${aged.length === 1 ? "result" : "results"} from the context (about ${formatK(freed)} tokens); the model can read them again with output_read or read.`,
      level: "info",
    })
    return true
  }
}
