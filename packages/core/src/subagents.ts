import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import {
  type Ai,
  type AssistantMessage,
  type Message,
  type ModelInfo,
  type Usage,
  type UserMessage,
  userMessage,
} from "@amira/ai"
import {
  type AnyEvent,
  type ApprovalRequest,
  type AskOutcome,
  type AskRequest,
  type Budget,
  type ChildSession,
  type ChildState,
  fallbackTitle,
  MAX_TITLE_CHARS,
  RETURN_RESULT_TOOL,
  type SpawnContext,
  type SpawnGroup,
  type SpawnGroupInfo,
  type SpawnGroupOptions,
  type SpawnOptions,
  type SubagentInfo,
  type SubagentResult,
  type SubagentStatus,
} from "@amira/api"
import { Agent, type ApprovalDecision, type TurnResult } from "./agent.ts"
import type { CompactionOptions } from "./compaction.ts"
import type { ContextOptions } from "./context.ts"
import { instructionsSection, loadInstructions } from "./instructions.ts"
import { addNonInteractive, defaultSections, type PromptSection, renderPrompt, setSection } from "./prompt.ts"
import { SessionStore } from "./session-store.ts"
import { addUsage, BudgetLedger, overBudget, usageTokens } from "./subagents/budget.ts"
import { Child, Group, type SpawnedSubagent } from "./subagents/child.ts"
import { askParentPrompt, parseParentAnswers } from "./subagents/consult-parent.ts"
import { followChild, metaOf, parentMeta } from "./subagents/events.ts"
import { finalText, forkHistory } from "./subagents/fork.ts"
import {
  checkResult,
  isObjectSchema,
  type ResultSpec,
  resultInstructions,
  resultReminder,
  returnResultTool,
} from "./subagents/structured-result.ts"
import { ToolRegistry } from "./tool-registry.ts"

export type { SpawnedSubagent }
export { forkHistory, parseParentAnswers, usageTokens }

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

interface SpawnSetup {
  depth: number
  model: ModelInfo
  cwd: string
  context: SpawnContext
  persistent: boolean
  groups: Group[]
  base: PromptSection[]
  extra: NonNullable<SpawnOptions["extraTools"]>
  allow: Set<string> | undefined
  deny: Set<string>
  spec: ResultSpec | undefined
  store: SessionStore | undefined
  maxTurns: number | undefined
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
  #ledger: BudgetLedger
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
  /** Ended sub-agents whose dispose is still running, by session id. */
  #disposals = new Map<string, { parent: string; done: Promise<void> }>()

