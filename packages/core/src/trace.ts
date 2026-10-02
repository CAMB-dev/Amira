import path from "node:path"
import { type AnyEvent, artifactIdOf, type EventMap, TRACE_VERSION, type TraceRecord } from "@amira/api"
import type { EventBus } from "./event-bus.ts"
import { TraceFile } from "./trace-file.ts"
import { readTrace } from "./trace-reader.ts"

type RecordOf<T extends TraceRecord["type"]> = Extract<TraceRecord, { type: T }>
type ModelStart = Omit<RecordOf<"model">, "end">
type ToolStart = Pick<RecordOf<"tool">, "start" | "argsChars" | "argsPreview" | "writtenPaths">
type ChildStart = Omit<RecordOf<"subagent">, "type" | "end" | "status" | "durationMs" | "start"> & {
  start?: number
}
interface State {
  writer?: TraceFile
  announced: boolean
  /** The run's header, written with its first record so opening a session leaves no file behind. */
  header?: TraceRecord
  turns: Map<string, number>
  models: Map<string, ModelStart>
  tools: Map<string, ToolStart[]>
  compact?: Omit<RecordOf<"compact">, "end">
  /** Loss may include the first delta; omit latency estimates for the rest of this run. */
  lost: boolean
}

const types: (keyof EventMap)[] = [
  "session.start",
  "session.end",
  "turn.start",
  "turn.end",
  "message.start",
  "message.delta",
  "message.end",
  "model.retry",
  "tool.execute.start",
  "tool.execute.end",
  "status.changed",
  "subagent.start",
  "subagent.end",
  "compact.start",
  "compact.end",
  "compact.failed",
  "events.lost",
]

/**
 * Process-owned, best-effort trace recorder. Subscribe once beside the host bus and reuse on
 * resume. Event callbacks only correlate/enqueue; filesystem work belongs to the batch writer.
 */
export class TraceRecorder {
  #states = new Map<string, State>()
  #children = new Map<string, ChildStart>()
  #retired = new Set<string>()
  #off: () => void
  #timer: ReturnType<typeof setInterval>
  #exit = () => this.emergencyFlush()
  #closing?: Promise<void>

  constructor(private readonly bus: EventBus) {
    this.#off = bus.subscribe(
      (event) => {
        try {
          this.#event(event)
        } catch (error) {
          this.#states.get(event.sessionId)?.writer?.fail(error)
        }
      },
      { maxQueue: 100_000, types },
    )
    this.#timer = setInterval(() => void this.flush(), 1000)
    this.#timer.unref()
    process.on("exit", this.#exit)
  }

