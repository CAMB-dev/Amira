import { emptyUsage, type Message, type UserMessage, userMessage } from "@amira/ai"
import type {
  AnyEvent,
  ChildSession,
  ChildState,
  PendingNotice,
  SpawnContext,
  SpawnGroup,
  SpawnGroupInfo,
  SpawnGroupOptions,
  SpawnGroupState,
  SpawnOptions,
  SubagentInfo,
  SubagentResult,
} from "@amira/api"
import type { Agent } from "../agent.ts"
import type { EmitMeta } from "../event-bus.ts"
import type { SessionStore } from "../session-store.ts"
import type { AgentTree } from "../subagents.ts"
import { usageTokens } from "./budget.ts"
import { metaOf } from "./events.ts"
import type { ResultSpec } from "./structured-result.ts"

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

export class Child implements ChildSession {
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
export class Group implements SpawnGroup {
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