  constructor(opts: AgentTreeOptions) {
    this.#opts = opts
    this.maxDepth = Math.max(0, opts.maxDepth ?? 2)
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 4)
    this.budget = opts.budget
    this.#ledger = new BudgetLedger(opts.budget)
    this.resultRetries = Math.max(0, opts.resultRetries ?? 2)
  }

  /** What the whole tree has used so far. */
  get usage(): Readonly<Usage> {
    return this.#ledger.usage
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
      : c.agent.execution.paused
        ? "paused"
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
    if (this.#ledger.exceeded)
      throw new SpawnError(`the agent tree's budget is spent (${this.#ledger.exceeded})`)
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
    return this.#ledger.carve(asked)
  }

  spawn(parent: Agent, opts: SpawnOptions, group?: Group): ChildSession {
    const setup = this.#validateSpawn(parent, opts, group)
    // Set once the child exists; the agent's callbacks only run after that.
    let child!: Child
    const agent = this.#createAgent(parent, opts, setup, () => child)
    child = this.#registerSpawn(parent, opts, setup, agent)
    return child
  }

  #validateSpawn(parent: Agent, opts: SpawnOptions, group: Group | undefined): SpawnSetup {
    if (this.#ledger.exceeded)
      throw new SpawnError(`the agent tree's budget is spent (${this.#ledger.exceeded})`)
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
    return { depth, model, cwd, context, persistent, groups, base, extra, allow, deny, spec, store, maxTurns }
  }

  #createAgent(parent: Agent, opts: SpawnOptions, setup: SpawnSetup, getChild: () => Child): Agent {
    const { depth, model, cwd, context, persistent, base, extra, allow, deny, spec, store } = setup
    return new Agent({
      ai: this.#opts.ai,
      model,
      cwd,
      providerSettings: parent.providerSettings,
      thinking: parent.thinking.for(parent.model),
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
              const child = getChild()
              if (child.state === "idle") child.waiting?.()
            },
          }
        : {}),
      ...(spec ? { endTurn: () => checkResult(getChild().agent.messages, spec, this.resultRetries) } : {}),
    })
  }

  #registerSpawn(parent: Agent, opts: SpawnOptions, setup: SpawnSetup, agent: Agent): Child {
    const { depth, cwd, context, persistent, groups, spec, maxTurns } = setup
    const given = opts.title?.replace(/\s+/g, " ").trim()
    const title = !given
      ? fallbackTitle(opts.prompt)
      : given.length > MAX_TITLE_CHARS
        ? `${given.slice(0, MAX_TITLE_CHARS - 1)}…`
        : given
    parent.recordSubagent(agent.sessionId, opts.role, title)
    const child = new Child(
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
    for (const c of among)
      if (this.#running.has(c) && (c.agent.execution.paused || !this.#liveKids.has(c.id))) n++
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
    this.#ledger.add(usage)
    const child = this.#live.get(agent.sessionId)
    if (child) addUsage(child.usage, usage)
    const tokens = usageTokens(this.#ledger.usage)
    const costUsd = this.#ledger.usage.cost
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
    if (this.#ledger.exceeded || !limit) return
    const over = overBudget(this.#ledger.usage, limit)
    if (!over) return
    this.#ledger.markExceeded(over)
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

  /** Sends a user message without bypassing a child's admission or persistent wakeup. */
  message(id: string, text: string): boolean {
    return this.#live.get(id)?.message(text) ?? false
  }

  /** Holds a running child at its next call boundary, retaining its admission slot. */
  pause(id: string): boolean {
    return this.#live.get(id)?.pause() ?? false
  }

  /** Releases a user pause; it does not affect extension-level message holds. */
  resume(id: string): boolean {
    if (!this.#live.get(id)?.resume()) return false
    this.#admit()
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

  /** Aborts the children of one agent without disturbing its siblings. */
  abortChildren(parentSessionId: string, reason: string): void {
    for (const g of [...this.#groups.values()]) {
      if (g.parent.sessionId === parentSessionId) this.endGroup(g, reason)
    }
    for (const child of [...this.#live.values()]) {
      if (child.parentSessionId === parentSessionId) this.abortChild(child, reason)
    }
  }

  /**
   * Waits for the live and still-disposing descendants of `ancestor` (every sub-agent when
   * unset). A disposing child never waits for itself or for agents outside its own subtree.
   */
  async waitForChildren(ancestor?: string): Promise<void> {
    const parentOf = (id: string) => this.#live.get(id)?.parentSessionId ?? this.#disposals.get(id)?.parent
    const under = (id: string) => {
      for (let p = parentOf(id); ancestor !== undefined && p !== undefined; p = parentOf(p)) {
        if (p === ancestor) return true
      }
      return ancestor === undefined
    }
    for (;;) {
      const waits = [
        ...[...this.#live.values()].filter((c) => under(c.id)).map((c) => c.result()),
        ...[...this.#disposals].filter(([id]) => under(id)).map(([, d]) => d.done),
      ]
      if (!waits.length) return
      await Promise.allSettled(waits)
    }
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
    // A paused one runs its turn to the end first: it is working again, and screens hear so.
    if (child.resume()) this.#admit()
    child.stopReason = reason
    if (child.started) {
      child.waiting?.()
      return
    }
    this.#queue = this.#queue.filter((e) => e.child !== child)
    child.note = reason
    this.#finish(child, { status: "done", steps: 0, durationMs: 0 })
  }

  /** Events of a child and its descendants, ending with its subagent.end. */
  eventsOf(child: Child): AsyncIterable<AnyEvent> {
    return { [Symbol.asyncIterator]: () => followChild(child) }
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
          if (!checkResult(child.agent.messages, spec, this.resultRetries, true) && !spec.failed) {
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
    const disposing = child.agent.dispose("exit")
    this.#disposals.set(child.id, { parent: child.parentSessionId, done: disposing })
    void disposing.finally(() => this.#disposals.delete(child.id))
    // The end event is delivered before cleanup so observers can still inspect the final live
    // state; no job owned by the child may survive the end of its session.
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
    if (parent.execution.paused) await parent.execution.wait(signal)
    if (signal.aborted) return { text: undefined, failure: "aborted" }
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

function standardSections(cwd: string): PromptSection[] {
  return defaultSections({ cwd, project: instructionsSection(loadInstructions(cwd)) })
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
