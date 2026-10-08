import type { Usage } from "@amira/ai"
import { addUsage, emptyUsage } from "./ai.ts"

/** The JSONL trace format version. Readers should ignore unsupported versions. */
export const TRACE_VERSION = 1

/** Terminal tool disposition; rejection takes precedence over the result's error flag. */
export type ToolOutcome = "ok" | "error" | "denied" | "aborted" | "invalid" | "unknown-tool"

/**
 * A host-written observability record. All timestamps are event times in epoch milliseconds;
 * durations are milliseconds. Headers delimit recording runs, including resumed runs.
 * Tool previews contain at most 300 Unicode code points, never full image or detail payloads.
 */
export type TraceRecord =
  | {
      /** Host-only diagnostic; never shown as a user-facing notice. */
      type: "diagnostic"
      at: number
      message: string
    }
  | {
      /** Starts a recording run; resuming appends another header. */
      type: "trace"
      /** Format version for this run. */
      v: 1
      /** Session whose events follow this header. */
      sessionId: string
      /** Parent session, for a child session. */
      parentSessionId?: string
      /** Child's assigned role, when known. */
      role?: string
      /** Session title at the start of this recording run. */
      title?: string
      /** Session announcement time. */
      startedAt: number
    }
  | {
      /** A completed agent turn. */
      type: "turn"
      /** Identifier shared with this turn's model and tool records. */
      turnId: string
      /** Turn start time. */
      start: number
      /** Turn completion time. */
      end: number
      /** How the turn ended. */
      reason: "done" | "error" | "aborted"
      /** Number of steps reported by the agent. */
      steps: number
      /** Structured failure, when supplied by the turn event. */
      failure?: {
        /** Failure classification; "other" for an unclassified error. */
        kind: string
        /** Failure summary, not a stack or provider payload. */
        message: string
      }
    }
  | {
      /** One model request, including its retries. */
      type: "model"
      /** Owning turn, when available. */
      turnId?: string
      /** Model reference in provider/model form. */
      model: string
      /** Message start time. */
      start: number
      /** First observed delta time; absent when no delta was observed reliably. */
      firstToken?: number
      /** Message completion time. */
      end: number
      /** Reported token, search, and USD cost usage. */
      usage?: Usage
      /** Provider-normalized stop reason, when available. */
      stopReason?: string
      /** Retries observed within this request. */
      retries?: {
        /** Retry event time. */
        at: number
        /** Scheduled backoff duration. */
        delayMs: number
        /** Retry classification. */
        kind: string
      }[]
    }
  | {
      /** A completed tool call. */
      type: "tool"
      /** Owning turn, when available. */
      turnId?: string
      /** Model-supplied call identifier; not necessarily unique. */
      toolCallId: string
      /** Tool name. */
      name: string
      /** Tool execute-start event time. */
      start: number
      /** Tool execute-end event time. */
      end: number
      /** Execution duration reported by the agent, excluding approval and pre/post-call interceptors. */
      durationMs: number
      /** Time actually spent awaiting approval; absent for calls that never waited. */
      approvalWaitMs?: number
      /** Terminal disposition, with rejection taking precedence over result.isError. */
      outcome: ToolOutcome
      /** Source of approval, when reported. */
      approval?: "user" | "rule"
      /** Unicode code point count of the compact JSON arguments. */
      argsChars: number
      /** Unicode code point count of event result text, possibly already an artifact preview. */
      resultChars: number
      /** First at most 300 code points of compact JSON arguments. */
      argsPreview: string
      /** First at most 300 code points of text result blocks. */
      resultPreview: string
      /** Saved-output artifact identifier, never its filesystem path. */
      artifact?: string
      /** Written paths reported by the tool's traits. */
      writtenPaths?: string[]
    }
  | {
      /** A session status transition. */
      type: "status"
      /** Status event time. */
      at: number
      /** New session status. */
      status: "idle" | "working" | "blocked" | "error"
      /** Explanation of this transition, when reported. */
      reason?: string
    }
  | {
      /** A completed direct child, recorded in its parent's trace. */
      type: "subagent"
      /** Child session identifier. */
      childSessionId: string
      /** Spawning tool call identifier, when available. */
      toolCallId?: string
      /** Assigned role. */
      role?: string
      /** Child task title. */
      title?: string
      /** Spawn group identifier. */
      groupId?: string
      /** Queue entry time, only for children announced as queued. */
      queuedAt?: number
      /** Child session start; equals end if cancelled before admission. */
      start: number
      /** Child completion time. */
      end: number
      /** Terminal status reported by the host. */
      status: string
      /** Failure text, when reported. */
      error?: string
      /** Child's own reported usage, not recursively inclusive of descendants. */
      usage?: Usage
      /** Lifetime duration reported by the host, including admitted idle time. */
      durationMs: number
    }
  | {
      /** A completed or failed compaction attempt. */
      type: "compact"
      /** Compaction start time; equals end for an unpaired failure. */
      start: number
      /** Compaction completion or failure time. */
      end: number
      /** Trigger reason; failed attempts use a failure-prefixed reason. */
      reason: string
      /** Reported tokens before compaction. */
      tokensBefore?: number
      /** Estimated tokens after compaction. */
      tokensAfter?: number
      /** Compaction request usage, when reported. */
      usage?: Usage
      /** Whether provider-native compaction was used. */
      native?: boolean
      /** Whether a native attempt fell back to model compaction. */
      fallback?: boolean
    }
  | {
      /** A side request; hosts without a side-usage event do not write this variant. */
      type: "side"
      /** Usage event time. */
      at: number
      /** Purpose label, when supplied. */
      label?: string
      /** Model reference in provider/model form. */
      model: string
      /** Side-request token, search, and cost usage. */
      usage?: Usage
    }

