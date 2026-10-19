import type {
  BackgroundJobChange,
  BackgroundJobInfo,
  BackgroundJobOperations,
  BackgroundJobOutput,
  BackgroundJobWaitResult,
} from "@amira/api"
import { FrontendOperationError } from "@amira/core"
import { freezeSnapshot, frontendJson } from "../../../core/src/frontend/json.ts"
import type { RemoteJobInfo } from "../remote-schema.ts"

export const SERVER_JOB_OUTPUT_CHARS = 32_768
export interface ServerJobScope {
  conversationId?: string
}
export interface ServerJobOutput extends BackgroundJobOutput {
  /** End of retained output at the read, not the end of this bounded page. */
  availableTo: number
  truncated: boolean
}
export interface ServerJobOperations {
  "jobs.list": {
    params: ServerJobScope & { offset?: number; limit?: number }
    result: { jobs: RemoteJobInfo[]; nextOffset?: number }
  }
  "jobs.output": {
    params: ServerJobScope & { id: string; from?: number; maxChars?: number }
    result: ServerJobOutput
  }
  "jobs.stop": { params: ServerJobScope & { id: string; graceMs?: number }; result: RemoteJobInfo }
  "jobs.wait": {
    params: ServerJobScope & { id: string; from?: number; timeoutMs: number; contains?: string }
    result: BackgroundJobWaitResult
  }
}

export function serverJobInfo(job: BackgroundJobInfo): RemoteJobInfo {
  const { meta: _meta, error: _error, logPath: _path, logError: _logError, ...publicJob } = job
  return freezeSnapshot(frontendJson(publicJob)) as unknown as RemoteJobInfo
}

/** Uses an existing session view, never the host-wide registry or its shared reader cursors. */
export function createServerJobs(deps: {
  jobs: (scope: ServerJobScope) => BackgroundJobOperations | undefined
  generation: () => number
  visible: (job: BackgroundJobInfo, scope: ServerJobScope) => boolean
}) {
  function view(scope: ServerJobScope, id?: string) {
    const jobs = deps.jobs(scope)
    if (!jobs) throw new FrontendOperationError("unsupported_operation", "Jobs are unavailable")
    if (id !== undefined) {
      const job = jobs.get(id)
      if (!job || !deps.visible(job, scope))
        throw new FrontendOperationError("stale_operation", "The job is unavailable in this scope")
    }
    return jobs
  }
  const handlers = {
    "jobs.list": ({ offset = 0, limit = 50, ...scope }: ServerJobOperations["jobs.list"]["params"]) => {
      const all = view(scope)
        .list()
        .filter((job) => deps.visible(job, scope))
      return {
        jobs: all.slice(offset, offset + limit).map(serverJobInfo),
        ...(offset + limit < all.length ? { nextOffset: offset + limit } : {}),
      }
    },
    "jobs.output": ({
      id,
      from = 0,
      maxChars = 16_384,
      ...scope
    }: ServerJobOperations["jobs.output"]["params"]) => {
      const output = view(scope, id).output(id, from)
      if (from > output.to)
        throw new FrontendOperationError("stale_operation", "The output cursor is ahead of the job")
      const text = output.text.slice(0, maxChars)
      return {
        ...output,
        text,
        to: output.from + text.length,
        availableTo: output.to,
        truncated: text.length < output.text.length,
      }
    },
    "jobs.stop": async ({ id, graceMs, ...scope }: ServerJobOperations["jobs.stop"]["params"]) =>
      serverJobInfo(await view(scope, id).stop(id, graceMs)),
    "jobs.wait": async (
      { id, from, timeoutMs, contains, ...scope }: ServerJobOperations["jobs.wait"]["params"],
      signal?: AbortSignal,
    ) => {
      // Literal matching only: remote callers cannot install a pathological regular expression.
      const pattern =
        contains === undefined ? undefined : new RegExp(contains.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      const result = await view(scope, id).waitFor(id, { from, timeoutMs, pattern, signal })
      return result.line === undefined
        ? result
        : { ...result, line: result.line.slice(0, SERVER_JOB_OUTPUT_CHARS) }
    },
  }
  return {
    handlers,
    /** Capture this subscription's generation; a session switch fences queued callbacks. */
    subscribe(
      listener: (change: { type: BackgroundJobChange["type"]; job: RemoteJobInfo }) => void,
      scope: ServerJobScope = {},
    ) {
      const generation = deps.generation()
      return view(scope).subscribe((change) => {
        if (generation === deps.generation() && deps.visible(change.job, scope))
          listener(freezeSnapshot({ type: change.type, job: serverJobInfo(change.job) }))
      })
    },
  }
}
