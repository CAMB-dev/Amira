import { createHash } from "node:crypto"
import path from "node:path"
import type { Message, Signature, ToolCallBlock, ToolResultMessage } from "@amira/ai"
import { artifactIdOf } from "@amira/api"
import { estimateTokens, isSummaryMessage } from "./compaction.ts"

/**
 * Context management (A0): the session keeps every message whole; what a request carries is a
 * projection of them. A view replaces one tool result's content in the projection. Views are
 * decided once and never change afterwards, so every later request repeats the same text and
 * the provider's prompt cache keeps its prefix. They only ever replace a result's content:
 * the call, its id, its tool name and its place stay, so calls and results always pair.
 */
export type ContextView =
  /** A2: a read that returned exactly what `of`, an earlier read still in context, returned. */
  | { kind: "duplicate"; text: string; of: ToolResultMessage }
  /** A3: an old result cleared when the context got full, in aging round `epoch`. */
  | { kind: "aged"; text: string; epoch: number }

/** A view as a session file keeps it (a "context" entry), by entry id. */
export interface StoredView {
  entry: string
  kind: ContextView["kind"]
  text: string
  /** duplicate: the entry of the earlier read. */
  of?: string
  /** aged: the aging round. */
  epoch?: number
}

/** Context management options (settings `context`), resolved. */
export interface ContextOptions {
  /** Characters over which a tool's output is saved as an artifact. */
  saveAbove?: number
  /** Characters of the preview the model gets for it. */
  previewChars?: number
  /** Most bytes of artifacts the session keeps. */
  quotaBytes?: number
  /** A2 on (default true). */
  dedupeReads?: boolean
  aging?: AgingOptions
}

export interface AgingOptions {
  /** Default true. */
  enabled?: boolean
  /** Share of the context window that starts an aging round. Default 0.7. */
  start?: number
  /** Share of the window a round frees down to. Default 0.6. */
  target?: number
  /** A round that would free less is skipped, so the prompt prefix stays. Default 8000. */
  minSavedTokens?: number
  /** Most recent user turns never aged. Default 2. */
  keepTurns?: number
  /** In a long current turn, its most recent model steps never aged. Default 2. */
  keepSteps?: number
  /** Experimental: results older than this many user turns are aged whatever the pressure. 0 (default) is off. */
  afterTurns?: number
}

export const AGING_DEFAULTS: Required<AgingOptions> = {
  enabled: true,
  start: 0.7,
  target: 0.6,
  minSavedTokens: 8000,
  keepTurns: 2,
  keepSteps: 2,
  afterTurns: 0,
}

/** Results smaller than this are never aged: the stub would save next to nothing. */
const MIN_AGED_CHARS = 1500

/** The messages as a request carries them: results with a view get the view's text. */
export function projectMessages(
  messages: readonly Message[],
  views: ReadonlyMap<Message, ContextView>,
): Message[] {
  if (views.size === 0) return [...messages]
  return messages.map((m) => {
    const view = m.role === "toolResult" ? views.get(m) : undefined
    if (!view || m.role !== "toolResult") return m
    const projected: ToolResultMessage = {
      role: "toolResult",
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      content: [{ type: "text", text: view.text }],
      isError: m.isError,
    }
    return projected
  })
}

/**
 * Which call each result answers. Providers reuse call ids across steps (and some within one
 * reply), so a result pairs with the call of that id in the reply right before it.
 */
export function pairCalls(messages: readonly Message[]): Map<ToolResultMessage, ToolCallBlock> {
  const out = new Map<ToolResultMessage, ToolCallBlock>()
  let open: ToolCallBlock[] = []
  for (const m of messages) {
    if (m.role === "assistant") open = m.content.filter((b): b is ToolCallBlock => b.type === "toolCall")
    else if (m.role === "toolResult") {
      const i = open.findIndex((c) => c.id === m.toolCallId)
      if (i === -1) continue
      out.set(m, open[i]!)
      open.splice(i, 1)
    }
  }
  return out
}

