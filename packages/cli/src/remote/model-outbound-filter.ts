import type { CompactReceipt, CompactResult, StreamEvent } from "@amira/ai"
import type { UsageReceipt } from "@amira/ai/accounting"
import type { ModelMetadata } from "./model-broker.ts"
import {
  assertModelOutbound,
  encodeCompactReceipt,
  encodeCompactResult,
  encodeModelEvent,
  ModelOutboundError,
} from "./model-codec.ts"
import { type ModelStringRef, modelStringViews } from "./model-observable-strings.ts"
import { validateModelValue } from "./model-schema.ts"
import { ModelStringHistory } from "./model-string-history.ts"
import { maskModelFragments, redactModelValue } from "./model-string-masks.ts"
import type { RemoteJson } from "./protocol.ts"
import { secretPatterns } from "./secret-patterns.ts"

export type ModelOutboundItem =
  | { kind: "event"; value: StreamEvent }
  | { kind: "receipt"; value: CompactReceipt }
  | { kind: "compact"; value: CompactResult }
  | { kind: "metadata"; value: ModelMetadata[] }
interface Pending {
  item: ModelOutboundItem
  shape: RemoteJson
  identity: number
  receipts: readonly UsageReceipt[]
}
interface Segment {
  entry: Pending
  refs: ModelStringRef[]
}

/** One publication filter for every model DTO, not separate redactors for each event kind.
 * Schema-owned keys/tags/enums are individually masked and audited, never protective padding.
 * Free-form strings, chronological deltas, original lanes and message blocks share one
 * fixed-point masker and longest-variant holdback. Flush keeps committed suffixes for late receipts.
 */
export class ModelOutboundFilter {
  private secrets: readonly string[]
  private holdback: number
  private pending: Pending[] = []
  private tails = new Map<string, string>()
  private identity = 0
  private history: ModelStringHistory
  private representations: (value: number) => readonly string[]

  constructor(
    secrets: readonly string[],
    private limits: { maxBytes?: number; maxItems?: number } = {},
  ) {
    const prepared = secretPatterns(secrets)
    this.secrets = prepared.values
    this.holdback = prepared.holdback
    this.representations = prepared.representations
    this.history = new ModelStringHistory(this.secrets)
  }

  push(item: ModelOutboundItem): ModelOutboundItem[] {
    let entry: Pending | undefined
    try {
      const shape = validateModelValue(item.kind, item.value)
      // Validation precedes traversal so getters/serialization hooks never run here.
      const copy = { kind: item.kind, value: redactModelValue(item.value, this.secrets) } as ModelOutboundItem
      validateModelValue(copy.kind, copy.value)
      const receipts = this.audit(copy)
      entry = { item: copy, shape, identity: ++this.identity, receipts }
      this.pending.push(entry)
      this.mask()
      return this.take(false)
    } catch (error) {
      // A failed push must never be revived by the caller's safe-partial/failure flush.
      this.pending = this.pending.filter((pending) => pending !== entry)
      throw error instanceof ModelOutboundError ? error : new ModelOutboundError()
    }
  }

  flush(): ModelOutboundItem[] {
    try {
      this.mask()
      return this.take(true)
    } catch (error) {
      throw error instanceof ModelOutboundError ? error : new ModelOutboundError()
    }
  }

  /** Drop unpublishable data, not the immutable suffix that already crossed the boundary. */
  discard(): void {
    this.pending = []
  }

  /** Metadata publication can seed a new call without sharing mutable drafts or queues. */
  fork(): ModelOutboundFilter {
    const next = new ModelOutboundFilter(this.secrets, this.limits)
    next.tails = new Map(this.tails)
    next.history = this.history.fork()
    return next
  }

