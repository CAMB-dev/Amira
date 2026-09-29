import type { JSONSchema, ModelRef, Usage, UserMessage } from "@amira/ai"
import type { AnyEvent } from "./events.ts"
import type { PendingNotice, ToolDefinition } from "./tools.ts"

/** What a sub-agent starts with (D12): only its task, or the parent's conversation so far. */
export type SpawnContext = "fresh" | "fork"

export interface SpawnOptions {
  /** Role name, recorded with the child and shown by frontends. */
  role?: string
  /** A few words naming the task ("US market trend"), shown by frontends. Default: the task's first words. */
  title?: string
  /**
   * The tool call that starts the child, so frontends show it under that call. Set by the host
   * from the calling tool's context; a tool does not need to pass it.
   */
  toolCallId?: string
  /** The task. With `fork` it follows the parent's history as a new user message. */
  prompt: string
  /** "provider/model". Default: the parent's current model. */
  model?: string
  /** Default "fresh". */
  context?: SpawnContext
  /** Working directory, e.g. a worktree. Default: the parent's. */
  cwd?: string
  /** Names of the tools the child may use. Default: every tool the parent has. */
  tools?: string[]
  /** Tools the child may not use, e.g. the one that spawns sub-agents once it is deep enough. */
  excludeTools?: string[]
  /**
   * Tools only this child has, on top of the ones `tools` and `excludeTools` leave it: e.g. a
   * swarm member's messaging tools, whose code knows which member calls them. They win over
   * the parent's tools of the same name, and are hidden from the child's own sub-agents (a
   * parent's tool of the same name too). None may be named return_result.
   */
  extraTools?: ToolDefinition[]
  /** Instructions for the child, placed in its system prompt's "role" section. */
  systemPrompt?: string
  /**
   * Structured output: the JSON Schema of the value the child must hand back. It gets a
   * `return_result` tool taking that value (an object schema is the tool's parameters; any
   * other schema is wrapped as `{ value }`), and its turn ends once it called that tool with a
   * value that fits. A turn that ends without one is asked again, a few times (the tree's
   * `resultRetries`, default 2), and then the child ends with an error. The value comes back
   * as `SubagentResult.value`. Not available with `persistent`.
   */
  schema?: JSONSchema
  /**
   * A long-lived child: after a turn it goes idle instead of ending, and a message sent to it
   * (ChildSession.send or expectNotice) starts its next turn. It ends when stopped
   * (ChildSession.stop or abort), when a turn fails, or after `maxTurns` turns. While idle it
   * does not hold one of the places the tree (or its group) lets run at once.
   */
  persistent?: boolean
  /** Most turns a persistent child runs; it ends after the last one. Default: no limit. */
  maxTurns?: number
}

/** Longest a sub-agent's title may be. */
export const MAX_TITLE_CHARS = 60

/** The tool a child spawned with a `schema` hands its result back with. */
export const RETURN_RESULT_TOOL = "return_result"

/**
 * What a sub-agent is called when it was given no title (as in sessions from before titles):
 * the first few words of its task.
 */
export function fallbackTitle(task: string, words = 5, max = 40): string {
  const all = task.replace(/\s+/g, " ").trim().split(" ")
  const head = all.slice(0, words).join(" ")
  if (!head) return "sub-agent"
  if (head.length > max) return `${head.slice(0, max - 1)}…`
  return all.length > words ? `${head}…` : head
}

export type SubagentStatus = "done" | "error" | "aborted"

export interface SubagentResult {
  sessionId: string
  status: SubagentStatus
  /**
   * The child's final answer: the text of its last reply. With a `schema`, the value it
   * returned, as JSON.
   */
  text: string
  /** With a `schema`: the value the child returned, checked against the schema. */
  value?: unknown
  error?: string
  /** Why a child ended that did not fail, when it was not by finishing its task: stopped, turn limit. */
  note?: string
  /** Turns it ran: 1, unless it is persistent or was asked again for its result. */
  turns?: number
  /**
   * Messages sent to a persistent child (ChildSession.send, or a delivered expectNotice) that
   * never reached its model because it ended first: a turn failed, it was stopped or aborted,
   * or it hit its turn limit. Unset when there are none.
   */
  undelivered?: UserMessage[]
  /** Tokens and cost of this child alone, its own children excluded. */
  usage: Usage
  steps: number
  durationMs: number
}

/**
 * Where a child is: waiting for a place to run, running a turn, idle between turns (only
 * persistent children), or ended.
 */
export type ChildState = "queued" | "working" | "idle" | "ended"

