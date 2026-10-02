import type { EventMap } from "./events.ts"

/** Workspace data only; the host owns the event envelope. */
export type WorkspaceFacts = EventMap["workspace.changed"]

export interface WorkspaceProvider {
  /**
   * Return facts for exactly cwd, or undefined when unavailable. Honor cancellation.
   * A dirty probe may reuse previously probed metadata; returning full facts is also valid.
   */
  probe(cwd: string, signal: AbortSignal, kind?: "full" | "dirty"): Promise<WorkspaceFacts | undefined>
  /**
   * Cheap metadata fingerprint, including repository appearance/disappearance. No processes.
   * Without a stamp, the host requests a full probe after each turn.
   */
  stamp?(cwd: string): string | undefined
}