/** Duration statistics for all calls of one tool. */
export interface TraceToolSummary {
  /** Number of completed calls, including rejections. */
  count: number
  /** Sum of reported durationMs, without deduplicating overlapping calls. */
  totalMs: number
  /** Mean reported durationMs. */
  avgMs: number
  /** Largest reported durationMs. */
  maxMs: number
  /** Count for each disposition, including zero-valued buckets. */
  outcomes: Record<ToolOutcome, number>
}

/** A non-successful tool or turn, in chronological completion order. */
export type TraceFailure =
  | {
      /** Failure source. */
      type: "tool"
      /** Tool completion time. */
      at: number
      /** Owning turn, when available. */
      turnId?: string
      /** Model-supplied call identifier. */
      toolCallId: string
      /** Failed tool name. */
      name: string
      /** Non-successful terminal disposition. */
      outcome: Exclude<ToolOutcome, "ok">
      /** Bounded result preview, which may be empty. */
      message: string
    }
  | {
      /** Failure source. */
      type: "turn"
      /** Turn completion time. */
      at: number
      /** Failed turn identifier. */
      turnId: string
      /** Non-successful terminal reason. */
      reason: "error" | "aborted"
      /** Structured failure kind, when available. */
      kind?: string
      /** Failure summary, when available. */
      message?: string
    }

/** One completed direct child; usage is not recursively inclusive of its descendants. */
export interface TraceSubagentSummary {
  /** Child session identifier. */
  childSessionId: string
  /** Assigned role, when known. */
  role?: string
  /** Child task title, when known. */
  title?: string
  /** Child execution start time. */
  start: number
  /** Child completion time. */
  end: number
  /** Host-reported lifetime duration. */
  durationMs: number
  /** Terminal child status. */
  status: string
  /** Child's own reported token, search, and USD cost usage. */
  usage?: Usage
  /** Child's own reported cost in USD; absent when unknown. */
  cost?: number
}

/** Pure accounting over completed records from one session's trace, including resumed runs. */
export interface TraceSummary {
  /** Earliest represented event time; absent for an empty trace. */
  start?: number
  /** Latest represented event time; absent for an empty trace. */
  end?: number
  /** Latest minus earliest time, including downtime between recording runs. */
  wallTimeMs: number
  /** Sum of model request intervals, including retry delays. */
  modelTimeMs: number
  /** Sum of start-to-firstToken time only for requests with an observed first token. */
  modelWaitMs: number
  /** Sum of firstToken-to-end time only for requests with an observed first token. */
  modelStreamMs: number
  /** Model time without an observed first token; not classified as waiting or streaming. */
  modelUnknownMs: number
  /** Union of tool start/end intervals, so parallel execution is counted once. */
  toolTimeMs: number
  /** Sum of agent-reported tool durations, independently of interval union. */
  toolDurationMs: number
  /** Sum of actual approval waits; concurrent waits may overlap. */
  approvalWaitMs: number
  /** Gaps between turn intervals within each header-delimited run; excludes resume downtime. */
  idleMs: number
  /** This session's model, compact, and side usage; excludes child usage. */
  usage: Usage
  /** Direct children's own reported usage, without recursive descendant usage. */
  subagentUsage: Usage
  /** Own plus direct-child usage; cost is absent if any included usage has unknown cost. */
  totalUsage: Usage
  /** Tool statistics keyed by exact tool name. */
  tools: Record<string, TraceToolSummary>
  /** Non-OK tools and failed or aborted turns, sorted by completion time. */
  failures: TraceFailure[]
  /** Number of recorded retry events. */
  retries: number
  /** Completed direct children, in record order. */
  subagents: TraceSubagentSummary[]
}

type Interval = { start: number; end: number }

function intervalTime(intervals: Interval[]): number {
  const ordered = intervals.toSorted((a, b) => a.start - b.start)
  let total = 0
  let end = -Infinity
  for (const interval of ordered) {
    total += Math.max(0, interval.end - Math.max(end, interval.start))
    end = Math.max(end, interval.end)
  }
  return total
}

function usageTotal(usages: Usage[]): Usage {
  let total = emptyUsage()
  for (const usage of usages) {
    const reasoning = (total.reasoning ?? 0) + (usage.reasoning ?? 0)
    const hasReasoning = total.reasoning !== undefined || usage.reasoning !== undefined
    total = addUsage(total, usage)
    if (hasReasoning) total.reasoning = reasoning
  }
  // A partial known price is not the total price. Preserve unknown search prices as well.
  if (usages.some((usage) => usage.cost === undefined)) delete total.cost
  return total
}

