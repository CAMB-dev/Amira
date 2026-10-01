/**
 * The `details` the built-in tools put in their results (D2), for presenters and other
 * frontends. Details never reach the model. Fields are only ever added.
 */

/**
 * One hunk of a unified diff. `lines` start with " " (context), "-" (removed) or "+" (added);
 * line numbers are 1-based.
 */
export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/** A change to a file as hunks, with the total lines added and removed. */
export interface FileDiff {
  hunks: DiffHunk[]
  added: number
  removed: number
  /** Hunks were left out because the change was too large to diff. */
  truncated?: boolean
}

export interface ReadDetails {
  path: string
  /** Set for images. */
  mimeType?: string
  bytes?: number
  /** First line shown and how many lines were shown, for text. */
  startLine?: number
  lines?: number
  /** Lines in the file, when the read got to its end. */
  totalLines?: number
}

export interface EditDetails extends FileDiff {
  path: string
  replacements: number
}

export interface ApplyPatchDetails {
  files: (FileDiff & {
    path: string
    from?: string
    action: "add" | "update" | "delete" | "move"
  })[]
}

export interface WriteDetails extends FileDiff {
  path: string
  created: boolean
  lines: number
  bytes: number
}

export interface BashDetails {
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  settled: boolean
  shell: string
  shellKind: string
  /** Where the whole output went when it was too long to return. */
  fullOutputPath?: string
  /** The artifact the whole output was saved as, when it was too long to return. */
  artifact?: string
  durationMs: number
  /** Lines of output the command printed. */
  outputLines: number
}

export interface GrepDetails {
  mode: "files_with_matches" | "content" | "count"
  /** Files with at least one match. */
  matchedFiles: number
  /** Matching lines; unknown in files_with_matches mode, which stops at a file's first match. */
  matches?: number
  /** Results before head_limit: files, lines or counts depending on the mode. */
  total: number
  fullOutputPath?: string
  /** The artifact all results were saved as, when they were too long to return. */
  artifact?: string
}

export interface GlobDetails {
  count: number
  fullOutputPath?: string
  /** The artifact all paths were saved as, when they were too long to return. */
  artifact?: string
}

export interface WebSearchDetails {
  backend: string
  results: { title: string; url: string }[]
  failures: string[]
}

export interface WebFetchDetails {
  url: string
  finalUrl: string
  status: number
  /** Characters of the page's text. */
  length: number
}
