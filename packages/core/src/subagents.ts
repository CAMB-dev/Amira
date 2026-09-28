import path from "node:path"
import {
  type Ai,
  type AssistantMessage,
  emptyUsage,
  type Message,
  type ModelInfo,
  type Usage,
  userMessage,
} from "@amira/ai"
import type {
  AnyEvent,
  ApprovalRequest,
  Budget,
  ChildSession,
  SpawnContext,
  SpawnOptions,
  SubagentResult,
  SubagentStatus,
} from "@amira/api"
import { Agent, type ApprovalDecision } from "./agent.ts"
import type { CompactionOptions } from "./compaction.ts"
import type { EmitMeta } from "./event-bus.ts"
import { instructionsSection, loadInstructions } from "./instructions.ts"
import { defaultSections, type PromptSection, renderPrompt, setSection } from "./prompt.ts"
import { SessionStore } from "./session-store.ts"
import { ToolRegistry } from "./tool-registry.ts"

/** spawn refused: too deep, budget spent or an unknown model. */
export class SpawnError extends Error {}

export interface AgentTreeOptions {
  ai: Ai
  /** Deepest a sub-agent may be (D15). Default 2: children and grandchildren. */
  maxDepth?: number
  /** Children of one parent running at once; the rest wait in order (D63). Default 4. */
  maxConcurrent?: number
  /** Shared by every session of the tree (D37). Default: unlimited. */
  budget?: Budget
  /** System prompt of a fresh child working in `cwd`. Default: the standard sections with that directory's instructions. */
  sections?: (cwd: string) => PromptSection[]
  compaction?: CompactionOptions
  maxParallelTools?: number
}

/** All tokens a reply used, cache included: what a token budget counts. */
export function usageTokens(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite
}

function addUsage(to: Usage, u: Usage) {
  to.input += u.input
  to.output += u.output
  to.cacheRead += u.cacheRead
  to.cacheWrite += u.cacheWrite
  if (u.cost !== undefined) to.cost = (to.cost ?? 0) + u.cost
}

/**
 * The parent's conversation as a child's starting point (context "fork"). The parent is in
 * the middle of a tool call, so calls without a result are dropped; an assistant message left
 * without content gets a placeholder so roles keep alternating for every provider.
 */
export function forkHistory(messages: readonly Message[]): Message[] {
  const answered = new Set(messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])))
  return messages.map((m) => {
    if (m.role !== "assistant") return m
    const content = m.content.filter((b) => b.type !== "toolCall" || answered.has(b.id))
    if (content.length === m.content.length) return m
    const kept = content.some((b) => b.type === "text" && b.text.trim())
    return {
      ...m,
      content: kept ? content : [...content, { type: "text", text: "(Delegating to sub-agents.)" }],
    } as AssistantMessage
  })
}

/** The text of the last assistant reply. */
function finalText(messages: readonly Message[]): string {
  const last = messages.findLast((m) => m.role === "assistant" && m.content.some((b) => b.type === "text"))
  if (last?.role !== "assistant") return ""
  return last.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("")
    .trim()
}

interface Slot {
  running: number
  queue: Child[]
}

class Child implements ChildSession {
  readonly id: string
  readonly parentSessionId: string
  readonly depth: number
  readonly cwd: string
  readonly usage = emptyUsage()
  /** Set once aborted: why. */
  abortReason: string | undefined
  started = false
  #result: Promise<SubagentResult>
  settle!: (r: SubagentResult) => void

  constructor(
    readonly agent: Agent,
    readonly prompt: string,
    readonly context: SpawnContext,
    private tree: AgentTree,
  ) {
    this.id = agent.sessionId
    this.parentSessionId = agent.parentSessionId!
    this.depth = agent.depth
    this.cwd = agent.cwd
    this.#result = new Promise((resolve) => {
      this.settle = resolve
    })
  }

  get model() {
    return { provider: this.agent.model.provider, model: this.agent.model.id }
  }

  get events(): AsyncIterable<AnyEvent> {
    return this.tree.eventsOf(this)
  }

  result(): Promise<SubagentResult> {
    return this.#result
  }

  abort(reason = "aborted by its parent"): void {
    this.tree.abortChild(this, reason)
  }
}

/**
 * One agent tree (D12, D15): starts sub-agents as real sessions under their parent, bubbles
 * their events (they share the parent's bus and carry parentSessionId), limits nesting and
 * concurrency, and keeps the budget every session of the tree spends from.
 */
export class AgentTree {
  readonly maxDepth: number
  readonly maxConcurrent: number
  readonly budget: Budget | undefined
  #opts: AgentTreeOptions
  #total = emptyUsage()
  /** Why the budget is spent, once it is. */
  #exceeded: string | undefined
  #live = new Map<string, Child>()
  /** Parent session id of every child ever spawned, for telling descendants apart. */
  #parentOf = new Map<string, string>()
  #slots = new Map<string, Slot>()

