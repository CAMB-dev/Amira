/** A file tool's complete intended change. null means the path does not exist. */
export interface FileMutation {
  path: string
  /** If supplied, refuse stale edits before invoking the writer. */
  before?: Uint8Array | null
  after: Uint8Array | null
}

/** Captures all pre-images before running the writer, including a patch's own rollback. */
export type MutateFiles = (changes: FileMutation[], write: () => Promise<void>) => Promise<void>

export interface FileRewindPlan {
  owner: string
  enabled: boolean
  restored: number
  removed: number
  conflicts: string[]
  /** Explains coverage, disabled capture or pruned history. */
  note: string
}

export interface RewindOptions {
  /** Defaults to true. An extension owner replaces the core restore, never supplements it. */
  restoreFiles?: boolean
}

export interface FileRestorationOwner {
  /** The option the rewind picker shows, e.g. "Restore checkpoint files". */
  label: string
  /** Called before the conversation changes. Throw to leave the conversation unchanged. */
  restore(index: number): Promise<void>
}