/** A result's text, when it is all text. */
export function resultText(m: ToolResultMessage): string | undefined {
  if (!m.content.every((b) => b.type === "text")) return undefined
  return m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/**
 * What identifies a read for A2: the file (resolved, case-insensitive on Windows), the
 * requested range and the rendering version. Undefined for anything else, and for a read the
 * model forced.
 */
export function readKey(call: ToolCallBlock, cwd: string): string | undefined {
  if (call.name !== "read") return undefined
  const a = call.args
  if (typeof a.path !== "string" || !a.path || a.force === true) return undefined
  const abs = path.resolve(cwd, a.path)
  const file = process.platform === "win32" ? abs.toLowerCase() : abs
  return JSON.stringify(["read/1", file, a.offset ?? 1, a.limit ?? null])
}

/** "lines 1–2000", "from line 40": the range a read asked for, for notes. */
function rangeOf(call: ToolCallBlock): string {
  const from = typeof call.args.offset === "number" ? call.args.offset : 1
  const limit = typeof call.args.limit === "number" ? call.args.limit : undefined
  return limit !== undefined ? `lines ${from}-${from + limit - 1}` : `from line ${from}`
}

/**
 * A2: the view for a new read result that returned exactly what the latest earlier read of the
 * same file and range returned, when that one is still in the context as it was (no view of
 * its own). Only the new result is ever shortened; earlier ones are never rewritten. Errors,
 * images and other tools' results are left alone. `history` is the context the result joins
 * (with results of the same batch before it), `pairs` its calls.
 */
export function duplicateView(
  history: readonly Message[],
  views: ReadonlyMap<Message, ContextView>,
  pairs: ReadonlyMap<ToolResultMessage, ToolCallBlock>,
  result: ToolResultMessage,
  call: ToolCallBlock,
  cwd: string,
): ContextView | undefined {
  if (result.isError) return undefined
  const key = readKey(call, cwd)
  const text = resultText(result)
  if (!key || text === undefined) return undefined
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!
    if (m === result || m.role !== "toolResult" || m.isError) continue
    const earlier = pairs.get(m)
    if (!earlier || readKey(earlier, cwd) !== key) continue
    // The latest read of that range decides: if it differs, the range changed since.
    const view = views.get(m)
    const original = view?.kind === "duplicate" ? view.of : view ? undefined : m
    if (!original || views.has(original) || !history.includes(original)) return undefined
    const before = resultText(original)
    if (before === undefined || hash(before) !== hash(text)) return undefined
    const p = typeof call.args.path === "string" ? call.args.path : ""
    const note = `[Unchanged: this read returned exactly the same text as the earlier read call ${original.toolCallId} of ${p} (${rangeOf(call)}, sha256 ${hash(text).slice(0, 12)}), shown above; use that output (if it was cleared or summarized since, call read with force: true to get the text again).]`
    // A short read is cheaper than the note about it.
    return note.length < text.length ? { kind: "duplicate", of: original, text: note } : undefined
  }
  return undefined
}

/**
 * The last message holding signed or encrypted provider data that a request to the current
 * model would send back as it is (signed reasoning, a hosted tool's item). A provider may
 * check such data against everything before it, so nothing before it may be rewritten.
 * -1 when there is none.
 */
export function lastSealedIndex(
  messages: readonly Message[],
  replays: (sig: Signature, producer: string) => boolean,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== "assistant") continue
    const sealed = m.content.some(
      (b) =>
        (b.type === "thinking" && (b.redacted || (b.signature && replays(b.signature, m.model.provider)))) ||
        (b.type === "serverTool" && b.signature && replays(b.signature, m.model.provider)),
    )
    if (sealed) return i
  }
  return -1
}

export interface AgingCandidate {
  message: ToolResultMessage
  call: ToolCallBlock | undefined
  /** Estimated tokens it takes now. */
  tokens: number
}

/**
 * A3: results old enough to age, oldest first. Kept: the most recent `keepTurns` user turns,
 * or in a long current turn (more than `keepSteps` model steps) its last `keepSteps` steps;
 * anything before `sealed`; results that already have a view, have images, are small, or
 * that a protected call is still working on (a read of the same file, an artifact it reads).
 * `olderThanTurns` limits them to results before the start of that many last turns.
 */
