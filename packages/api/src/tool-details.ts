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
  durationMs: number
  /** Lines of output the command printed. */
  outputLines: number
}

/**
 * A background job as the shell tools (background: true) and the job tools report it: what it
 * runs and how it is doing at the time of the result.
 */
export interface BackgroundJobDetails {
  jobId: string
  command: string
  /** "starting", "running", "exited", "stopped" or "failed". */
  status: string
  exitCode: number | null
  pid?: number
  /** The job's whole output, as far as it was written. */
  logPath?: string
  /** Lines of output in this result. */
  outputLines: number
  /** job_output with a pattern: whether a line matched, the job ended, or the wait timed out. */
  waited?: "match" | "exit" | "timeout" | "aborted"
}

/** job_list: the jobs the calling session can see. */
export interface JobListDetails {
  jobs: { jobId: string; command: string; status: string; exitCode: number | null }[]
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
}

export interface GlobDetails {
  count: number
  fullOutputPath?: string
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