  constructor(opts: AgentTreeOptions) {
    this.#opts = opts
    this.maxDepth = Math.max(0, opts.maxDepth ?? 2)
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 4)
    this.budget = opts.budget
  }

  /** What the whole tree has used so far. */
  get usage(): Readonly<Usage> {
    return this.#total
  }

  /** Children that are queued or running, oldest first. */
  get children(): ChildSession[] {
    return [...this.#live.values()]
  }

  /** Whether `sessionId` is `ancestor` or one of its descendants. */
  isWithin(sessionId: string, ancestor: string): boolean {
    for (let id: string | undefined = sessionId; id; id = this.#parentOf.get(id))
      if (id === ancestor) return true
    return false
  }

  spawn(parent: Agent, opts: SpawnOptions): ChildSession {
    if (this.#exceeded) throw new SpawnError(`the agent tree's budget is spent (${this.#exceeded})`)
    const depth = parent.depth + 1
    if (depth > this.maxDepth) {
      throw new SpawnError(
        `sub-agents can nest at most ${this.maxDepth} level${this.maxDepth === 1 ? "" : "s"} deep`,
      )
    }
    let model: ModelInfo = parent.model
    if (opts.model) {
      try {
        model = this.#opts.ai.model(opts.model)
      } catch (err) {
        throw new SpawnError(err instanceof Error ? err.message : String(err))
      }
    }
    const cwd = opts.cwd ? path.resolve(parent.cwd, opts.cwd) : parent.cwd
    const context = opts.context ?? "fresh"
    const base = context === "fork" ? [...parent.sections] : (this.#opts.sections ?? standardSections)(cwd)
    const allow = opts.tools ? new Set(opts.tools) : undefined
    const deny = new Set(opts.excludeTools ?? [])
    const scoped = allow !== undefined || deny.size > 0
    const store = parent.session
      ? SessionStore.create({
          cwd,
          parent: parent.sessionId,
          dir: path.join(path.dirname(parent.session.file), "subagents"),
        })
      : undefined
    const agent = new Agent({
      ai: this.#opts.ai,
      model,
      cwd,
      sections: setSection(base, "role", opts.systemPrompt ?? ""),
      messages: context === "fork" ? forkHistory(parent.messages) : [],
      bus: parent.bus,
      interceptors: parent.interceptors,
      tools: scoped
        ? ToolRegistry.view(parent.tools, (n) => (allow?.has(n) ?? true) && !deny.has(n))
        : parent.tools,
      ...(store ? { session: store } : {}),
      parentSessionId: parent.sessionId,
      depth,
      tree: this,
      approve: (request, signal) => this.#askParent(parent, request, signal),
      ...(this.#opts.compaction ? { compaction: this.#opts.compaction } : {}),
      ...(this.#opts.maxParallelTools ? { maxParallelTools: this.#opts.maxParallelTools } : {}),
    })
    parent.recordSubagent(agent.sessionId, opts.role)
    const child = new Child(agent, opts.prompt, context, this)
    this.#live.set(child.id, child)
    this.#parentOf.set(child.id, parent.sessionId)

    const slot = this.#slots.get(parent.sessionId) ?? { running: 0, queue: [] }
    this.#slots.set(parent.sessionId, slot)
    const queued = slot.running >= this.maxConcurrent
    parent.bus.emit(
      "subagent.start",
      {
        childSessionId: child.id,
        ...(opts.role ? { role: opts.role } : {}),
        prompt: opts.prompt,
        model: child.model,
        depth,
        cwd,
        context,
        queued,
      },
      metaOf(parent),
    )
    if (queued) slot.queue.push(child)
    else {
      slot.running++
      // Started a microtask later, so the caller can subscribe to child.events first.
      queueMicrotask(() => void this.#run(parent.sessionId, child))
    }
    return child
  }

  /** Adds a reply's usage to the tree, reports it, and stops the children once over budget. */
  recordUsage(agent: Agent, usage: Usage): void {
    addUsage(this.#total, usage)
    const child = this.#live.get(agent.sessionId)
    if (child) addUsage(child.usage, usage)
    const tokens = usageTokens(this.#total)
    const costUsd = this.#total.cost
    const limit = this.budget
    agent.bus.emit(
      "budget.update",
      { tokens, ...(costUsd !== undefined ? { costUsd } : {}), ...(limit ? { limit } : {}) },
      metaOf(agent),
    )
    if (this.#exceeded || !limit) return
    const over =
      limit.tokens !== undefined && tokens > limit.tokens
        ? `${tokens} tokens used, limit ${limit.tokens}`
        : limit.costUsd !== undefined && costUsd !== undefined && costUsd > limit.costUsd
          ? `$${costUsd.toFixed(4)} spent, limit $${limit.costUsd}`
          : undefined
    if (!over) return
    this.#exceeded = over
    agent.bus.emit(
      "budget.exceeded",
      { tokens, ...(costUsd !== undefined ? { costUsd } : {}), limit },
      metaOf(agent),
    )
    this.abortAll(`the agent tree's budget ran out (${over})`)
  }

  /** Aborts every queued and running child. */
  abortAll(reason: string): void {
    for (const child of [...this.#live.values()]) this.abortChild(child, reason)
  }

  abortChild(child: Child, reason: string): void {
    if (!this.#live.has(child.id) || child.abortReason) return
    child.abortReason = reason
    if (child.started) {
      child.agent.abort()
      return
    }
    const slot = this.#slots.get(child.parentSessionId)
    if (slot) slot.queue = slot.queue.filter((c) => c !== child)
    this.#finish(child, { status: "aborted", error: reason, steps: 0, durationMs: 0 })
  }

  /** Events of the child and its descendants, ending with the child's subagent.end. */
  eventsOf(child: Child): AsyncIterable<AnyEvent> {
    const queue: AnyEvent[] = []
    let ended = false
    let wake: (() => void) | undefined
    const off = child.agent.bus.subscribe((e) => {
      const end = e.type === "subagent.end" && e.data.childSessionId === child.id
      if (!end && !this.isWithin(e.sessionId, child.id)) return
      queue.push(e)
      if (end) {
        ended = true
        off()
      }
      wake?.()
    })
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const e = queue.shift()
            if (e) {
              yield e
              continue
            }
            if (ended) return
            await new Promise<void>((resolve) => {
              wake = resolve
            })
            wake = undefined
          }
        } finally {
          off()
        }
      },
    }
  }

  /** Runs one child's turn in its parent's slot, then starts the next queued sibling. */
  async #run(parentId: string, child: Child) {
    const startedAt = performance.now()
    let steps = 0
    let status: SubagentStatus = "error"
    let error: string | undefined
    try {
      if (!child.abortReason) {
        child.started = true
        child.agent.start(child.context === "fork" ? "fork" : "startup")
        const r = await child.agent.prompt(child.prompt)
        steps = r.steps
        status = r.reason
        error = r.error
      } else {
        status = "aborted"
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      if (status === "aborted") error = child.abortReason ?? error
      this.#finish(child, {
        status,
        ...(error !== undefined ? { error } : {}),
        steps,
        durationMs: Math.round(performance.now() - startedAt),
      })
      const slot = this.#slots.get(parentId)
      if (slot) {
        slot.running--
        const next = slot.queue.shift()
        if (next) {
          slot.running++
          void this.#run(parentId, next)
        }
      }
    }
  }

  #finish(child: Child, r: Pick<SubagentResult, "status" | "error" | "steps" | "durationMs">) {
    if (!this.#live.delete(child.id)) return
    const result: SubagentResult = {
      sessionId: child.id,
      status: r.status,
      text: finalText(child.agent.messages),
      ...(r.error !== undefined ? { error: r.error } : {}),
      usage: { ...child.usage },
      steps: r.steps,
      durationMs: r.durationMs,
    }
    const meta: EmitMeta = { sessionId: child.parentSessionId }
    const grand = this.#parentOf.get(child.parentSessionId)
    if (grand) meta.parentSessionId = grand
    child.agent.bus.emit(
      "subagent.end",
      {
        childSessionId: child.id,
        status: result.status,
        ...(result.error !== undefined ? { error: result.error } : {}),
        usage: result.usage,
        durationMs: result.durationMs,
      },
      meta,
    )
    child.settle(result)
  }

  /**
   * D14: a child's approval request goes to its parent's model, not to the user. It gets the
   * parent's conversation and the request, without tools, and must answer APPROVE or DENY.
   */
  async #askParent(parent: Agent, req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const args = JSON.stringify(req.args, null, 2)
    const question = [
      `A sub-agent you started (session ${req.sessionId}) wants to call the tool "${req.name}" and needs your approval.`,
      `Why it needs approval: ${req.reason}`,
      `Arguments:\n${args.length > 4000 ? `${args.slice(0, 4000)}\n[...]` : args}`,
      "Reply with APPROVE or DENY on the first line, then one short sentence with your reason.",
    ].join("\n\n")
    let reply: AssistantMessage | undefined
    let failure: string | undefined
    for await (const ev of this.#opts.ai.stream(
      {
        model: parent.model,
        systemPrompt: renderPrompt([...parent.sections]),
        messages: [...forkHistory(parent.messages), userMessage(question)],
        tools: [],
      },
      signal,
    )) {
      if (ev.type === "done") reply = ev.message
      if (ev.type === "error") failure = ev.error.message
    }
    if (reply?.usage) this.recordUsage(parent, reply.usage)
    if (!reply) return { approved: false, reason: `the parent could not decide: ${failure ?? "no reply"}` }
    const text = finalText([reply])
    const verdict = /\b(APPROVE|DENY)\b/i.exec(text)?.[1]?.toUpperCase()
    const why = text.replace(/^[^\n]*\n?/, "").trim()
    return verdict === "APPROVE"
      ? { approved: true }
      : { approved: false, reason: `the parent agent denied it${why ? `: ${why}` : ""}` }
  }
}

function standardSections(cwd: string): PromptSection[] {
  return defaultSections({ cwd, project: instructionsSection(loadInstructions(cwd)) })
}

function metaOf(agent: Agent): EmitMeta {
  const meta: EmitMeta = { sessionId: agent.sessionId }
  if (agent.parentSessionId) meta.parentSessionId = agent.parentSessionId
  if (agent.turnId) meta.turnId = agent.turnId
  return meta
}
