import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import {
  type Ai,
  type AssistantMessage,
  emptyUsage,
  type JSONSchema,
  type Message,
  type ModelInfo,
  addUsage as sumUsage,
  type Usage,
  type UserMessage,
  unansweredCalls,
  userMessage,
} from "@amira/ai"
import {
  type AnyEvent,
  type ApprovalRequest,
  type AskAnswer,
  type AskOutcome,
  type AskQuestion,
  type AskRequest,
  type Budget,
  type ChildSession,
  type ChildState,
  fallbackTitle,
  MAX_TITLE_CHARS,
  type PendingNotice,
  RETURN_RESULT_TOOL,
  type SpawnContext,
  type SpawnGroup,
  type SpawnGroupInfo,
  type SpawnGroupOptions,
  type SpawnGroupState,
  type SpawnOptions,
  type SubagentInfo,
  type SubagentResult,
  type SubagentStatus,
  type ToolDefinition,
  textResult,
} from "@amira/api"
import { Agent, type ApprovalDecision, type TurnResult } from "./agent.ts"
import type { CompactionOptions } from "./compaction.ts"
import type { ContextOptions } from "./context.ts"
import type { EmitMeta } from "./event-bus.ts"
import { instructionsSection, loadInstructions } from "./instructions.ts"
import { validateValue } from "./json-schema.ts"
import { addNonInteractive, defaultSections, type PromptSection, renderPrompt, setSection } from "./prompt.ts"
import { SessionStore } from "./session-store.ts"
import { ToolRegistry } from "./tool-registry.ts"

/**
 * A sub-agent a tree started, as `AgentTree.subagent` gives it. A running one comes with its
 * live conversation and session; a finished one keeps its session's file, or, without one,
 * a copy of its conversation.
 */
export interface SpawnedSubagent {
  info: SubagentInfo
  /** The live array while it runs; copy it to keep a snapshot. */
  messages?: readonly Message[]
  session?: SessionStore
  file?: string
}

/** spawn refused: too deep, budget spent, a group's limit reached or an unknown model. */
export class SpawnError extends Error {}

export interface AgentTreeOptions {
  ai: Ai
  /** Deepest a sub-agent may be (D15). Default 2: children and grandchildren. */
  maxDepth?: number
  /**
   * Sub-agents of the whole tree working at once, not counting those waiting for children of
   * their own; the rest wait in order (D63). Default 4.
   */
  maxConcurrent?: number
  /** Shared by every session of the tree (D37). Default: unlimited. */
  budget?: Budget
  /**
   * How often a child spawned with a `schema` is asked again when a turn ends without a
   * valid result (a call with a value that does not fit counts too). Default 2.
   */
  resultRetries?: number
  /** System prompt of a fresh child working in `cwd`. Default: the standard sections with that directory's instructions. */
  sections?: (cwd: string) => PromptSection[]
  compaction?: CompactionOptions
  /** Context management options for every child (settings `context`). */
  context?: ContextOptions
  maxParallelTools?: number
}

/** All tokens a reply used, cache included: what a token budget counts. */
export function usageTokens(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite
}

function addUsage(to: Usage, u: Usage) {
  const sum = sumUsage(to, u)
  if (sum.cost === undefined) delete to.cost
  if (sum.webSearchCost === undefined) delete to.webSearchCost
  Object.assign(to, sum)
}

/** Why `used` is over `limit`, if it is. */
function overBudget(used: Usage, limit: Budget | undefined): string | undefined {
  if (!limit) return undefined
  const tokens = usageTokens(used)
  if (limit.tokens !== undefined && tokens > limit.tokens)
    return `${tokens} tokens used, limit ${limit.tokens}`
  if (limit.costUsd !== undefined && used.cost !== undefined && used.cost > limit.costUsd) {
    return `$${used.cost.toFixed(4)} spent, limit $${limit.costUsd}`
  }
  return undefined
}

/**
 * The parent's conversation as a child's starting point (context "fork"). The parent is in
 * the middle of a tool call, so calls without a result are dropped; an assistant message left
 * without content gets a placeholder so roles keep alternating for every provider.
 */
