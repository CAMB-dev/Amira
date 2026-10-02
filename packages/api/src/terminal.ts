export type TerminalProgress = "none" | "indeterminate" | "paused"

/** Structured terminal effects; harmless no-ops in print and RPC frontends. */
export interface TerminalApi {
  setTitle(title: string): void
  setProgress(state: TerminalProgress): void
  bell(): void
}
