import type { FrontendExecuteOptions, FrontendMutations } from "./operations.ts"
import type { FrontendSnapshot, FrontendState, FrontendTranscript } from "./snapshot.ts"

export interface FrontendOperations extends FrontendMutations {
  "state.read": { params: Record<string, never>; result: FrontendState }
  "transcript.read": { params: Record<string, never>; result: FrontendTranscript }
}

export type FrontendUpdate =
  | { readonly kind: "snapshot"; readonly snapshot: FrontendSnapshot }
  | {
      readonly kind: "error"
      readonly error: { readonly code: "invalid_snapshot"; readonly message: string }
    }

export interface FrontendSessionIdentity {
  readonly sessionId: string
  readonly sessionGeneration: number
}

/** Old read-only adapters can derive identity from a successful projection. */
export function frontendIdentity(port: AgentPort): FrontendSessionIdentity {
  return (
    port.identity ?? {
      sessionId: port.snapshot.state.sessionId,
      sessionGeneration: port.snapshot.sessionGeneration,
    }
  )
}

export interface AgentPort {
  /** Current control authority, independent of successful transcript/state projection. */
  readonly identity?: FrontendSessionIdentity
  /** Local frontends stop on quit; detachable runtimes must retain work and dialogs. */
  readonly quitBehavior?: "stop" | "detach"
  /** Missing means negotiated by the adapter; local ports advertise unavailable controls. */
  readonly supportedOperations?: readonly (keyof FrontendOperations)[]
  /**
   * Last successful immutable projection; never performs filesystem or transport IO.
   * Projection failures are published as error updates; execute reads reject until recovery.
   */
  readonly snapshot: FrontendSnapshot
  subscribe(listener: (update: FrontendUpdate) => void): () => void
  execute<K extends keyof FrontendOperations>(
    operation: K,
    params: FrontendOperations[K]["params"],
    options?: FrontendExecuteOptions,
  ): Promise<FrontendOperations[K]["result"]>
  /** Releases this frontend's subscriptions, not the agent or its session. */
  detach(): Promise<void>
}