export function forkHistory(messages: readonly Message[]): Message[] {
  const unanswered = unansweredCalls(messages)
  return messages.map((m) => {
    if (m.role !== "assistant") return m
    const content = m.content.filter((b) => b.type !== "toolCall" || !unanswered.has(b))
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

/** What a child spawned with a schema is asked for, and what it handed back so far. */
interface ResultSpec {
  schema: JSONSchema
  /** The schema is not an object's: the tool takes it as `{ value }`. */
  wrapped: boolean
  /**
   * Attempts that failed: a call whose value did not fit, or a turn that ended without any
   * such call and without a valid result. One turn with a bad call counts once, not twice.
   */
  strikes: number
  /** The turn running now already counted a call that did not fit. */
  struck?: boolean
  /** The last reason an attempt failed. */
  problem?: string
  returned?: { value: unknown }
  /** No attempts are left. */
  failed?: boolean
}

function isObjectSchema(schema: JSONSchema): boolean {
  return schema.type === "object" || (schema.type === undefined && typeof schema.properties === "object")
}

class Child implements ChildSession {
  readonly id: string
  readonly parentSessionId: string
  readonly depth: number
  readonly cwd: string
  readonly usage = emptyUsage()
  state: ChildState = "queued"
  turns = 0
  /** Set once aborted: why. */
  abortReason: string | undefined
  /** Set once a persistent child was asked to end cleanly: why. */
  stopReason: string | undefined
  /** Why it ended early without failing, e.g. its turn limit. */
  note: string | undefined
  /** Given a place to run (it starts a microtask later). */
  admitted = false
  started = false
  /** When its turn started, in ms since the epoch. */
  startedAt: number | undefined
  /** Set once it ended. */
  ended: SubagentResult | undefined
  /** Ends the wait it is in (idle, or queued for its next turn), for a stop or an abort. */
  waiting: (() => void) | undefined
  result$: ResultSpec | undefined
  #result: Promise<SubagentResult>
  settle!: (r: SubagentResult) => void

  constructor(
    readonly agent: Agent,
    readonly role: string | undefined,
    readonly title: string,
    readonly toolCallId: string | undefined,
    readonly prompt: string,
    readonly context: SpawnContext,
    /** Who its subagent.end is sent as: its parent, with the grandparent if there is one. */
    readonly parentMeta: EmitMeta,
    private tree: AgentTree,
    readonly persistent: boolean,
    readonly maxTurns: number | undefined,
    /** Its own group first, then the groups that one is part of. */
    readonly groups: Group[],
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

  get groupId(): string | undefined {
    return this.groups[0]?.id
  }

  get pendingNotices(): number {
    if (this.ended) return 0
    return this.agent.expectedNotices + this.agent.waitingNotices
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

  stop(reason = "stopped"): void {
    this.tree.stopChild(this, reason)
  }

  send(message: string | UserMessage): boolean {
    if (!this.persistent || this.ended || this.stopReason || this.abortReason) return false
    this.agent.expectNotice().deliver(typeof message === "string" ? userMessage(message) : message)
    return true
  }

  expectNotice(): PendingNotice {
    if (!this.persistent) throw new Error("only a persistent sub-agent can be sent messages")
    return this.agent.expectNotice()
  }
}

/** A spawn group (SpawnGroup): limits and usage of the children started through it. */
class Group implements SpawnGroup {
  readonly id = `g_${crypto.randomUUID().slice(0, 8)}`
  readonly usage = emptyUsage()
  state: SpawnGroupState = "active"
  /** Children started in all. */
  total = 0
  /** Its children (and theirs) that have not ended. */
  readonly live = new Set<Child>()
  endReason: string | undefined
  exceeded = false
  /** The owner's line about what the group is doing (setStatus). */
  status: string | undefined
  #ended: Promise<SpawnGroupInfo>
  settle!: (info: SpawnGroupInfo) => void

  constructor(
    readonly name: string,
    readonly parent: Agent,
    /** The group the creating session belongs to: this one's children count against it too. */
    readonly outer: Group | undefined,
    readonly limits: Omit<SpawnGroupOptions, "name" | "compact">,
    readonly compact: boolean,
    private tree: AgentTree,
    /** Set on the children it spawns, e.g. the tool call that created the group. */
    private defaults: { toolCallId?: string },
  ) {
    this.#ended = new Promise((resolve) => {
      this.settle = resolve
    })
  }

  /** This group and the groups it is part of. */
  get chain(): Group[] {
    const out: Group[] = []
    for (let g: Group | undefined = this; g; g = g.outer) out.push(g)
    return out
  }

  spawn(opts: SpawnOptions): ChildSession {
    const toolCallId = opts.toolCallId ?? this.defaults.toolCallId
    return this.tree.spawn(this.parent, { ...opts, ...(toolCallId ? { toolCallId } : {}) }, this)
  }

  info(): SpawnGroupInfo {
    const agents = { total: this.total, queued: 0, working: 0, idle: 0, ended: this.total - this.live.size }
    for (const c of this.live) agents[c.state]++
    return {
      id: this.id,
      name: this.name,
      parentSessionId: this.parent.sessionId,
      state: this.state,
      limits: structuredClone(this.limits),
      ...(this.compact ? { compact: true } : {}),
      ...(this.status ? { status: this.status } : {}),
      usage: { ...this.usage },
      tokens: usageTokens(this.usage),
      agents,
      ...(this.endReason !== undefined ? { endReason: this.endReason } : {}),
      ...(this.exceeded ? { exceeded: true } : {}),
    }
  }

  setStatus(text: string): void {
    const line = text.replace(/\s+/g, " ").trim() || undefined
    if (line === this.status || this.state === "ended") return
    this.status = line
    this.parent.bus.emit("group.update", { group: this.info() }, metaOf(this.parent))
  }

  children(): ChildSession[] {
    return [...this.live]
  }

  end(reason = "ended by its owner"): void {
    this.tree.endGroup(this, reason)
  }

  ended(): Promise<SpawnGroupInfo> {
    return this.#ended
  }
}

/**
 * One agent tree (D12, D15): starts sub-agents as real sessions under their parent, bubbles
 * their events (they share the parent's bus and carry parentSessionId), limits nesting and
 * concurrency, and keeps the budget every session of the tree spends from. Spawn groups carve
 * limits of their own out of it; persistent children live across turns.
 */
export class AgentTree {
  readonly maxDepth: number
  readonly maxConcurrent: number
  readonly budget: Budget | undefined
  readonly resultRetries: number
  #opts: AgentTreeOptions
  #total = emptyUsage()
  /** Why the budget is spent, once it is. */
  #exceeded: string | undefined
  #live = new Map<string, Child>()
  /** Every child this tree started, finished ones too, in spawn order. */
  #spawned = new Map<string, Child | SpawnedSubagent>()
  /** Children waiting for a place to run, in order, with what starts them. */
  #queue: { child: Child; go: () => void }[] = []
  /** Children whose turn is running (or about to start). */
  #running = new Set<Child>()
  /** How many queued or running children each session has; sessions without any are left out. */
  #liveKids = new Map<string, number>()
  /** The last approval question queued for each parent, by its session id. */
  #asking = new Map<string, Promise<unknown>>()
  #groups = new Map<string, Group>()

  constructor(opts: AgentTreeOptions) {
    this.#opts = opts
    this.maxDepth = Math.max(0, opts.maxDepth ?? 2)
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 4)
    this.budget = opts.budget
    this.resultRetries = Math.max(0, opts.resultRetries ?? 2)
  }

  /** What the whole tree has used so far. */
  get usage(): Readonly<Usage> {
    return this.#total
  }

  /** Children that are queued, running or idle, oldest first. */
  get children(): ChildSession[] {
    return [...this.#live.values()]
  }

  /** Ids of the sub-agents `parentSessionId` started in this process, finished ones too, in spawn order. */
  childrenOf(parentSessionId: string): string[] {
    return [...this.#spawned.entries()]
      .filter(
        ([, c]) => (c instanceof Child ? c.parentSessionId : c.info.parentSessionId) === parentSessionId,
      )
      .map(([id]) => id)
  }

  /**
   * A sub-agent this tree started, running or finished: what it is doing and its
   * conversation so far (the live array while it runs; copy it to keep a snapshot).
   */
  subagent(id: string): SpawnedSubagent | undefined {
    const c = this.#spawned.get(id)
    if (!c) return undefined
    if (!(c instanceof Child)) return { ...c }
    const r = c.ended
    const status = r
      ? r.status
      : c.state === "idle"
        ? "idle"
        : c.started && c.state !== "queued"
          ? "running"
          : "queued"
    const info: SubagentInfo = {
      id: c.id,
      parentSessionId: c.parentSessionId,
      depth: c.depth,
      role: c.role ?? "agent",
      title: c.title,
      ...(c.toolCallId ? { toolCallId: c.toolCallId } : {}),
      task: c.prompt,
      status,
      model: c.model,
      ...(c.startedAt !== undefined ? { startedAt: c.startedAt } : {}),
      ...(r ? { durationMs: r.durationMs } : {}),
      usage: { ...c.usage },
      ...(r?.error !== undefined ? { error: r.error } : {}),
      ...(r?.note !== undefined ? { note: r.note } : {}),
      ...(c.persistent ? { persistent: true, turns: c.turns } : {}),
      ...(c.groupId ? { groupId: c.groupId } : {}),
    }
    return { info, messages: c.agent.messages, ...(c.agent.session ? { session: c.agent.session } : {}) }
  }

  /** The tree's spawn groups, active and ended, oldest first. */
  groups(): SpawnGroupInfo[] {
    return [...this.#groups.values()].map((g) => g.info())
  }

  /** A spawn group by id. */
  group(id: string): SpawnGroup | undefined {
    return this.#groups.get(id)
  }

  /**
   * Creates a spawn group whose children are `parent`'s. A budget over what the tree has left
   * is cut down to that; a parent that is itself in a group makes the new one part of it.
   */
  createGroup(parent: Agent, opts: SpawnGroupOptions, defaults: { toolCallId?: string } = {}): SpawnGroup {
    if (this.#exceeded) throw new SpawnError(`the agent tree's budget is spent (${this.#exceeded})`)
    const outer = this.#live.get(parent.sessionId)?.groups[0]
    if (outer && outer.state !== "active") throw new SpawnError(`the group "${outer.name}" has ended`)
    const limits: Omit<SpawnGroupOptions, "name" | "compact"> = {}
    for (const key of ["maxConcurrent", "maxAgents", "maxTurnsPerAgent"] as const) {
      const n = opts[key]
      if (n !== undefined) limits[key] = Math.max(1, Math.floor(n))
    }
    const budget = this.#carve(opts.budget)
    if (budget) limits.budget = budget
    const name = opts.name.replace(/\s+/g, " ").trim() || "group"
    const group = new Group(name, parent, outer, limits, opts.compact === true, this, defaults)
    this.#groups.set(group.id, group)
    parent.bus.emit("group.start", { group: group.info() }, metaOf(parent))
    return group
  }

  /** A group's budget within what the tree has left. */
  #carve(asked: Budget | undefined): Budget | undefined {
    if (!asked) return undefined
    const out: Budget = {}
    const limit = this.budget
    if (asked.tokens !== undefined) {
      const left = limit?.tokens !== undefined ? limit.tokens - usageTokens(this.#total) : Infinity
      out.tokens = Math.max(0, Math.min(asked.tokens, left))
    }
    if (asked.costUsd !== undefined) {
      const left = limit?.costUsd !== undefined ? limit.costUsd - (this.#total.cost ?? 0) : Infinity
      out.costUsd = Math.max(0, Math.min(asked.costUsd, left))
    }
    return out
  }

  spawn(parent: Agent, opts: SpawnOptions, group?: Group): ChildSession {
    if (this.#exceeded) throw new SpawnError(`the agent tree's budget is spent (${this.#exceeded})`)
    const depth = parent.depth + 1
    if (depth > this.maxDepth) {
      throw new SpawnError(
        `sub-agents can nest at most ${this.maxDepth} level${this.maxDepth === 1 ? "" : "s"} deep`,
      )
    }
    if (opts.schema && opts.persistent) {
      throw new SpawnError("a persistent sub-agent cannot have a result schema")
    }
    // A member's own children count against its group.
    const own = group ?? this.#live.get(parent.sessionId)?.groups[0]
    const groups = own?.chain ?? []
    for (const g of groups) {
      if (g.state !== "active") throw new SpawnError(`the group "${g.name}" has ended`)
      const max = g.limits.maxAgents
      if (max !== undefined && g.total >= max) {
        throw new SpawnError(
          `the group "${g.name}" has started its limit of ${max} sub-agent${max === 1 ? "" : "s"}`,
        )
      }
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
    const persistent = opts.persistent === true
    let base = context === "fork" ? [...parent.sections] : (this.#opts.sections ?? standardSections)(cwd)
    if (parent.nonInteractive) base = addNonInteractive(base)
    const extra = opts.extraTools ?? []
    if (extra.some((t) => t.name === RETURN_RESULT_TOOL)) {
      throw new SpawnError(`an extra tool cannot be named ${RETURN_RESULT_TOOL}`)
    }
    // A sub-agent never gets a tool only top-level sessions may have (D81), not even as its own.
    const mainOnly = extra.find((t) => t.mainOnly)
    if (mainOnly) throw new SpawnError(`${mainOnly.name} is for top-level sessions only`)
    const allow = opts.tools ? new Set(opts.tools) : undefined
    const deny = new Set(opts.excludeTools ?? [])
    // A parent's own tools (its return_result, its extra tools) are its own: never passed down.
    deny.add(RETURN_RESULT_TOOL)
    for (const name of parent.tools.ownNames()) deny.add(name)
    const spec: ResultSpec | undefined = opts.schema
      ? { schema: opts.schema, wrapped: !isObjectSchema(opts.schema), strikes: 0 }
      : undefined
    if (spec) base = setSection(base, "result", resultInstructions())
    const store = parent.session
      ? SessionStore.create({
          cwd,
          parent: parent.sessionId,
          dir: path.join(path.dirname(parent.session.file), "subagents"),
        })
      : undefined
    const turnLimits = [opts.maxTurns, ...groups.map((g) => g.limits.maxTurnsPerAgent)].filter(
      (n): n is number => n !== undefined,
    )
    const maxTurns = persistent && turnLimits.length ? Math.max(1, Math.min(...turnLimits)) : undefined
    // Set once the child exists; the agent's callbacks only run after that.
    let child!: Child
    const agent = new Agent({
      ai: this.#opts.ai,
      model,
      cwd,
      providerSettings: parent.providerSettings,
      fileRewindSettings: parent.fileRewindSettings,
      // A child whose directory overlaps the parent's writes the same files: one journal, one
      // restore. Worktrees live elsewhere and keep their own until their merge is captured.
      ...(overlaps(cwd, parent.cwd) ? { fileRewind: parent.fileRewind } : {}),
      sections: setSection(base, "role", opts.systemPrompt ?? ""),
      messages: context === "fork" ? forkHistory(parent.messages) : [],
      // A forked history may hold a server checkpoint only the parent's model reads; a child on
      // another model then writes a text summary from what the parent still knows it stood for.
      ...(context === "fork" ? { originals: (m: Message) => parent.compactedHistory(m) } : {}),
      // A fork's requests send its inherited results as the parent's did.
      ...(context === "fork" ? { views: parent.contextViews } : {}),
      // A child may be pointed at its parent's artifacts (in its task, or in a forked history).
      outputsParent: parent.artifacts,
      bus: parent.bus,
      interceptors: parent.interceptors,
      tools: ToolRegistry.view(
        parent.tools,
        // Tools only top-level sessions get (ToolDefinition.mainOnly) never reach a child.
        (n) => (allow?.has(n) ?? true) && !deny.has(n) && parent.tools.get(n)?.mainOnly !== true,
        [...extra, ...(spec ? [returnResultTool(spec, this.resultRetries)] : [])],
      ),
      ...(store ? { session: store } : {}),
      parentSessionId: parent.sessionId,
      depth,
      tree: this,
      ...(parent.backgroundJobsHost ? { backgroundJobs: parent.backgroundJobsHost } : {}),
      // The parent's permission policy, mode and rules, with the user who answers its questions:
      // the policy's questions skip the parent's model and go to the user (Agent).
      permissions: parent.permissions,
      ...(parent.permissionApprover ? { permissionApprover: parent.permissionApprover } : {}),
      approve: (request, signal) => this.#askParent(parent, request, signal),
      ask: (request, signal) => this.#askParentQuestions(parent, request, signal),
      ...(this.#opts.compaction ? { compaction: this.#opts.compaction } : {}),
      ...(this.#opts.context ? { context: this.#opts.context } : {}),
      ...(this.#opts.maxParallelTools ? { maxParallelTools: this.#opts.maxParallelTools } : {}),
      // The tree runs a child's turns, and a failed turn ends it: nothing is ever sent again
      // later by itself (that would start a turn in a child that already ended).
      noticeRetryMs: [],
      ...(persistent
        ? {
            // Only an idle child is woken: a queued one waits for its place as it is.
            onIdleNotice: () => {
              if (child.state === "idle") child.waiting?.()
            },
          }
        : {}),
      ...(spec ? { endTurn: () => this.#checkResult(child, spec) } : {}),
    })
    const given = opts.title?.replace(/\s+/g, " ").trim()
    const title = !given
      ? fallbackTitle(opts.prompt)
      : given.length > MAX_TITLE_CHARS
        ? `${given.slice(0, MAX_TITLE_CHARS - 1)}…`
        : given
    parent.recordSubagent(agent.sessionId, opts.role, title)
    child = new Child(
      agent,
      opts.role,
      title,
      opts.toolCallId,
      opts.prompt,
      context,
      parentMeta(parent),
      this,
      persistent,
      maxTurns,
      groups,
    )
    child.result$ = spec
    this.#live.set(child.id, child)
    this.#spawned.set(child.id, child)
    this.#liveKids.set(parent.sessionId, (this.#liveKids.get(parent.sessionId) ?? 0) + 1)
    for (const g of groups) {
      g.total++
      g.live.add(child)
    }
    this.#queue.push({ child, go: () => void this.#run(child) })
    // A parent with children is waiting for them, so it stops counting against the limit.
    this.#admit()
    const queued = !child.admitted
    parent.bus.emit(
      "subagent.start",
      {
        childSessionId: child.id,
        ...(opts.role ? { role: opts.role } : {}),
        title,
        ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
        prompt: opts.prompt,
        model: child.model,
        depth,
        cwd,
        context,
        queued,
        ...(persistent ? { persistent: true } : {}),
        ...(child.groupId ? { groupId: child.groupId } : {}),
      },
      metaOf(parent),
    )
    this.#groupsChanged(child)
    return child
  }

  /** Busy children: running a turn, and not just waiting for children of their own. */
  #busy(among: Iterable<Child>): number {
    let n = 0
    for (const c of among) if (this.#running.has(c) && !this.#liveKids.has(c.id)) n++
    return n
  }

  /**
   * Starts queued children, oldest first, while fewer than maxConcurrent are busy tree-wide
   * (D63) and in each of their groups. A running child that has children of its own is not
   * busy: it waits for them, and counting it could leave its children queued forever behind
   * it. A child whose group is full waits without holding up those behind it.
   */
  #admit() {
    let busy = this.#busy(this.#running)
    for (let i = 0; i < this.#queue.length && busy < this.maxConcurrent; ) {
      const entry = this.#queue[i]!
      const full = entry.child.groups.some(
        (g) => g.limits.maxConcurrent !== undefined && this.#busy(g.live) >= g.limits.maxConcurrent,
      )
      if (full) {
        i++
        continue
      }
      this.#queue.splice(i, 1)
      entry.child.admitted = true
      this.#running.add(entry.child)
      busy++
      // Started a microtask later, so the caller can subscribe to child.events first.
      queueMicrotask(entry.go)
    }
  }

  /** Adds a reply's usage to the tree and its groups, reports it, and stops what went over budget. */
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
    for (const g of child?.groups ?? []) {
      addUsage(g.usage, usage)
      const over = g.state === "active" ? overBudget(g.usage, g.limits.budget) : undefined
      if (over) {
        g.exceeded = true
        this.endGroup(g, `the group "${g.name}" ran out of budget (${over})`)
      }
    }
    if (child) this.#groupsChanged(child)
    if (this.#exceeded || !limit) return
    const over = overBudget(this.#total, limit)
    if (!over) return
    this.#exceeded = over
    agent.bus.emit(
      "budget.exceeded",
      { tokens, ...(costUsd !== undefined ? { costUsd } : {}), limit },
      metaOf(agent),
    )
    this.abortAll(`the agent tree's budget ran out (${over})`)
  }

  /**
   * Ends a group: stops its idle persistent children, aborts the others with `reason`, and
   * refuses later spawns. It is `ending` until the last of them finished, then `ended`.
   */
  endGroup(group: Group, reason: string): void {
    if (group.state !== "active") return
    group.state = "ending"
    group.endReason = reason
    for (const c of [...group.live]) {
      if (c.state === "idle") this.stopChild(c, reason)
      else this.abortChild(c, reason)
    }
    this.#settleGroup(group)
  }

  /** Emits the group.update of every group `child` counts against, and ends those whose last child ended. */
  #groupsChanged(child: Child) {
    for (const g of child.groups) {
      if (g.state === "ended") continue
      g.parent.bus.emit("group.update", { group: g.info() }, metaOf(g.parent))
      this.#settleGroup(g)
    }
  }

  #settleGroup(group: Group) {
    if (group.state !== "ending" || group.live.size) return
    group.state = "ended"
    const info = group.info()
    group.parent.bus.emit("group.end", { group: info }, metaOf(group.parent))
    group.settle(info)
  }

  /** Aborts one live child by id; false when it is not live. */
  stop(id: string, reason: string): boolean {
    const child = this.#live.get(id)
    if (!child || child.abortReason) return false
    this.abortChild(child, reason)
    return true
  }

  /** Delivers a message to a live persistent child by id (as ChildSession.send); false for any other. */
  deliver(sessionId: string, message: string | UserMessage): boolean {
    const child = this.#live.get(sessionId)
    return child ? child.send(message) : false
  }

  /** Ends every group and aborts every live child. */
  abortAll(reason: string): void {
    for (const g of this.#groups.values()) this.endGroup(g, reason)
    for (const child of [...this.#live.values()]) this.abortChild(child, reason)
  }

  abortChild(child: Child, reason: string): void {
    if (!this.#live.has(child.id) || child.abortReason) return
    child.abortReason = reason
    if (child.started) {
      child.agent.abort()
      child.waiting?.()
      return
    }
    this.#queue = this.#queue.filter((e) => e.child !== child)
    this.#finish(child, { status: "aborted", error: reason, steps: 0, durationMs: 0 })
  }

  /** Ends a persistent child cleanly: at once while idle or queued, after its running turn otherwise. */
  stopChild(child: Child, reason: string): void {
    if (!child.persistent || !this.#live.has(child.id) || child.abortReason || child.stopReason) return
    child.stopReason = reason
    if (child.started) {
      child.waiting?.()
      return
    }
    this.#queue = this.#queue.filter((e) => e.child !== child)
    child.note = reason
    this.#finish(child, { status: "done", steps: 0, durationMs: 0 })
  }

  /**
   * Events of the child and its descendants, ending with the child's subagent.end. Subscribes
   * when iteration starts; a child that already ended yields nothing.
   */
  eventsOf(child: Child): AsyncIterable<AnyEvent> {
    return { [Symbol.asyncIterator]: () => this.#follow(child) }
  }

  #follow(child: Child): AsyncIterator<AnyEvent> {
    const queue: AnyEvent[] = []
    // Descendants join as their subagent.start comes by, which is before any of their events.
    const members = new Set([child.id])
    let ended = !this.#live.has(child.id)
    let wake: (() => void) | undefined
    const off = ended
      ? () => {}
      : child.agent.bus.subscribe((e) => {
          if (ended) return
          const end = e.type === "subagent.end" && e.data.childSessionId === child.id
          const own = e.type === "subagent.state" && e.data.childSessionId === child.id
          if (!end && !own && !members.has(e.sessionId)) return
          if (e.type === "subagent.start") members.add(e.data.childSessionId)
          queue.push(e)
          if (end) {
            ended = true
            off()
          }
          wake?.()
        })
    return {
      async next() {
        while (true) {
          const e = queue.shift()
          if (e) return { value: e, done: false }
          if (ended) return { value: undefined, done: true }
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          wake = undefined
        }
      },
      async return() {
        ended = true
        queue.length = 0
        off()
        wake?.()
        return { value: undefined, done: true }
      },
    }
  }

  /**
   * Moves a child to `state`; a persistent one says so with subagent.state (also, with
   * `turnStarted`, when it stays working for another turn).
   */
  #setState(child: Child, state: ChildState, turnStarted = false) {
    if (child.state === state && !turnStarted) return
    child.state = state
    if (child.persistent && state !== "ended") {
      child.agent.bus.emit(
        "subagent.state",
        { childSessionId: child.id, state, turns: child.turns },
        child.parentMeta,
      )
    }
    this.#groupsChanged(child)
  }

  /**
   * Runs one turn of `child` (with `input`, or with the messages sent to it), and the turns
   * that follow by themselves (messages steered in as it ended), counting each.
   */
  async #turn(child: Child, input?: string | UserMessage): Promise<TurnResult> {
    if (child.abortReason) return { reason: "aborted", steps: 0 }
    const agent = child.agent
    if (input === undefined && !agent.waitingNotices) return { reason: "done", steps: 0 }
    child.turns++
    this.#setState(child, "working", true)
    const first = input !== undefined ? agent.prompt(input) : agent.wake()
    if (!first) return { reason: "done", steps: 0 }
    let r = await first
    let steps = r.steps
    for (let next = agent.currentTurn; next; next = agent.currentTurn) {
      child.turns++
      this.#setState(child, "working", true)
      r = await next
      steps += r.steps
    }
    return { ...r, steps }
  }

  /** Waits for a place to run the child's next turn; a stop or an abort ends the wait too. */
  #acquire(child: Child): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry = { child, go: resolve }
      child.waiting = () => {
        this.#queue = this.#queue.filter((e) => e !== entry)
        resolve()
      }
      this.#queue.push(entry)
      this.#admit()
    }).finally(() => {
      child.waiting = undefined
    })
  }

  /** Runs a child: its turn, the retries for its result, and a persistent one's later turns. */
  async #run(child: Child) {
    const startedAt = performance.now()
    let steps = 0
    let status: SubagentStatus = "error"
    let error: string | undefined
    try {
      if (child.abortReason) status = "aborted"
      else {
        child.started = true
        child.startedAt = Date.now()
        child.agent.start(child.context === "fork" ? "fork" : "startup")
        let r = await this.#turn(child, child.prompt)
        steps += r.steps
        const spec = child.result$
        while (spec && r.reason === "done" && !spec.returned && !spec.failed && !child.abortReason) {
          // endTurn counted a call that did not fit; a turn that ended without any counts here.
          if (!this.#checkResult(child, spec, true) && !spec.failed) {
            r = await this.#turn(child, resultReminder(spec))
            steps += r.steps
          }
        }
        while (child.persistent && r.reason === "done" && !child.abortReason && !child.stopReason) {
          if (child.maxTurns !== undefined && child.turns >= child.maxTurns) {
            child.note = `reached its limit of ${child.maxTurns} turn${child.maxTurns === 1 ? "" : "s"}`
            break
          }
          if (!child.agent.waitingNotices) {
            // Idle: its place goes to the next child until a message comes.
            this.#running.delete(child)
            this.#setState(child, "idle")
            this.#admit()
            await new Promise<void>((resolve) => {
              child.waiting = resolve
            })
            child.waiting = undefined
            if (child.abortReason || child.stopReason) break
            this.#setState(child, "queued")
            await this.#acquire(child)
            if (child.abortReason || child.stopReason) break
          }
          r = await this.#turn(child)
          steps += r.steps
        }
        status = r.reason
        error = r.error
        // A one-shot child whose last reply came in as it was aborted (say, the reply that
        // spent the budget) still finished its task; a persistent one, or one that owed a
        // result it never handed back, was cut short.
        if (child.abortReason && (status !== "done" || child.persistent || (spec && !spec.returned))) {
          status = "aborted"
        } else if (spec && status === "done" && !spec.returned) {
          status = "error"
          error = `it did not return a valid result after ${spec.strikes} attempt${spec.strikes === 1 ? "" : "s"}${spec.problem ? `: ${spec.problem}` : ""}`
        }
        if (status === "done" && child.stopReason) child.note = child.stopReason
      }
    } catch (err) {
      status = "error"
      error = err instanceof Error ? err.message : String(err)
    } finally {
      if (status === "aborted") error = child.abortReason ?? error
      this.#running.delete(child)
      this.#finish(child, {
        status,
        ...(error !== undefined ? { error } : {}),
        steps,
        durationMs: Math.round(performance.now() - startedAt),
      })
      this.#admit()
    }
  }

  /**
   * After a batch of tool calls (or, with `turnEnded`, after a turn) of a child that owes a
   * result: counts each return_result call that did not fit, and a turn that ended without
   * one, as a failed attempt. True once it has returned a valid result, which ends its turn.
   */
  #checkResult(child: Child, spec: ResultSpec, turnEnded = false): boolean {
    if (spec.returned) return true
    const limit = this.resultRetries + 1
    if (turnEnded) {
      // A turn whose bad call was counted already is not counted again for ending without one.
      if (!spec.struck) {
        spec.strikes++
        spec.problem ??= `it ended its turn without calling ${RETURN_RESULT_TOOL}`
      }
      spec.struck = false
    } else {
      const messages = child.agent.messages
      const from = messages.findLastIndex((m) => m.role === "assistant")
      for (const m of messages.slice(from + 1)) {
        if (m.role === "toolResult" && m.toolName === RETURN_RESULT_TOOL && m.isError) {
          spec.strikes++
          spec.struck = true
          const text = m.content.map((b) => (b.type === "text" ? b.text : "")).join(" ")
          spec.problem = text.replace(/\s+/g, " ").trim().slice(0, 500)
        }
      }
    }
    if (spec.strikes >= limit) spec.failed = true
    // Out of attempts: the turn ends, and so does the child, with an error.
    return spec.failed === true
  }

  #finish(child: Child, r: Pick<SubagentResult, "status" | "error" | "steps" | "durationMs">) {
    if (!this.#live.delete(child.id)) return
    child.waiting = undefined
    child.agent.cancelNoticeRetry()
    // Messages sent to it that never reached its model: the sender learns which.
    const undelivered = child.agent.takeNotices()
    // Its own live sub-agents (and theirs) end with it: nobody is left to collect them.
    for (const c of [...this.#live.values()]) {
      if (c.parentSessionId === child.id) this.abortChild(c, "its parent ended")
    }
    const kids = (this.#liveKids.get(child.parentSessionId) ?? 1) - 1
    if (kids > 0) this.#liveKids.set(child.parentSessionId, kids)
    else this.#liveKids.delete(child.parentSessionId)
    const returned = r.status === "done" ? child.result$?.returned : undefined
    const turns = child.turns
    const result: SubagentResult = {
      sessionId: child.id,
      status: r.status,
      text: returned ? JSON.stringify(returned.value, null, 2) : finalText(child.agent.messages),
      ...(returned ? { value: returned.value } : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
      ...(child.note !== undefined && r.status !== "error" ? { note: child.note } : {}),
      ...(child.persistent || turns > 1 ? { turns } : {}),
      ...(undelivered.length ? { undelivered } : {}),
      usage: { ...child.usage },
      steps: r.steps,
      durationMs: r.durationMs,
    }
    child.state = "ended"
    child.agent.bus.emit(
      "subagent.end",
      {
        childSessionId: child.id,
        ...(child.toolCallId ? { toolCallId: child.toolCallId } : {}),
        status: result.status,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.note !== undefined ? { note: result.note } : {}),
        ...(result.turns !== undefined ? { turns: result.turns } : {}),
        ...(undelivered.length ? { undelivered: undelivered.length } : {}),
        usage: result.usage,
        durationMs: result.durationMs,
      },
      child.parentMeta,
    )
    // The end event is delivered before cleanup so observers can still inspect the final live
    // state; no job owned by the child may survive the end of its session.
    void child.agent.backgroundJobsHost?.closeSession(child.id)
    child.ended = result
    // Keep what it did, not the session: one with a file is read back from it when asked for.
    const done = this.subagent(child.id) as SpawnedSubagent
    const stored = child.agent.session?.file
    const file = stored && existsSync(stored) ? stored : undefined
    this.#spawned.set(child.id, {
      info: done.info,
      ...(file ? { file } : { messages: [...child.agent.messages] }),
    })
    for (const g of child.groups) g.live.delete(child)
    this.#groupsChanged(child)
    child.settle(result)
  }

  /**
   * One question to a parent at a time: each is a call with the parent's whole context, and
   * children asking together would otherwise start that many such calls at once.
   */
  #askParent(parent: Agent, req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    return this.#oneAtATime(
      parent,
      signal,
      { approved: false, reason: "aborted before the parent was asked" },
      () => this.#consultParent(parent, req, signal),
    )
  }

  /** A child's questions (ask_user) go to its commander the same way, in the same line. */
  #askParentQuestions(parent: Agent, req: AskRequest, signal: AbortSignal): Promise<AskOutcome> {
    return this.#oneAtATime(parent, signal, { declined: true }, () =>
      this.#consultParentQuestions(parent, req, signal),
    )
  }

  async #oneAtATime<T>(parent: Agent, signal: AbortSignal, aborted: T, ask: () => Promise<T>): Promise<T> {
    const before = this.#asking.get(parent.sessionId) ?? Promise.resolve()
    // One aborted while it waits for its place leaves at once: the one before it may be a
    // question passed on to the user, open for minutes.
    let onAbort: (() => void) | undefined
    const abandoned = new Promise<T>((resolve) => {
      onAbort = () => resolve(aborted)
      signal.addEventListener("abort", onAbort, { once: true })
    })
    const inLine = before.then(() => {
      signal.removeEventListener("abort", onAbort!)
      return signal.aborted ? aborted : ask()
    })
    const mine = Promise.race([inLine, abandoned])
    // The next in line still waits for this one's model call to end, not only its abort.
    const tail = inLine.catch(() => {})
    this.#asking.set(parent.sessionId, tail)
    // The line ends when its last one is really done: one that left early (aborted) is still
    // waiting on those before it, and whoever asks next must too.
    void tail.then(() => {
      if (this.#asking.get(parent.sessionId) === tail) this.#asking.delete(parent.sessionId)
    })
    try {
      return await mine
    } finally {
      signal.removeEventListener("abort", onAbort!)
    }
  }

  /**
   * The parent's model answers a child's questions like it decides its approvals (D14): with
   * its conversation, without tools. It may answer them, decline, or reply ASK_USER to pass
   * them on to whoever answers for itself (the user, or its own commander).
   */
  async #consultParentQuestions(parent: Agent, req: AskRequest, signal: AbortSignal): Promise<AskOutcome> {
    const reply = await this.#consult(parent, askParentPrompt(req), signal)
    if (!reply.text) return { unavailable: `the commander could not answer: ${reply.failure ?? "no reply"}` }
    // The word on the first line, or alone on a line after some prose.
    const lines = reply.text.split("\n").map((l) => l.replace(/[*`\s.]/g, "").toUpperCase())
    const says = (word: string) => lines[0]?.startsWith(word) || lines.includes(word)
    if (says("ASK_USER")) return parent.askQuestions(req, signal)
    if (says("DECLINE")) return { declined: true, by: "the commander" }
    const answers = parseParentAnswers(req.questions, reply.text)
    return answers ? { answers, by: "the commander" } : { declined: true, by: "the commander" }
  }

  /** One call to the parent's model with its conversation and `question`, without tools. */
  async #consult(parent: Agent, question: string, signal: AbortSignal) {
    let reply: AssistantMessage | undefined
    let failure: string | undefined
    for await (const ev of this.#opts.ai.stream(
      {
        model: parent.model,
        systemPrompt: renderPrompt([...parent.sections]),
        // As the parent's own requests send its history (context management).
        messages: [...forkHistory(parent.projectedMessages()), userMessage(question)],
        tools: [],
      },
      signal,
    )) {
      if (ev.type === "done") reply = ev.message
      if (ev.type === "error") failure = ev.error.message
    }
    if (reply?.usage) this.recordUsage(parent, reply.usage)
    return { text: reply ? finalText([reply]) : undefined, failure }
  }

  /**
   * D14: a child's approval request goes to its parent's model, not to the user. It gets the
   * parent's conversation and the request, without tools, and must answer APPROVE or DENY.
   * Only interceptors' questions come here: the permission policy's go to the user (Agent).
   */
  async #consultParent(parent: Agent, req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const args = JSON.stringify(req.args, null, 2)
    const question = [
      `A sub-agent you started (session ${req.sessionId}) wants to call the tool "${req.name}" and needs your approval.`,
      `Why it needs approval: ${req.reason}`,
      `Arguments:\n${args.length > 4000 ? `${args.slice(0, 4000)}\n[...]` : args}`,
      "Reply with APPROVE or DENY on the first line, then one short sentence with your reason.",
    ].join("\n\n")
    const { text, failure } = await this.#consult(parent, question, signal)
    if (text === undefined)
      return { approved: false, reason: `the parent could not decide: ${failure ?? "no reply"}` }
    const verdict = /\b(APPROVE|DENY)\b/i.exec(text)?.[1]?.toUpperCase()
    const why = text.replace(/^[^\n]*\n?/, "").trim()
    return verdict === "APPROVE"
      ? { approved: true }
      : { approved: false, reason: `the parent agent denied it${why ? `: ${why}` : ""}` }
  }
}

/** A child's questions as its commander reads them, with how to answer. */
function askParentPrompt(req: AskRequest): string {
  const questions = req.questions.map((q, i) => {
    const how = q.multiSelect ? "choose any number" : "choose one"
    const options = q.options.map((o) => `   - ${o.label}${o.description ? `: ${o.description}` : ""}`)
    return [`${i + 1}. ${q.header ? `[${q.header}] ` : ""}${q.question} (${how})`, ...options].join("\n")
  })
  return [
    `A sub-agent working for you (session ${req.sessionId}) asks you ${req.questions.length === 1 ? "this question" : "these questions"} before it goes on:`,
    questions.join("\n\n"),
    [
      'Answer with one line per question, numbered like the questions: "1: <option label>". Where several may be chosen, separate the labels with " | ". When no option fits, write your own answer instead of a label.',
      "If the user should decide instead, reply with ASK_USER alone on the first line, and the questions go to the user. To refuse to answer, reply with DECLINE on the first line.",
    ].join(" "),
  ].join("\n\n")
}

/** Case, spacing, quotes and a "(Recommended)" mark do not matter when matching a label. */
const labelKey = (s: string) =>
  s
    .replace(/\(recommended\)/i, "")
    .replace(/^[\s"'`*_]+|[\s"'`*_.]+$/g, "")
    .toLowerCase()

/**
 * The commander's numbered answers ("1: label", "2: a | b", or its own words) as one answer
 * per question; undefined when a question has none. A single question may be answered by the
 * whole reply.
 */
export function parseParentAnswers(questions: AskQuestion[], text: string): AskAnswer[] | undefined {
  const byNumber = new Map<number, string>()
  for (const line of text.split("\n")) {
    const m = /^\s*(?:\*\*)?(\d+)(?:\*\*)?\s*[:.)-]\s*(.+)$/.exec(line)
    if (m && !byNumber.has(Number(m[1]))) byNumber.set(Number(m[1]), m[2]!.trim())
  }
  if (questions.length === 1 && !byNumber.has(1) && text.trim()) byNumber.set(1, text.trim())
  const answers: AskAnswer[] = []
  for (const [i, q] of questions.entries()) {
    const reply = byNumber.get(i + 1)
    if (!reply) return undefined
    const labels = new Map(q.options.map((o) => [labelKey(o.label), o.label]))
    const whole = labels.get(labelKey(reply))
    if (whole) {
      answers.push({ selected: [whole] })
      continue
    }
    const parts = q.multiSelect ? reply.split("|").map((p) => p.trim()) : [reply]
    const selected = parts.map((p) => labels.get(labelKey(p))).filter((l): l is string => l !== undefined)
    const rest = parts.filter((p) => !labels.has(labelKey(p)))
    answers.push({ selected: [...new Set(selected)], ...(rest.length ? { other: rest.join(" | ") } : {}) })
  }
  return answers
}

function resultInstructions(): string {
  return [
    "# Result",
    `When you have finished the task, hand back your result by calling the ${RETURN_RESULT_TOOL} tool; its parameters describe the result expected. Your turn ends with that call, so make it last, and do not also write the result out as text. If the call reports a problem, call it again with a corrected result.`,
  ].join("\n")
}

function resultReminder(spec: ResultSpec): UserMessage {
  const why = spec.problem ? ` (${spec.problem})` : ""
  return userMessage(
    `You have not handed back a valid result yet${why}. Call ${RETURN_RESULT_TOOL} now with your result, matching its parameters. (Sent automatically.)`,
    { text: `◆ asked again for its result${why}`, origin: "subagent" },
  )
}

/** The tool a child with a schema returns its result with; it checks the value fully. */
function returnResultTool(spec: ResultSpec, retries: number): ToolDefinition {
  const parameters: JSONSchema = spec.wrapped
    ? { type: "object", properties: { value: spec.schema }, required: ["value"] }
    : spec.schema
  return {
    name: RETURN_RESULT_TOOL,
    description:
      "Hands back the result of your task, as the parameters describe it. Call it once, when you are done; your turn ends with it.",
    parameters,
    traits: { readOnly: true },
    async execute(args) {
      const value = spec.wrapped ? (args as { value?: unknown }).value : args
      const problems = validateValue(spec.schema, value)
      if (problems.length) {
        const left = retries + 1 - (spec.strikes + 1)
        return textResult(
          `The result does not fit: ${problems.join("; ")}.${left > 0 ? ` Call ${RETURN_RESULT_TOOL} again with a corrected result.` : ""}`,
          true,
        )
      }
      spec.returned = { value: structuredClone(value) }
      return textResult("Result received.")
    },
  }
}

function standardSections(cwd: string): PromptSection[] {
  return defaultSections({ cwd, project: instructionsSection(loadInstructions(cwd)) })
}

/** A parent's ids without its turn: a child can end after the turn that started it. */
function parentMeta(parent: Agent): EmitMeta {
  const meta: EmitMeta = { sessionId: parent.sessionId }
  if (parent.parentSessionId) meta.parentSessionId = parent.parentSessionId
  return meta
}

function metaOf(agent: Agent): EmitMeta {
  const meta: EmitMeta = { sessionId: agent.sessionId }
  if (agent.parentSessionId) meta.parentSessionId = agent.parentSessionId
  if (agent.turnId) meta.turnId = agent.turnId
  return meta
}

/** One directory contains the other (or they are the same), by real path. */
function overlaps(a: string, b: string): boolean {
  const key = (p: string) => {
    let real = path.resolve(p)
    try {
      // A junction or link alias of the parent's directory is still the same files.
      real = realpathSync.native(real)
    } catch {}
    return process.platform === "win32" ? real.toLowerCase() : real
  }
  const inside = (child: string, root: string) => {
    const rel = path.relative(key(root), key(child))
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  }
  return inside(a, b) || inside(b, a)
}
