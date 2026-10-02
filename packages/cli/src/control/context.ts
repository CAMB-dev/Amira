import type { Ai } from "@amira/ai"
import type { ShellMode, TraceRecord } from "@amira/api"
import type { Agent, SessionEntry, SessionStore, ToolRegistry } from "@amira/core"
import type { Session } from "../session.ts"

export type SwitchReason = "resume" | "clear" | "fork"

/** Host-owned trace I/O; reading never drains the shared event bus. */
export interface ControlTrace {
  read(file: string): Promise<TraceRecord[]>
  forget(sessionIds: string[]): Promise<void>
}

export interface ControlContext {
  readonly session: Session
  readonly trace?: ControlTrace
  readonly cwd: string
  readonly ai: Ai
  readonly tools: ToolRegistry
  readonly platform: string
  readonly home?: string
  readonly agent: () => Agent
  readonly directory: () => string | undefined
  readonly idle: (what: string) => void
  readonly switchTo: (rootSessionId: string, makeNext: () => Agent, reason: SwitchReason) => Promise<void>
  readonly rewindEntry: (index: number) => {
    a: Agent
    store: SessionStore
    entry: Extract<SessionEntry, { type: "message" }>
  }
  readonly idleFiles: () => void
  readonly applyDisabled: () => void
  readonly shell: {
    get(): ShellMode
    set(mode: ShellMode): void
  }
  readonly turnedOff: Set<string>
  readonly turnedOn: Set<string>
}