/**
 * Summarizes without mutating records. Completion order need not be chronological. Time metrics
 * are independent and may overlap; they must not be added to reconstruct wall time. Missing
 * firstToken leaves the whole model interval unclassified. Idle excludes downtime across headers.
 * Usage/cost covers only reported events; absent side-usage events and unreported usage cannot be
 * reconstructed. Pass one session's trace: adding its child traces would double-count child usage.
 */
export function summarizeTrace(records: TraceRecord[]): TraceSummary {
  const summary: TraceSummary = {
    wallTimeMs: 0,
    modelTimeMs: 0,
    modelWaitMs: 0,
    modelStreamMs: 0,
    modelUnknownMs: 0,
    toolTimeMs: 0,
    toolDurationMs: 0,
    approvalWaitMs: 0,
    idleMs: 0,
    usage: emptyUsage(),
    subagentUsage: emptyUsage(),
    totalUsage: emptyUsage(),
    tools: {},
    failures: [],
    retries: 0,
    subagents: [],
  }
  const tools = new Map<string, TraceToolSummary>()
  const toolIntervals: Interval[] = []
  const runs: Interval[][] = [[]]
  const ownUsage: Usage[] = []
  const childUsage: Usage[] = []
  const time = (at: number) => {
    summary.start = Math.min(summary.start ?? at, at)
    summary.end = Math.max(summary.end ?? at, at)
  }
  for (const record of records) {
    if (record.type === "trace") {
      time(record.startedAt)
      runs.push([])
      continue
    }
    if ("at" in record) time(record.at)
    else {
      time(record.start)
      time(record.end)
    }
    if (record.type === "model" || record.type === "compact" || record.type === "side") {
      if (record.usage) ownUsage.push(record.usage)
    }
    switch (record.type) {
      case "turn":
        runs.at(-1)!.push(record)
        if (record.reason !== "done") {
          summary.failures.push({
            type: "turn",
            at: record.end,
            turnId: record.turnId,
            reason: record.reason,
            ...(record.failure && { kind: record.failure.kind, message: record.failure.message }),
          })
        }
        break
      case "model": {
        const duration = Math.max(0, record.end - record.start)
        summary.modelTimeMs += duration
        if (record.firstToken === undefined) summary.modelUnknownMs += duration
        else {
          time(record.firstToken)
          const waiting = Math.max(0, Math.min(duration, record.firstToken - record.start))
          summary.modelWaitMs += waiting
          summary.modelStreamMs += duration - waiting
        }
        summary.retries += record.retries?.length ?? 0
        for (const retry of record.retries ?? []) time(retry.at)
        break
      }
      case "tool": {
        toolIntervals.push(record)
        summary.toolDurationMs += record.durationMs
        summary.approvalWaitMs += record.approvalWaitMs ?? 0
        let stats = tools.get(record.name)
        if (!stats) {
          stats = {
            count: 0,
            totalMs: 0,
            avgMs: 0,
            maxMs: 0,
            outcomes: { ok: 0, error: 0, denied: 0, aborted: 0, invalid: 0, "unknown-tool": 0 },
          }
          tools.set(record.name, stats)
        }
        stats.count++
        stats.totalMs += record.durationMs
        stats.avgMs = stats.totalMs / stats.count
        stats.maxMs = Math.max(stats.maxMs, record.durationMs)
        stats.outcomes[record.outcome]++
        if (record.outcome !== "ok") {
          summary.failures.push({
            type: "tool",
            at: record.end,
            ...(record.turnId !== undefined && { turnId: record.turnId }),
            toolCallId: record.toolCallId,
            name: record.name,
            outcome: record.outcome,
            message: record.resultPreview,
          })
        }
        break
      }
      case "subagent":
        if (record.queuedAt !== undefined) time(record.queuedAt)
        if (record.usage) childUsage.push(record.usage)
        summary.subagents.push({
          childSessionId: record.childSessionId,
          ...(record.role !== undefined && { role: record.role }),
          ...(record.title !== undefined && { title: record.title }),
          start: record.start,
          end: record.end,
          durationMs: record.durationMs,
          status: record.status,
          ...(record.usage && { usage: { ...record.usage } }),
          ...(record.usage?.cost !== undefined && { cost: record.usage.cost }),
        })
        break
    }
  }
  summary.wallTimeMs = summary.start === undefined ? 0 : summary.end! - summary.start
  summary.toolTimeMs = intervalTime(toolIntervals)
  for (const turns of runs) {
    if (!turns.length) continue
    let start = Infinity
    let end = -Infinity
    for (const turn of turns) {
      start = Math.min(start, turn.start)
      end = Math.max(end, turn.end)
    }
    summary.idleMs += Math.max(0, end - start - intervalTime(turns))
  }
  summary.usage = usageTotal(ownUsage)
  summary.subagentUsage = usageTotal(childUsage)
  summary.totalUsage = usageTotal([...ownUsage, ...childUsage])
  summary.tools = Object.fromEntries(tools)
  summary.failures.sort((a, b) => a.at - b.at)
  return summary
}