export function agingCandidates(
  messages: readonly Message[],
  views: ReadonlyMap<Message, ContextView>,
  opts: { keepTurns: number; keepSteps: number; sealed: number; cwd: string; olderThanTurns?: number },
): AgingCandidate[] {
  const starts = messages.flatMap((m, i) => (m.role === "user" && !isSummaryMessage(m) ? [i] : []))
  const current = starts.at(-1) ?? 0
  const steps = messages.flatMap((m, i) => (i > current && m.role === "assistant" ? [i] : []))
  // As compaction splits: whole turns first; only a long turn with nothing before it to age
  // (fewer turns than keepTurns) has its own older steps aged.
  const keep = Math.max(1, opts.keepTurns)
  let protectFrom: number
  if (starts.length > keep) protectFrom = starts.at(-keep)!
  else if (steps.length > opts.keepSteps) protectFrom = steps.at(-opts.keepSteps)!
  else protectFrom = starts.at(-1) ?? 0
  if (opts.olderThanTurns !== undefined) {
    protectFrom = Math.min(protectFrom, starts.at(-Math.max(1, opts.olderThanTurns)) ?? 0)
  }
  // What the protected part still works on.
  const busyPaths = new Set<string>()
  const busyArtifacts = new Set<string>()
  for (const m of messages.slice(protectFrom)) {
    if (m.role !== "assistant") continue
    for (const b of m.content) {
      if (b.type !== "toolCall") continue
      if (typeof b.args.path === "string") busyPaths.add(normalizedPath(b.args.path, opts.cwd))
      if (typeof b.args.id === "string") busyArtifacts.add(b.args.id)
    }
  }
  // A note pointing at a result says the text is there: the result stays while the note does.
  const pointedAt = new Set<Message>()
  for (const v of views.values()) if (v.kind === "duplicate") pointedAt.add(v.of)
  const pairs = pairCalls(messages)
  const out: AgingCandidate[] = []
  for (let i = Math.max(0, opts.sealed + 1); i < protectFrom; i++) {
    const m = messages[i]!
    if (m.role !== "toolResult" || views.has(m) || pointedAt.has(m)) continue
    const text = resultText(m)
    if (text === undefined || text.length < MIN_AGED_CHARS) continue
    const call = pairs.get(m)
    if (
      call &&
      typeof call.args.path === "string" &&
      busyPaths.has(normalizedPath(call.args.path, opts.cwd))
    ) {
      continue
    }
    const artifact = artifactIdOf(text)
    if (artifact && busyArtifacts.has(artifact)) continue
    out.push({ message: m, call, tokens: estimateTokens([m]) })
  }
  return out
}

function normalizedPath(p: string, cwd: string): string {
  const abs = path.resolve(cwd, p)
  return process.platform === "win32" ? abs.toLowerCase() : abs
}

const n = (x: number) => x.toLocaleString("en-US")

/** The status line a shell result ends with, if it has one. */
function shellStatus(text: string): string | undefined {
  // The tool's own paragraphs come last: the status, then perhaps a warning or two.
  const status = /^(Exit code: -?\d+|Command timed out.*|Command was aborted\.|Command was killed.*)$/
  return text
    .split("\n\n")
    .slice(-3)
    .reverse()
    .find((p) => status.test(p.trim()))
    ?.trim()
}

/**
 * The fixed text an aged result is sent as: what it was, and how to get it back: output_read
 * for what the tool returned then, read for a file as it is now.
 */
export function agedStub(
  m: ToolResultMessage,
  call: ToolCallBlock | undefined,
  artifact: string | undefined,
): string {
  const text = resultText(m) ?? ""
  const lines = text === "" ? 0 : text.split("\n").length
  const facts = [
    `${m.toolName}${m.isError ? ", failed" : ""}`,
    `${n(text.length)} characters`,
    `${n(lines)} lines`,
  ]
  const status = m.toolName === "bash" || m.toolName === "powershell" ? shellStatus(text) : undefined
  if (status) facts.push(status)
  const how: string[] = []
  if (artifact)
    how.push(`its complete text is artifact ${artifact}: output_read({"id":"${artifact}"}) reads it back`)
  if (call?.name === "read" && typeof call.args.path === "string") {
    how.push(`read ${JSON.stringify(call.args.path)} again for the file as it is now`)
  } else if (m.toolName === "bash" || m.toolName === "powershell") {
    how.push("running the command again is a new run, not this output")
  }
  return `[Earlier tool result cleared from the context to save space (${facts.join(", ")}). ${how.length ? `${how.join("; ")}.` : ""}]`
}
