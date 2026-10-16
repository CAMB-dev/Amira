import { existsSync } from "node:fs"
import path from "node:path"
import { type Ai, hasFastMode, type Message, type ModelInfo, type Usage, type UserMessage } from "@amira/ai"
import {
  type AnyEvent,
  agentStatusState,
  type Budget,
  type ChildSession,
  type ChildState,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
  DEFAULT_SUBAGENT_MAX_DEPTH,
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
import { Agent, type TurnResult } from "./agent.ts"
import type { CompactionOptions } from "./compaction.ts"
import type { ContextOptions } from "./context.ts"
import { EventBus } from "./event-bus.ts"
import { intersectWriteRoots } from "./permissions/write-roots.ts"
import { addNonInteractive, type PromptSection, setSection } from "./prompt.ts"
import { registerSessionScope } from "./session-routing.ts"
import { SessionStore } from "./session-store.ts"
import { addUsage, BudgetLedger, overBudget, usageTokens } from "./subagents/budget.ts"
import { Child, Group, type SpawnedSubagent } from "./subagents/child.ts"
import { ParentConsultant, parseParentAnswers } from "./subagents/consult-parent.ts"
import { consultationUsageRecorder } from "./subagents/consultation-usage.ts"
import { followChild, metaOf, parentMeta } from "./subagents/events.ts"
import { finalText, forkHistory } from "./subagents/fork.ts"
import { SpawnError, scopeAdmission } from "./subagents/lifecycle.ts"
import { overlaps } from "./subagents/paths.ts"
import { childQuestionRouting, hasHumanRouting } from "./subagents/question-routing.ts"
import { runRoot } from "./subagents/root.ts"
import { Admission } from "./subagents/scheduler.ts"
import { standardSections } from "./subagents/sections.ts"
import {
  checkResult,
  isObjectSchema,
  type ResultSpec,
  resultInstructions,
  resultReminder,
  returnResultTool,
} from "./subagents/structured-result.ts"
import { ToolRegistry } from "./tool-registry.ts"
import { toolTraits } from "./tool-traits.ts"

export type { SpawnedSubagent }
export { forkHistory, parseParentAnswers, SpawnError, usageTokens }

export interface AgentTreeOptions {
  ai: Ai
  /** Reuse host admission and accounting, but keep children, groups and teardown independent. */
  shared?: AgentTree
  /** Research-only descendants: no shell tools or worktrees, and human question routing. */
  restricted?: boolean
  /** Deepest a sub-agent may be (D15). See DEFAULT_SUBAGENT_MAX_DEPTH. */
  maxDepth?: number
  /**
   * Sub-agents of the whole tree working at once, not counting those waiting for children of
   * their own; the rest wait in order (D63). See DEFAULT_SUBAGENT_MAX_CONCURRENT.
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
  ephemeral: boolean
  groups: Group[]
  base: PromptSection[]
  extra: NonNullable<SpawnOptions["extraTools"]>
  allow: Set<string> | undefined
  deny: Set<string>
  spec: ResultSpec | undefined
  store: SessionStore | undefined
  writeRoots: readonly string[] | undefined
  maxTurns: number | undefined
}

/**
 * One agent tree (D12, D15): starts sub-agents as real sessions under their parent, bubbles
 * their events (they share the parent's bus and carry parentSessionId), limits nesting and
 * concurrency, and keeps the budget every session of the tree spends from. Spawn groups carve
 * limits of their own out of it; persistent children live across turns.
 */
export class AgentTree {
  readonly restricted: boolean
  readonly maxDepth: number
  readonly maxConcurrent: number
  readonly budget: Budget | undefined
  readonly resultRetries: number
  #opts: AgentTreeOptions
  #ledger: BudgetLedger
  /** Registered lifecycle scopes spending from the same ledger. */
  #scopes: Set<AgentTree>
  /** Root turns belong to this scope, including those waiting for admission. */
  #roots = new Set<AbortController>()
  #live = new Map<string, Child>()
  /** Every child this tree started, finished ones too, in spawn order. */
  #spawned = new Map<string, Child | SpawnedSubagent>()
  #admission: Admission
  #consultant: ParentConsultant
  #directHuman: boolean
  #groups = new Map<string, Group>()
  /** Ended sub-agents whose dispose is still running, by session id. */
  #disposals = new Map<string, { parent: string; done: Promise<void> }>()

  constructor(opts: AgentTreeOptions) {
    registerSessionScope(this, this.#live, this.#spawned, this.#disposals)
    this.#opts = {
      ...opts,
      compaction: opts.compaction ?? (opts.shared ? opts.shared.#opts.compaction : undefined),
      context: opts.context ?? (opts.shared ? opts.shared.#opts.context : undefined),
      maxParallelTools:
        opts.maxParallelTools ?? (opts.shared ? opts.shared.#opts.maxParallelTools : undefined),
    }
    this.restricted = opts.restricted === true || opts.shared?.restricted === true
    this.#directHuman =
      this.restricted || (opts.shared ? opts.shared.#directHuman || hasHumanRouting(opts.shared) : false)
    this.maxDepth = Math.max(0, opts.maxDepth ?? opts.shared?.maxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH)
    this.maxConcurrent =
      opts.shared?.maxConcurrent ?? Math.max(1, opts.maxConcurrent ?? DEFAULT_SUBAGENT_MAX_CONCURRENT)
    this.#admission = opts.shared
      ? opts.shared.#admission
      : new Admission({ maxConcurrent: this.maxConcurrent })
    this.budget = opts.shared ? opts.shared.budget : opts.budget
    this.#ledger = opts.shared ? opts.shared.#ledger : new BudgetLedger(opts.budget)
    this.#scopes = opts.shared ? opts.shared.#scopes : new Set()
    this.#scopes.add(this)
    this.#consultant = new ParentConsultant({
      ai: opts.ai,
      callableTools: (requester) => this.#live.get(requester)?.agent.callableTools,
      acquire: (requester, signal) => {
        const child = this.#live.get(requester)
        return child ? this.#admission.acquireConsultation(child, signal) : Promise.resolve(() => {})
      },
      usageRecorder: (parent, requester) => {
        const requestingChild = this.#live.get(requester)
        const child = requestingChild?.ephemeral ? requestingChild : this.#live.get(parent.sessionId)
        const owner = requestingChild?.ephemeral ? requestingChild.agent : parent
        const model = { provider: parent.model.provider, model: parent.model.id }
        return consultationUsageRecorder((usage) => this.#recordUsage(owner, usage, model, child))
      },
    })
    this.resultRetries = Math.max(0, opts.resultRetries ?? 2)
  }

  /** Runs an independently owned root turn inside host admission, without registering a child. */
  runRoot<T>(agent: Agent, task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return scopeAdmission(this).runRoot(agent.sessionId, signal, () =>
      runRoot({
        agent,
        task,
        signal,
        admission: this.#admission,
        roots: this.#roots,
        spent: () => this.#ledger.exceeded,
      }),
    )
  }

  /** Unregisters a disposed scope from shared-budget cancellation. Does not affect its siblings. */
  releaseScope(): void {
    scopeAdmission(this).release()
    this.#scopes.delete(this)
  }

  /** What the whole tree has used so far. */
  get usage(): Readonly<Usage> {
    return this.#ledger.usage
  }

  /** Children that are queued, running or idle, oldest first. */
  get children(): ChildSession[] {
    return [...this.#live.values()].filter((c) => !c.ephemeral)
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
    const liveState = agentStatusState({
      startedAt: c.startedAt,
      queued: c.state === "queued",
      idle: c.state === "idle",
      paused: c.agent.execution.paused,
    })
    // Keep lifecycle status names in the public listing; presentation uses the same mapper.
    const status =
      r?.status ??
      (liveState === "paused" || liveState === "idle" || liveState === "queued" ? liveState : "running")
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
    return [...this.#groups.values()].filter((g) => !g.ephemeral).map((g) => g.info())
  }

  /** A spawn group by id. */
  group(id: string): SpawnGroup | undefined {
    const group = this.#groups.get(id)
    return group?.ephemeral ? undefined : group
  }

  /**
   * Creates a spawn group whose children are `parent`'s. A budget over what the tree has left
   * is cut down to that; a parent that is itself in a group makes the new one part of it.
   */
  createGroup(parent: Agent, opts: SpawnGroupOptions, defaults: { toolCallId?: string } = {}): SpawnGroup {
    scopeAdmission(this).check(parent.sessionId)
    if (this.#ledger.exceeded)
      throw new SpawnError(`the agent tree's budget is spent (${this.#ledger.exceeded})`)
    const outer = this.#live.get(parent.sessionId)?.groups[0]
    if (outer && outer.state !== "active") throw new SpawnError(`the group "${outer.name}" has ended`)
    const limits: Omit<SpawnGroupOptions, "name" | "compact"> = {}
    for (const key of ["maxConcurrent", "maxAgents", "maxTurnsPerAgent"] as const) {
      const n = opts[key]
      if (n !== undefined) limits[key] = Math.max(1, Math.floor(n))
    }
    const budget = this.#ledger.carve(opts.budget)
    if (budget) limits.budget = budget
    const name = opts.name.replace(/\s+/g, " ").trim() || "group"
    const ephemeral = this.#live.get(parent.sessionId)?.ephemeral === true
    const group = new Group(name, parent, outer, limits, opts.compact === true, this, defaults, ephemeral)
    this.#groups.set(group.id, group)
    parent.bus.emit("group.start", { group: group.info() }, metaOf(parent))
    return group
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
    scopeAdmission(this).check(parent.sessionId)
    if (this.#ledger.exceeded)
      throw new SpawnError(`the agent tree's budget is spent (${this.#ledger.exceeded})`)
    const depth = parent.depth + 1
    if (depth > this.maxDepth) {
      throw new SpawnError(
        `sub-agents can nest at most ${this.maxDepth} level${this.maxDepth === 1 ? "" : "s"} deep`,
      )
    }
    const ephemeral = opts.ephemeral === true || this.#live.get(parent.sessionId)?.ephemeral === true
    if (opts.schema && (opts.persistent || ephemeral)) {
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
    if (this.restricted && cwd !== path.resolve(parent.cwd))
      throw new SpawnError("restricted conversation children cannot change cwd or use worktrees")
    const context = opts.context ?? "fresh"
    const persistent = opts.persistent === true || ephemeral
    let base = context === "fork" ? [...parent.sections] : (this.#opts.sections ?? standardSections)(cwd)
    if (parent.nonInteractive) base = addNonInteractive(base)
    const extra = opts.extraTools ?? []
    const shell = this.restricted && extra.find((tool) => tool.shellKind || toolTraits(tool)?.shell)
    if (shell)
      throw new SpawnError(`${shell.name} is a shell tool and is unavailable in a restricted conversation`)
    if (extra.some((t) => t.name === RETURN_RESULT_TOOL)) {
      throw new SpawnError(`an extra tool cannot be named ${RETURN_RESULT_TOOL}`)
    }
    // Private children preserve declarations, but mainOnly calls are still refused by Agent.
    const mainOnly = extra.find((t) => t.mainOnly)
    if (mainOnly && !ephemeral) throw new SpawnError(`${mainOnly.name} is for top-level sessions only`)
    const allow = opts.tools ? new Set(opts.tools) : undefined
    const deny = new Set(opts.excludeTools ?? [])
    // A parent's own tools (its return_result, its extra tools) are its own: never passed down.
    deny.add(RETURN_RESULT_TOOL)
    for (const name of parent.tools.ownNames()) deny.add(name)
    const spec: ResultSpec | undefined = opts.schema
      ? { schema: opts.schema, wrapped: !isObjectSchema(opts.schema), strikes: 0 }
      : undefined
    if (spec) base = setSection(base, "result", resultInstructions())
    const writeRoots = intersectWriteRoots(parent.writeRoots, opts.writeRoots)
    const store =
      parent.session && !ephemeral
        ? SessionStore.create({
            cwd,
            parent: parent.sessionId,
            dir: path.join(path.dirname(parent.session.file), "subagents"),
            owned: parent.session.header.owned,
            writeRoots,
          })
        : undefined
    const turnLimits = [opts.maxTurns, ...groups.map((g) => g.limits.maxTurnsPerAgent)].filter(
      (n): n is number => n !== undefined,
    )
    const maxTurns = persistent && turnLimits.length ? Math.max(1, Math.min(...turnLimits)) : undefined
    return {
      depth,
      model,
      cwd,
      context,
      persistent,
      ephemeral,
      groups,
      base,
      extra,
      allow,
      deny,
      spec,
      store,
      writeRoots,
      maxTurns,
    }
  }

  #createAgent(parent: Agent, opts: SpawnOptions, setup: SpawnSetup, getChild: () => Child): Agent {
    const { depth, model, cwd, context, persistent, ephemeral, base, extra, allow, deny, spec, store } = setup
    const callable = opts.callableTools ? new Set(opts.callableTools) : undefined
    const inherited = parent.callableTools
    const callableTools = inherited
      ? new Set([...inherited].filter((name) => callable?.has(name) ?? true))
      : callable
    return new Agent({
      ai: this.#opts.ai,
      model,
      cwd,
      providerSettings: parent.providerSettings,
      thinking: parent.thinking.for(parent.model),
      fastMode: parent.fastMode && hasFastMode(model),
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
      ...(ephemeral ? { outputsReadOnly: true } : {}),
      bus: ephemeral && !this.#live.get(parent.sessionId)?.ephemeral ? new EventBus() : parent.bus,
      ...(callableTools ? { callableTools } : {}),
      writeRoots: setup.writeRoots,
      interceptors: parent.interceptors,
      tools: ToolRegistry.view(
        parent.tools,
        // A private child's declarations stay close to its parent's; execution is gated separately.
        (n) =>
          (allow?.has(n) ?? true) &&
          !deny.has(n) &&
          (ephemeral || parent.tools.get(n)?.mainOnly !== true) &&
          (!this.restricted ||
            (!parent.tools.get(n)?.shellKind && !toolTraits(parent.tools.get(n) ?? { name: n })?.shell)),
        [...extra, ...(spec ? [returnResultTool(spec, this.resultRetries)] : [])],
      ),
      ...(store ? { session: store, ownedConversation: store.header.owned?.owner } : {}),
      parentSessionId: parent.sessionId,
      depth,
      tree: this,
      ...(parent.backgroundJobsHost ? { backgroundJobs: parent.backgroundJobsHost } : {}),
      // The parent's permission policy, mode and rules, with the user who answers its questions:
      // the policy's questions skip the parent's model and go to the user (Agent).
      permissions: parent.permissions,
      ...(parent.permissionApprover ? { permissionApprover: parent.permissionApprover } : {}),
      ...childQuestionRouting(parent, this.#consultant, this.#directHuman || hasHumanRouting(this)),
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
    const { depth, cwd, context, persistent, ephemeral, groups, spec, maxTurns } = setup
    const given = opts.title?.replace(/\s+/g, " ").trim()
    const title = !given
      ? fallbackTitle(opts.prompt)
      : given.length > MAX_TITLE_CHARS
        ? `${given.slice(0, MAX_TITLE_CHARS - 1)}…`
        : given
    if (!ephemeral) parent.recordSubagent(agent.sessionId, opts.role, title)
    // Preserve the inherited deferred declarations and their load order before the first call.
    if (context === "fork" || ephemeral) agent.loadTools(parent.loadedTools)
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
      ephemeral,
      ephemeral ? (parent.session ?? this.#live.get(parent.sessionId)?.usageStore) : undefined,
      ephemeral ? (this.#live.get(parent.sessionId)?.usageOwner ?? parent) : undefined,
      maxTurns,
      groups,
    )
    child.result$ = spec
    agent.execution.onTools = {
      waiting: () => this.#admission.beginTools(child),
      returned: () => this.#admission.endTools(child),
      ready: (signal) => this.#admission.reenter(child, signal),
    }
    this.#live.set(child.id, child)
    if (!ephemeral) this.#spawned.set(child.id, child)
    for (const g of groups) {
      g.total++
      g.live.add(child)
    }
    this.#admission.enqueue(child, parent.sessionId, () => void this.#run(child))
    const queued = !child.admitted
    agent.bus.emit(
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

  /** Adds a reply's usage to the tree and its groups, reports it, and stops what went over budget. */
  recordUsage(agent: Agent, usage: Usage, model?: Child["model"]): void {
    this.#recordUsage(agent, usage, model, this.#live.get(agent.sessionId))
    if (this.#ledger.exceeded) agent.abort() // Main sessions bypass root admission.
  }

  /** A consultation retains its accounting child until late terminal usage arrives. */
  #recordUsage(
    agent: Agent,
    usage: Usage,
    model: Child["model"] | undefined,
    child: Child | undefined,
  ): void {
    this.#ledger.add(usage)
    if (child) {
      addUsage(child.usage, usage)
      child.chargeUsage(usage, model)
    }
    const tokens = usageTokens(this.#ledger.usage)
    const costUsd = this.#ledger.usage.cost
    const limit = this.budget
    const owner = child?.usageOwner ?? agent
    owner.bus.emit(
      "budget.update",
      {
        tokens,
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(this.#ledger.usage.pricingUnknown ? { pricingUnknown: true } : {}),
        ...(limit ? { limit } : {}),
      },
      metaOf(owner),
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
    owner.bus.emit(
      "budget.exceeded",
      { tokens, ...(costUsd !== undefined ? { costUsd } : {}), limit },
      metaOf(owner),
    )
    for (const scope of this.#scopes) scope.abortAll(`the agent tree's budget ran out (${over})`)
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

  /** A user hold changes presentation counts, not the child's admission state. */
  childStateChanged(child: Child): void {
    this.#groupsChanged(child)
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
    if (group.ephemeral) this.#groups.delete(group.id)
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
    this.#admission.admit()
    return true
  }

  /** Delivers a message to a live persistent child by id (as ChildSession.send); false for any other. */
  deliver(sessionId: string, message: string | UserMessage): boolean {
    const child = this.#live.get(sessionId)
    return child ? child.send(message) : false
  }

  /** Ends every group and aborts every live child and owned root in this scope only. */
  abortAll(reason: string): void {
    for (const root of this.#roots) root.abort(new Error(reason))
    for (const g of this.#groups.values()) this.endGroup(g, reason)
    for (const child of [...this.#live.values()]) this.abortChild(child, reason)
  }

  /** Aborts one agent's children without ending the parent or disturbing its siblings. */
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
    scopeAdmission(this).closeParent(child.id)
    if (child.started) {
      child.agent.abort()
      child.waiting?.()
      return
    }
    this.#admission.dequeue(child)
    this.#finish(child, { status: "aborted", error: reason, steps: 0, durationMs: 0 })
  }

  /** Ends a persistent child cleanly: at once while idle or queued, after its running turn otherwise. */
  stopChild(child: Child, reason: string): void {
    if (!child.persistent || !this.#live.has(child.id) || child.abortReason || child.stopReason) return
    // A paused one runs its turn to the end first: it is working again, and screens hear so.
    if (child.resume()) this.#admission.admit()
    child.stopReason = reason
    scopeAdmission(this).closeParent(child.id)
    if (child.started) {
      child.waiting?.()
      return
    }
    this.#admission.dequeue(child)
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
            this.#admission.release(child)
            this.#setState(child, "idle")
            this.#admission.admit()
            await new Promise<void>((resolve) => {
              child.waiting = resolve
            })
            child.waiting = undefined
            if (child.abortReason || child.stopReason) break
            this.#setState(child, "queued")
            await this.#admission.acquire(child)
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
      this.#admission.release(child)
      this.#finish(child, {
        status,
        ...(error !== undefined ? { error } : {}),
        steps,
        durationMs: Math.round(performance.now() - startedAt),
      })
      this.#admission.admit()
    }
  }

  #finish(child: Child, r: Pick<SubagentResult, "status" | "error" | "steps" | "durationMs">) {
    if (!this.#live.delete(child.id)) return
    scopeAdmission(this).closeParent(child.id)
    child.waiting = undefined
    child.agent.cancelNoticeRetry()
    // Messages sent to it that never reached its model: the sender learns which.
    const undelivered = child.agent.takeNotices()
    // Its own live sub-agents (and theirs) end with it: nobody is left to collect them.
    for (const c of [...this.#live.values()]) {
      if (c.parentSessionId === child.id) this.abortChild(c, "its parent ended")
    }
    this.#admission.childEnded(child)
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
    if (!child.ephemeral) {
      const done = this.subagent(child.id) as SpawnedSubagent
      const stored = child.agent.session?.file
      const file = stored && existsSync(stored) ? stored : undefined
      this.#spawned.set(child.id, {
        info: done.info,
        ...(file ? { file } : { messages: [...child.agent.messages] }),
      })
    }
    const outcome = agentStatusState(result)
    for (const g of child.groups) {
      g.live.delete(child)
      g.outcomes[outcome]++
    }
    this.#groupsChanged(child)
    child.settle(result)
  }
}
