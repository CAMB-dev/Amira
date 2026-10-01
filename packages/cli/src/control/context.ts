import type { Ai } from "@amira/ai"
import type { ShellMode } from "@amira/api"
import type { Agent, SessionEntry, SessionStore, ToolRegistry } from "@amira/core"
import type { Session } from "../session.ts"

export type SwitchReason = "resume" | "clear" | "fork"

export interface ControlContext {
  readonly session: Session
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
