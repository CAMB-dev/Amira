import {
  type Ai,
  addUsage,
  type CompactionLayout,
  emptyUsage,
  isNoModel,
  type Message,
  type ModelInfo,
  type ModelRef,
  type Signature,
  type ToolSpec,
  type Usage,
} from "@amira/ai"
import type { CompactionInfo, CompactionReason, CompactionUsage } from "@amira/api"
import {
  type CompactionOptions,
  checkpointOf,
  estimateAfter,
  isSummaryMessage,
  KEEP_USER_TOKENS,
  recentUserMessages,
  SummaryError,
  splitHistory,
  summarize,
  summaryMessages,
  summaryOf,
  windowGuessNotice,
} from "../compaction.ts"
import { projectMessages } from "../context.ts"
import { amiraPath } from "../home.ts"
import type { InterceptOutcome, InterceptorRegistry } from "../interceptors.ts"
import type { SessionStore } from "../session-store.ts"
import type { PauseGate } from "../subagents/pause.ts"
import type { ContextManager } from "./context-manager.ts"
import type { History } from "./history.ts"
import { modelRef } from "./messages.ts"
import { compactionFallback } from "./model-call.ts"
import type { Emit, Turn } from "./types.ts"

interface CompactorDeps {
  ai: Ai
  /** Read at each use: the model can change while compaction awaits. */
  model: () => ModelInfo
  options: CompactionOptions
  history: History
  context: ContextManager
  interceptors: InterceptorRegistry
  session: SessionStore | undefined
  sessionId: string
  isSubAgent: boolean
  execution: PauseGate
  buildContext: (
    signal: AbortSignal,
  ) => Promise<InterceptOutcome<{ systemPrompt: string; messages: Message[] }>>
  renderSections: () => string
  offeredTools: () => ToolSpec[]
  recordTreeUsage: (usage: Usage) => void
  emit: Emit
}

/** Compaction and checkpoint readability for one session; turn ownership stays with the caller. */
export class Compactor {
  #deps: CompactorDeps
  /** Compaction costs the session file does not hold (no file, or a compaction that failed). */
  #compactionCosts: CompactionUsage[] = []
  /** The next reply's context size tells whether the last compaction shrank the context enough. */
  #checkCompaction = false
  /** The notice that the context window is a guess was shown (once a session). */
  #windowGuessNoted = false
  /** Automatic compaction waits until the context passes this, after one that did not help. */
  #compactFloor: number | undefined

  constructor(deps: CompactorDeps) {
    this.#deps = deps
  }

  modelChanged(): void {
    this.#compactFloor = undefined
  }

  #overThreshold(tokens: number): boolean {
    return tokens > (this.#deps.options.threshold ?? 0.8) * this.#deps.model().contextWindow
  }