  private audit(item: ModelOutboundItem): readonly UsageReceipt[] {
    if (item.kind === "metadata") {
      assertModelOutbound(item.value, this.secrets)
      return []
    }
    const encoded =
      item.kind === "event"
        ? encodeModelEvent(item.value, this.secrets)
        : item.kind === "receipt"
          ? encodeCompactReceipt(item.value, this.secrets)
          : encodeCompactResult(item.value, this.secrets)
    return encoded.usage.map((entry) => entry.receipt)
  }

  private views(): Map<string, Segment[]> {
    const groups = new Map<string, Segment[]>()
    for (const entry of this.pending) {
      for (const [name, refs] of modelStringViews(
        entry.item,
        entry.shape,
        entry.identity,
        entry.receipts,
        this.representations,
      )) {
        if (!refs.length) continue
        const segments = groups.get(name) ?? []
        segments.push({ entry, refs })
        groups.set(name, segments)
      }
    }
    if (groups.size + this.tails.size > 8192) throw new ModelOutboundError()
    return groups
  }

  private mask(): void {
    if (this.pending.length > (this.limits.maxItems ?? 4096)) throw new ModelOutboundError()
    for (let round = 0; round < 1024; round++) {
      let changed = false
      for (const [name, segments] of this.views()) {
        const refs = segments.flatMap((segment) => segment.refs)
        const tail = this.tails.get(name) ?? ""
        const parts = refs.map((ref) => ref.read())
        const masked = maskModelFragments([tail, ...parts], this.secrets, tail.length).slice(1)
        for (let index = 0; index < refs.length; index++) {
          if (parts[index] === masked[index]) continue
          refs[index]!.write(masked[index]!)
          changed = true
        }
      }
      const history = this.history.fork()
      for (const segment of this.views().get("payload") ?? []) {
        for (const ref of segment.refs) {
          if (ref.representations) {
            history.immutable(ref.representations)
            continue
          }
          const before = ref.read()
          const after = history.mask(before)
          if (before !== after) {
            ref.write(after)
            changed = true
          }
        }
      }
      const bytes = this.pending.reduce(
        (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.item)),
        0,
      )
      if (bytes > (this.limits.maxBytes ?? 32 * 1024 * 1024)) throw new ModelOutboundError()
      if (!changed) return
    }
    throw new ModelOutboundError()
  }

  private take(final: boolean): ModelOutboundItem[] {
    const output: ModelOutboundItem[] = []
    while (this.pending.length) {
      const first = this.pending[0]!
      const groups = this.views()
      if (!final && this.holdback) {
        let held = false
        for (const [name, segments] of groups) {
          // Only the chronological publication has a pending suffix. Message views are
          // closed items; paused lanes use immutable committed tails/continuation states
          // when they resume, rather than blocking unrelated lanes indefinitely.
          if (name !== "payload") continue
          const own = segments.filter((segment) => segment.entry === first).flatMap((segment) => segment.refs)
          if (!own.some((ref) => ref.read().length)) continue
          const remaining = segments
            .filter((segment) => segment.entry !== first)
            .reduce(
              (sum, segment) => sum + segment.refs.reduce((length, ref) => length + ref.read().length, 0),
              0,
            )
          if (remaining < this.holdback) {
            held = true
            break
          }
        }
        if (held) break
      }
      this.audit(first.item)
      for (const segment of groups.get("payload") ?? []) {
        if (segment.entry !== first) continue
        for (const ref of segment.refs) {
          if (ref.representations) this.history.immutable(ref.representations)
          else if (this.history.mask(ref.read()) !== ref.read()) throw new ModelOutboundError()
        }
      }
      for (const [name, segments] of groups) {
        if (!this.holdback || name.startsWith("message:")) continue // Message-local projection ends with this item.
        const strings = segments
          .filter((segment) => segment.entry === first)
          .flatMap((segment) => segment.refs)
          .map((ref) => ref.read())
          .join("")
        if (!strings) continue
        this.tails.set(name, ((this.tails.get(name) ?? "") + strings).slice(-this.holdback || Infinity))
      }
      this.pending.shift()
      output.push(first.item)
    }
    return output
  }
}
