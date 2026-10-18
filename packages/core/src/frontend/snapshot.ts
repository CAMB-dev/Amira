import type { Message } from "@amira/ai"
import type { CompactionInfo, NoticeLevel, SessionStatus } from "@amira/api"

export type FrontendJson = null | boolean | number | string | FrontendJson[] | { [key: string]: FrontendJson }

/** Message payloads retain their full content, but opaque tool data must also be finite JSON. */
type JsonData<T> = unknown extends T
  ? FrontendJson
  : T extends readonly (infer V)[]
    ? JsonData<V>[]
    : T extends object
      ? { [K in keyof T]: JsonData<T[K]> }
      : T

export type FrontendMessage = JsonData<Message>

export interface FrontendMessageEntry {
  /** Session-scoped identity, independent of object identity and transcript position. */
  readonly id: string
  readonly entryId?: string
  readonly message: FrontendMessage
  readonly ts?: number
  readonly compaction?: CompactionInfo
}

export interface FrontendDisplayEntry {
  readonly id: string
  /** Index of the next visible message, including when earlier messages were compacted. */
  readonly before: number
  readonly level: NoticeLevel
  readonly text: string
  readonly options: { details?: string; markdown?: boolean }
}

export interface FrontendTranscript {
  readonly messages: readonly FrontendMessageEntry[]
  readonly displays: readonly FrontendDisplayEntry[]
}

export interface FrontendState {
  readonly sessionId: string
  readonly cwd: string
  readonly title?: string
  readonly resumed: boolean
  readonly updatedAt?: number
  readonly status: SessionStatus
  readonly model: { provider: string; id: string; contextWindow: number }
  readonly contextTokens?: number
  readonly children: number
}

export interface FrontendSnapshot {
  /** Increments on active-agent replacement, even when a stored session is resumed again. */
  readonly sessionGeneration: number
  readonly state: FrontendState
  readonly transcript: FrontendTranscript
}