/** A running (or queued) sub-agent. */
export interface ChildSession {
  readonly id: string
  readonly parentSessionId: string
  /** 1 for a child of a top-level session, 2 for a grandchild. */
  readonly depth: number
  readonly model: ModelRef
  readonly cwd: string
  readonly title: string
  readonly persistent: boolean
  readonly state: ChildState
  /** Turns it has started so far. */
  readonly turns: number
  /**
   * Messages on their way to a persistent child: notices announced for it (expectNotice, e.g.
   * a background job of its own) and not delivered yet, and messages sent (send, or a
   * delivered notice) that its model has not seen yet. 0 when nothing is on its way, so an
   * idle child with 0 will stay idle until someone sends it something.
   */
  readonly pendingNotices: number
  /** The spawn group it counts against, if any (see SpawnGroup). */
  readonly groupId?: string
  /**
   * The events of this child and its descendants, ending with its subagent.end. Each
   * iteration subscribes when it starts, so start iterating right after spawn to miss nothing;
   * iterating a child that already ended yields nothing.
   */
  readonly events: AsyncIterable<AnyEvent>
  /**
   * Settles once the child ended, however it ended. Never rejects. When a child ends, the
   * sub-agents it started that are still live are aborted ("its parent ended").
   */
  result(): Promise<SubagentResult>
  /** Stops the child (or takes it out of the queue); its result says aborted. */
  abort(reason?: string): void
  /**
   * Ends a persistent child cleanly: at once when it is idle or waiting for a place to run,
   * after its running turn otherwise. Its result says done, with `reason` as its note. Does
   * nothing to other children, which end after their one turn anyway.
   */
  stop(reason?: string): void
  /**
   * Sends a message to a persistent child: it joins the running turn before its next model
   * call, or starts the next turn of an idle child (once there is a place for it to run).
   * Messages waiting together reach it as one. Give it a `display` with an origin so frontends
   * show it as a notice. False, and nothing is sent, when the child is not persistent or has
   * ended. True only means it was queued: if the child ends before its model saw it (a failed
   * turn, a stop, its turn limit), it comes back in SubagentResult.undelivered.
   */
  send(message: string | UserMessage): boolean
  /**
   * Announces a message for a persistent child that comes later (see PendingNotice); `send`
   * is the same without the announcement. Delivering after the child ended does nothing.
   * Throws for a child that is not persistent.
   */
  expectNotice(): PendingNotice
}

/** A limit shared by a whole agent tree (D15, D37). Unset fields are unlimited. */
export interface Budget {
  /** All tokens: input, output and cache reads and writes. */
  tokens?: number
  costUsd?: number
}

/** Limits of a spawn group; unset fields are unlimited (within the tree's own limits). */
export interface SpawnGroupOptions {
  /** A few words naming it, shown by frontends, e.g. a workflow's name. */
  name: string
  /** The group's children working at once (the tree's maxConcurrent still applies). */
  maxConcurrent?: number
  /** Children the group may start in all, its members' own sub-agents included. */
  maxAgents?: number
  /**
   * Tokens and cost the group's children (and theirs) may spend, carved out of the tree's
   * budget: a limit over what the tree has left is cut down to that. Going over stops every
   * live child of the group, and the group ends.
   */
  budget?: Budget
  /** Most turns each persistent child of the group runs (SpawnOptions.maxTurns can lower it). */
  maxTurnsPerAgent?: number
}

/**
 * A group is `active` until it is ended (or goes over its budget); it is `ending` while the
 * children it stopped are still finishing, and `ended` once none is left.
 */
export type SpawnGroupState = "active" | "ending" | "ended"

/** A spawn group as it stands, as events and listings report it. */
export interface SpawnGroupInfo {
  id: string
  name: string
  /** The session that created it, whose children its members are. */
  parentSessionId: string
  state: SpawnGroupState
  /** The limits in effect (the budget after cutting it to what the tree had left). */
  limits: Omit<SpawnGroupOptions, "name">
  /** Tokens and cost of its children and theirs so far. */
  usage: Usage
  /** All tokens of `usage`, as a token budget counts them. */
  tokens: number
  /** How many of its children are in each state; `total` counts every one it started. */
  agents: { total: number } & Record<ChildState, number>
  /** Why it ended, once it did. */
  endReason?: string
  /** It ended because it went over its budget. */
  exceeded?: boolean
}

/**
 * A named set of sub-agents with limits of its own (how many work at once, how many start in
 * all, a budget), for extensions that run many agents, such as workflows or swarms. Children
 * its members start count against it too.
 */
export interface SpawnGroup {
  readonly id: string
  readonly name: string
  /**
   * Starts a child of the group's session. Throws like ToolSession.spawn, and when the group
   * ended or has started maxAgents children.
   */
  spawn(opts: SpawnOptions): ChildSession
  info(): SpawnGroupInfo
  /** Live children of the group (its members' own included), oldest first. */
  children(): ChildSession[]
  /**
   * Ends the group: idle persistent children are stopped, the others aborted with `reason`,
   * and later spawns are refused. Ending an ended group does nothing.
   */
  end(reason?: string): void
  /** Settles once the group ended and its last child finished, however it ended. */
  ended(): Promise<SpawnGroupInfo>
}

/** A tool call a tool.call.before interceptor wants approved before it runs (D13, D14). */
export interface ApprovalRequest {
  sessionId: string
  toolCallId: string
  name: string
  args: Record<string, unknown>
  /** Why the interceptor asked. */
  reason: string
}