  /** Registers a planned root-store path; it is not written until the session file exists. */
  register(sessionId: string, file: string): void {
    if (this.#retired.has(sessionId)) return
    const state = this.#state(sessionId)
    if (state.writer) return
    state.writer = new TraceFile(file, (error) => {
      this.bus.emit(
        "extension.error",
        {
          source: "trace",
          error: `Could not save session trace: ${error instanceof Error ? error.message : String(error)}`,
        },
        { sessionId },
      )
    })
  }

  /** Flushes completed records already delivered to this subscriber, never the whole bus. */
  async flush(): Promise<void> {
    await Promise.all([...this.#states.values()].map((state) => state.writer?.flush()))
  }

  /** Reads a completed-record snapshot; safe from inside an extension event callback. */
  async read(file: string): Promise<TraceRecord[]> {
    await Promise.all(
      [...this.#states.values()].filter((s) => s.writer?.file === file).map((s) => s.writer?.flush()),
    )
    return readTrace(file)
  }

  /** Retires IDs synchronously, then waits for outstanding writes before the host deletes files. */
  async forget(sessionIds: string[]): Promise<void> {
    const pending: Promise<void>[] = []
    for (const id of sessionIds) {
      this.#retired.add(id)
      const state = this.#states.get(id)
      if (state?.writer) {
        state.writer.retired = true
        state.writer.pending = []
        pending.push(state.writer.flush())
      }
      this.#states.delete(id)
      this.#children.delete(id)
    }
    await Promise.all(pending)
  }

  /** Called after host cleanup and bus drain, not at session.end (which may precede late ends). */
  close(): Promise<void> {
    if (!this.#closing) {
      clearInterval(this.#timer)
      this.#off()
      this.#closing = this.flush().finally(() => process.off("exit", this.#exit))
    }
    return this.#closing
  }

  /** Synchronously saves delivered buffers on process exit; cannot drain queued bus events. */
  emergencyFlush(): void {
    for (const state of this.#states.values()) state.writer?.emergencyFlush()
  }

  /** Drops a finished session's state after its writes, so a long-lived host does not accumulate it. */
  #release(id: string, state: State, idle: boolean) {
    const written = state.writer?.flush()
    if (!idle) return
    void Promise.resolve(written).then(() => {
      if (this.#states.get(id) === state && !state.writer?.pending.length) this.#states.delete(id)
    })
  }

  #state(id: string): State {
    let state = this.#states.get(id)
    if (!state) {
      state = { announced: false, turns: new Map(), models: new Map(), tools: new Map(), lost: false }
      this.#states.set(id, state)
    }
    return state
  }

  #event(event: AnyEvent) {
    if (this.#retired.has(event.sessionId)) return
    // Only session.start creates state, so a late event of a released session cannot leak one.
    const state =
      event.type === "session.start" ? this.#state(event.sessionId) : this.#states.get(event.sessionId)
    if (!state) return
    const at = event.ts
    const turn = event.turnId ?? ""
    if (event.type === "session.start") {
      const child = this.#children.get(event.sessionId)
      if (child) child.start = at
      const parent = event.parentSessionId ? this.#states.get(event.parentSessionId)?.writer?.file : undefined
      const file =
        event.data.sessionFile ??
        (parent && safeId(event.sessionId)
          ? path.join(path.dirname(parent), "subagents", `${event.sessionId}.jsonl`)
          : undefined)
      if (file) this.register(event.sessionId, file)
      state.announced = true
      state.lost = false
      state.turns.clear()
      state.models.clear()
      state.tools.clear()
      state.compact = undefined
      state.header = {
        type: "trace",
        v: TRACE_VERSION,
        sessionId: event.sessionId,
        parentSessionId: event.parentSessionId,
        role: child?.role,
        title: event.data.title ?? child?.title,
        startedAt: at,
      }
      return
    }
    if (!state.announced) return
    const push = (record: TraceRecord) => {
      if (state.header) state.writer?.push(state.header)
      state.header = undefined
      state.writer?.push(record)
    }
    switch (event.type) {
      case "session.end":
        // Late tool ends of aborted calls may still follow; release only an idle session.
        this.#release(event.sessionId, state, !state.models.size && !state.tools.size)
        break
      case "turn.start":
        if (event.turnId) state.turns.set(turn, at)
        break
      case "turn.end": {
        const start = state.turns.get(turn)
        if (start !== undefined && event.turnId) {
          const { reason, steps, failure, error } = event.data
          push({
            type: "turn",
            turnId: turn,
            start,
            end: at,
            reason,
            steps,
            failure: failure
              ? { kind: failure.kind, message: failure.summary }
              : error
                ? { kind: "other", message: error }
                : undefined,
          })
        }
        state.turns.delete(turn)
        break
      }
      case "message.start":
        state.models.set(turn, {
          type: "model",
          turnId: event.turnId,
          model: `${event.data.model.provider}/${event.data.model.model}`,
          start: at,
        })
        break
      case "message.delta": {
        const model = state.models.get(turn)
        if (model && !state.lost && model.firstToken === undefined) model.firstToken = at
        break
      }
      case "model.retry": {
        const model = state.models.get(turn)
        if (model) {
          model.retries ??= []
          model.retries.push({ at, delayMs: event.data.delayMs, kind: event.data.kind })
        }
        break
      }
      case "message.end": {
        const model = state.models.get(turn)
        if (model) {
          push({
            ...model,
            end: at,
            usage: event.data.message.usage,
            stopReason: event.data.message.stopReason,
          })
          state.models.delete(turn)
        }
        break
      }
      case "events.lost":
        // A marker cannot identify which session's queued delta was removed. Stop reporting
        // first-token estimates for all in-flight messages rather than inventing precision.
        for (const s of this.#states.values()) {
          s.lost = true
          for (const model of s.models.values()) delete model.firstToken
          s.writer?.invalidateFirstTokens()
        }
        break
      case "tool.execute.start": {
        const args = preview(JSON.stringify(event.data.args))
        const key = toolKey(turn, event.data.toolCallId, event.data.name)
        const queue = state.tools.get(key) ?? []
        queue.push({
          start: at,
          argsChars: args.chars,
          argsPreview: args.text,
          writtenPaths: event.data.writtenPaths,
        })
        state.tools.set(key, queue)
        break
      }
      case "tool.execute.end": {
        const data = event.data
        const key = toolKey(turn, data.toolCallId, data.name)
        const queue = state.tools.get(key)
        const start = queue?.shift()
        if (!queue?.length) state.tools.delete(key)
        if (!start) break
        const text = data.result.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
        const result = preview(text)
        push({
          type: "tool",
          turnId: event.turnId,
          toolCallId: data.toolCallId,
          name: data.name,
          ...start,
          end: at,
          durationMs: data.durationMs,
          approvalWaitMs: data.waitedMs,
          outcome:
            data.rejected === "blocked"
              ? "denied"
              : data.rejected === "aborted"
                ? "aborted"
                : data.rejected === "invalidArgs"
                  ? "invalid"
                  : data.rejected === "unknownTool"
                    ? "unknown-tool"
                    : data.result.isError
                      ? "error"
                      : "ok",
          approval: data.approval,
          resultChars: result.chars,
          resultPreview: result.text,
          artifact: artifactIdOf(text),
          writtenPaths: data.writtenPaths ?? start.writtenPaths,
        })
        break
      }
      case "status.changed":
        push({ type: "status", at, status: event.data.status, reason: event.data.reason })
        break
      case "subagent.start": {
        const { childSessionId, toolCallId, role, title, groupId, queued } = event.data
        this.#children.set(childSessionId, {
          childSessionId,
          toolCallId,
          role,
          title,
          groupId,
          queuedAt: queued ? at : undefined,
        })
        break
      }
      case "subagent.end": {
        const child = this.#children.get(event.data.childSessionId)
        if (child) {
          const { childSessionId, toolCallId, status, error, usage, durationMs } = event.data
          push({
            ...child,
            type: "subagent",
            childSessionId,
            toolCallId: toolCallId ?? child.toolCallId,
            start: child.start ?? at,
            end: at,
            status,
            error,
            usage,
            durationMs,
          })
          this.#children.delete(childSessionId)
        }
        // A sub-agent has no session.end of its own: free its state once its records are written.
        const done = this.#states.get(event.data.childSessionId)
        if (done) this.#release(event.data.childSessionId, done, true)
        void this.flush()
        break
      }
      case "compact.start":
        state.compact = {
          type: "compact",
          start: at,
          reason: event.data.reason,
          tokensBefore: event.data.tokens,
          native: event.data.native,
        }
        break
      case "compact.end": {
        const data = event.data
        if (state.compact)
          push({
            ...state.compact,
            end: at,
            reason: data.reason,
            tokensBefore: data.tokensBefore ?? state.compact.tokensBefore,
            tokensAfter: data.tokensAfter,
            usage: data.usage,
            native: data.native ? true : undefined,
            fallback: data.fallback ? true : undefined,
          })
        state.compact = undefined
        break
      }
      case "compact.failed":
        push({
          ...state.compact,
          type: "compact",
          start: state.compact?.start ?? at,
          end: at,
          reason: `failure:${event.data.blocked ? "blocked" : event.data.empty ? "empty" : "error"}`,
        })
        state.compact = undefined
        break
    }
  }
}

function toolKey(turn: string, id: string, name: string): string {
  return JSON.stringify([turn, id, name])
}

function safeId(id: string): boolean {
  return /^[\w-]+$/.test(id)
}

function preview(text: string): { chars: number; text: string } {
  let chars = 0
  let clipped = ""
  for (const char of text) {
    if (chars < 300) clipped += char
    chars++
  }
  return { chars, text: clipped }
}