  /**
   * Once a session, when automatic compaction goes by a context window that is only a guess
   * (no settings or catalog entry for the model): a notice on where to set it. Only once it
   * starts to matter, when the context passes half the guessed window or the model rejects a
   * request as too long (`overflow`), so short sessions stay quiet and a catalog still
   * loading in the background can name the window first. Sub-agents leave it to their
   * commander's session.
   */
  noteWindowGuess(turn: Turn, overflow = false): void {
    if (this.#windowGuessNoted || this.#deps.isSubAgent) return
    if (this.#deps.options.auto === false || this.#deps.model().contextWindowSource !== "default") return
    if (isNoModel(this.#deps.model())) return
    if (!overflow && (this.#deps.context.tokens ?? 0) <= this.#deps.model().contextWindow / 2) return
    this.#windowGuessNoted = true
    const text = windowGuessNotice(this.#deps.model(), amiraPath("settings.json"))
    this.#deps.emit(turn, "extension.notice", { source: "compaction", text, level: "info" })
  }

  needsCompaction(): boolean {
    if (this.#deps.options.auto === false || this.#deps.context.tokens === undefined) return false
    // What aging freed since the last reply no longer counts.
    const tokens = this.#deps.context.tokens - this.#deps.context.freed
    if (this.#compactFloor !== undefined && tokens <= this.#compactFloor) return false
    return this.#overThreshold(tokens)
  }

  /**
   * Notes the context size of a reply. The first one after a compaction shows whether it
   * worked: still over the threshold means summarizing again right away would not help
   * either, so automatic compaction waits until the context has grown by a twentieth of the
   * window, which gives the next summary new steps to fold in.
   */
  noteContext(tokens: number): void {
    this.#deps.context.noteReply(tokens)
    if (!this.#checkCompaction) return
    this.#checkCompaction = false
    this.#compactFloor = this.#overThreshold(tokens)
      ? tokens + this.#deps.model().contextWindow / 20
      : undefined
  }

  /**
   * Replaces older history with a summary (D19, D57). Never throws; failures emit compact.failed.
   * compact.before runs first, so a compaction it blocks never starts and is reported as blocked.
   * Resolves true when it compacted, false when it failed or was blocked, and undefined when
   * there was nothing to compact yet (a long turn may have enough a few steps later).
   */
  async compact(
    reason: CompactionReason,
    signal: AbortSignal,
    turn: Turn | undefined,
    instructions?: string,
  ): Promise<boolean | undefined> {
    // What is compacted must be readable by this model first (an earlier checkpoint of another).
    const unreadable = await this.fillSummaries(turn, signal)
    if (unreadable || signal.aborted) {
      this.#deps.emit(turn, "compact.failed", { error: unreadable ?? "aborted" })
      return false
    }
    const split = splitHistory(
      this.#deps.history.messages,
      this.#deps.options.keepTurns ?? 2,
      this.#deps.options.keepSteps ?? 2,
    )
    if (!split) {
      if (reason === "manual")
        this.#deps.emit(turn, "compact.failed", { error: "nothing to compact yet", empty: true })
      return undefined
    }
    try {
      const gate = await this.#deps.interceptors.run(
        "compact.before",
        { messages: split.older, kept: split.kept },
        { sessionId: this.#deps.sessionId, signal },
      )
      if (signal.aborted) throw new Error("aborted")
      if (gate.blocked) {
        this.#deps.emit(turn, "compact.failed", { error: gate.reason, blocked: true })
        return false
      }
      const supplied = gate.value.summary?.trim()
      // The server compacts when the provider has it on, unless the summary is the user's or
      // an extension's to shape (/compact instructions, compact.model, an interceptor's).
      const server =
        supplied || instructions?.trim() || this.#deps.options.model
          ? undefined
          : this.#deps.ai.nativeCompaction(this.#deps.model())
      const wanted = this.#deps.options.layout ?? "tail"
      const layout: CompactionLayout = server?.layouts.includes(wanted) ? wanted : "tail"
      // A "tail" checkpoint over the first steps of a long turn only where the dialect allows.
      const native =
        server && (layout === "recent-user" || !split.prompt || server.midTurn) ? server : undefined
      // What is compacted, and what stays verbatim (before the summary for "recent-user").
      const retained =
        native && layout === "recent-user"
          ? recentUserMessages(
              this.#deps.history.messages,
              this.#deps.options.keepUserTokens ?? KEEP_USER_TOKENS,
            )
          : []
      const older = native && layout === "recent-user" ? [...this.#deps.history.messages] : split.older
      const kept = native && layout === "recent-user" ? retained : split.kept
      this.#deps.emit(turn, "compact.start", {
        reason,
        replacing: older.length - retained.length,
        kept: kept.length,
        ...(this.#deps.context.tokens !== undefined ? { tokens: this.#deps.context.tokens } : {}),
        ...(native ? { native: true } : {}),
      })

      let usage = emptyUsage()
      let counted = false
      const count = (u: Usage | undefined) => {
        if (!u) return
        usage = addUsage(usage, u)
        counted = true
      }
      let summary: string | undefined
      let checkpoint: Signature | undefined
      /** Tokens the server wrote for the checkpoint: about what it takes up in the context. */
      let checkpointTokens = 0
      let fallback: string | undefined
      let compacted: Message[] | undefined
      if (native) {
        // The history as the server compacts it: in a long turn its prompt goes along in place.
        const olderSet = new Set(older)
        const input =
          layout === "recent-user"
            ? older
            : this.#deps.history.messages.filter((m) => olderSet.has(m) || m === split.prompt)
        const built = await this.#deps.buildContext(signal).catch(() => undefined)
        const systemPrompt = built && !built.blocked ? built.value.systemPrompt : this.#deps.renderSections()
        // The same tools a reply would get: the client web_search stays hidden from a model
        // with the hosted search, which the dialect adds beside them as in every request.
        if (this.#deps.execution.paused) await this.#deps.execution.wait(signal)
        if (signal.aborted) throw new Error("aborted")
        const r = await this.#deps.ai.compact(
          {
            model: this.#deps.model(),
            systemPrompt,
            // Sent as requests send them; `compacted` keeps the messages themselves.
            messages: projectMessages(input, this.#deps.history.views),
            tools: this.#deps.offeredTools(),
          },
          signal,
        )
        count(r.usage)
        if (signal.aborted) throw new Error("aborted")
        if (r.ok) {
          summary = r.summary ?? ""
          checkpoint = r.checkpoint
          compacted = input
          checkpointTokens = r.usage.output
        } else fallback = compactionFallback(r, (notice) => this.#deps.emit(turn, "extension.notice", notice))
      }
      const writer = this.#deps.options.model ?? this.#deps.model()
      if (summary === undefined) {
        try {
          if (this.#deps.execution.paused) await this.#deps.execution.wait(signal)
          if (signal.aborted) throw new Error("aborted")
          const written = supplied
            ? { summary: supplied }
            : await summarize(
                this.#deps.ai,
                writer,
                projectMessages(this.#readable(split.older), this.#deps.history.views),
                signal,
                instructions,
                split.prompt,
              )
          count(written.usage)
          summary = written.summary
        } catch (err) {
          // What the failed compaction still cost: the server attempts before it, and its own.
          if (err instanceof SummaryError) count(err.usage)
          if (counted) this.#recordCompactionUsage(usage, modelRef(writer), false)
          throw err
        }
      }
      if (signal.aborted) throw new Error("aborted")
      // A text summary replaces the older part and keeps the tail, whatever the layout.
      const recent = checkpoint && layout === "recent-user"
      const replacedMessages = recent ? older : split.older
      const keptMessages = recent ? retained : split.kept
      const ids = (ms: Message[]) => [
        ...new Set(
          ms.flatMap((m) => {
            const id = this.#deps.history.entryId(m)
            return id !== undefined ? [id] : []
          }),
        ),
      ]
      const replaces = ids(replacedMessages)
      const retainedIds = recent ? ids(retained) : []
      const replacement = summaryMessages(
        summary,
        modelRef(checkpoint ? this.#deps.model() : writer),
        checkpoint,
      )
      const before = this.#deps.context.tokens
      const nativeRef = checkpoint ? modelRef(this.#deps.model()) : undefined
      const info: CompactionInfo = {
        reason,
        ...(before !== undefined
          ? {
              tokensBefore: before,
              tokensAfter: estimateAfter(
                before,
                projectMessages(
                  replacedMessages.filter((m) => !retained.includes(m)),
                  this.#deps.history.views,
                ),
                projectMessages(keptMessages, this.#deps.history.views),
                // The checkpoint replaces both summary messages on the wire. Its size is
                // already in tokens; without usage, estimate from its encrypted length.
                checkpoint ? checkpointTokens || Math.ceil(checkpoint.value.length / 16) : replacement,
              ),
            }
          : {}),
        ...(isNoModel(this.#deps.model()) ? {} : { contextWindow: this.#deps.model().contextWindow }),
        // Separate objects: a JSON writer that marks repeated references as cycles would drop one.
        ...(supplied ? {} : { model: nativeRef ? { ...nativeRef } : modelRef(writer) }),
        ...(nativeRef ? { native: nativeRef, layout } : {}),
        ...(fallback ? { fallback } : {}),
      }
      const entryId = this.#deps.history.store({
        type: "compaction",
        summary,
        replaces,
        ...info,
        ...(checkpoint ? { checkpoint } : {}),
        ...(retainedIds.length ? { retained: retainedIds } : {}),
        ...(counted ? { usage } : {}),
      })
      if (counted)
        this.#recordCompactionUsage(usage, nativeRef ?? modelRef(writer), Boolean(checkpoint), true)
      this.#deps.history.noteCompaction(replacement[0]!, info, compacted)
      for (const m of replacement) if (entryId) this.#deps.history.setEntryId(m, entryId)
      for (const m of replacedMessages) if (!retained.includes(m)) this.#deps.history.forgetEntry(m)
      if (recent) {
        // Codex's layout: the latest user messages, then the checkpoint last.
        this.#deps.history.messages.splice(0, this.#deps.history.messages.length, ...retained, ...replacement)
      } else {
        // The summary goes first; everything it does not replace keeps its order after it (in
        // a long turn that is the turn's prompt and its latest steps).
        const replaced = new Set(split.older)
        const rest = this.#deps.history.messages.filter((m) => !replaced.has(m))
        this.#deps.history.messages.splice(0, this.#deps.history.messages.length, ...replacement, ...rest)
      }
      this.#deps.context.reset()
      this.#checkCompaction = true
      this.#deps.emit(turn, "compact.end", {
        summary,
        replaced: replacedMessages.length - retained.length,
        kept: keptMessages.length,
        ...(counted ? { usage } : {}),
        ...info,
      })
      return true
    } catch (err) {
      this.#deps.emit(turn, "compact.failed", { error: err instanceof Error ? err.message : String(err) })
      return false
    }
  }

  /**
   * Counts what a compaction's requests cost toward the tree's budget and, without a session
   * file to read it from later, keeps it for compactionUsage. `stored` says the session file
   * has it (in the compaction entry).
   */
  #recordCompactionUsage(usage: Usage | undefined, model: ModelRef, native: boolean, stored = false) {
    if (!usage || usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) return
    this.#deps.recordTreeUsage(usage)
    if (!stored || !this.#deps.session)
      this.#compactionCosts.push({ model, usage, ...(native ? { native } : {}) })
  }

  /**
   * History a model can read as text: a summary pair whose checkpoint has no readable text
   * stands as the history it compacted instead (from memory, or rebuilt from the session file).
   */
  #readable(messages: Message[], depth = 0): Message[] {
    if (depth > 8) return messages
    return messages.flatMap((m) => {
      if (!isSummaryMessage(m) || !checkpointOf(m) || summaryOf(m)) return [m]
      if (m.role === "assistant") return []
      const originals = this.#deps.history.originalsOf(m)
      return originals ? this.#readable(originals, depth + 1) : [m]
    })
  }

  /**
   * The history a compaction's summary message (the user message of the pair) stands for, if
   * it can still be found: for agents forked from this one (AgentOptions.originals).
   */
  compactedHistory(summary: Message): Message[] | undefined {
    return this.#deps.history.originalsOf(summary)
  }

  /**
   * Makes sure the model can read every compaction in the history: a server checkpoint it
   * cannot be sent (another provider, host or model; canReplay) and that has no readable
   * summary gets one written now from the history it stands for, once, and stored as a
   * compaction entry that fills in the original (it keeps the checkpoint, so switching back
   * uses it again). Resolves an error message when that was not possible.
   */
  async fillSummaries(turn: Turn | undefined, signal: AbortSignal): Promise<string | undefined> {
    // Without a model nothing can be read or written; the request fails on its own terms.
    if (isNoModel(this.#deps.model())) return undefined
    for (let i = 0; i < this.#deps.history.messages.length; i++) {
      const m = this.#deps.history.messages[i]!
      const cp = m.role === "user" && isSummaryMessage(m) ? checkpointOf(m) : undefined
      if (!cp || summaryOf(m) || this.#deps.ai.canReplay(cp, this.#deps.model())) continue
      const target = `${this.#deps.model().provider}/${this.#deps.model().id}`
      const originals = this.#deps.history.originalsOf(m)
      if (!originals?.length) {
        return `the conversation was compacted by ${cp.provider}'s server for ${cp.model}, which ${target} cannot read, and the messages it stands for are not in the session any more; switch back with /model ${cp.provider}/${cp.model}`
      }
      const writer = this.#deps.options.model ?? this.#deps.model()
      let written: { summary: string; usage?: Usage }
      try {
        if (this.#deps.execution.paused) await this.#deps.execution.wait(signal)
        if (signal.aborted) return undefined
        written = await summarize(
          this.#deps.ai,
          writer,
          projectMessages(this.#readable(originals), this.#deps.history.views),
          signal,
        )
      } catch (err) {
        if (err instanceof SummaryError) this.#recordCompactionUsage(err.usage, modelRef(writer), false)
        if (signal.aborted) return undefined
        const why = err instanceof Error ? err.message : String(err)
        return `${target} cannot read the server-side compaction made by ${cp.provider} for ${cp.model}, and writing a text summary for it failed: ${why}`
      }
      const oldId = this.#deps.history.entryId(m)
      const original = oldId ? this.#deps.session?.get(oldId) : undefined
      const pair = summaryMessages(written.summary, modelRef(writer), cp)
      const prior = this.#deps.history.compactionInfo(m)
      const info: CompactionInfo | undefined = prior ? { ...prior, model: modelRef(writer) } : undefined
      const entryId = this.#deps.history.store({
        type: "compaction",
        summary: written.summary,
        replaces: oldId ? [oldId] : [],
        ...(info ?? { model: modelRef(writer) }),
        checkpoint: cp,
        ...(original?.type === "compaction" && original.retained ? { retained: original.retained } : {}),
        ...(written.usage ? { usage: written.usage } : {}),
        ...(oldId ? { fills: oldId } : {}),
      })
      if (written.usage) this.#recordCompactionUsage(written.usage, modelRef(writer), false, true)
      const ack = this.#deps.history.messages[i + 1]
      const pairLength = ack?.role === "assistant" && isSummaryMessage(ack) ? 2 : 1
      this.#deps.history.messages.splice(i, pairLength, ...pair)
      this.#deps.history.noteCompaction(pair[0]!, info, originals)
      for (const p of pair) if (entryId) this.#deps.history.setEntryId(p, entryId)
      this.#deps.emit(turn, "extension.notice", {
        source: "compaction",
        text: `${target} cannot use the server-side compaction made by ${cp.provider} for ${cp.model}, so a text summary of it was written for it.`,
        level: "info",
      })
    }
    return undefined
  }

  /** What this session's compactions cost, one entry each (SessionControl.compactions). */
  get usage(): CompactionUsage[] {
    const stored: CompactionUsage[] = (this.#deps.session?.entries ?? []).flatMap((e) => {
      if (e.type !== "compaction" || !e.usage) return []
      const model = e.model ?? e.native ?? { provider: "", model: "" }
      return [{ model, usage: e.usage, ...(e.native && !e.fills ? { native: true } : {}) }]
    })
    return [...stored, ...this.#compactionCosts]
  }
}
