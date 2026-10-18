import type { FrontendSnapshot, FrontendState, FrontendTranscript } from "./snapshot.ts"

/** R1 exposes reads only. Turn, command, session and dialog operations follow at this seam. */
export interface FrontendOperations {
  "state.read": { params: Record<string, never>; result: FrontendState }
  "transcript.read": { params: Record<string, never>; result: FrontendTranscript }
}

export type FrontendUpdate =
  | { readonly kind: "snapshot"; readonly snapshot: FrontendSnapshot }
  | {
      readonly kind: "error"
      readonly error: { readonly code: "invalid_snapshot"; readonly message: string }
    }

export interface AgentPort {
  /**
   * Last successful immutable projection; never performs filesystem or transport IO.
   * Projection failures are published as error updates; execute reads reject until recovery.
   */
  readonly snapshot: FrontendSnapshot
  subscribe(listener: (update: FrontendUpdate) => void): () => void
  execute<K extends keyof FrontendOperations>(
    operation: K,
    params: FrontendOperations[K]["params"],
  ): Promise<FrontendOperations[K]["result"]>
  /** Releases this frontend's subscriptions, not the agent or its session. */
  detach(): Promise<void>
}
