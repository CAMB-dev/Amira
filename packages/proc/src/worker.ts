// Runs commands off the main thread: spawning can block its thread for seconds on
// some Windows machines (antivirus scanning), which would freeze the UI.
// Every spawn with pipes happens on this one thread: see `openPipe` in index.ts.
import { openPipeInline, type PipeHandle } from "./pipe.ts"
import { warmUpProcessTree } from "./process-tree.ts"
import type { FromWorker, ReleaseRequest, SpawnRequest, ToWorker } from "./protocol.ts"
import {
  type PreparedCommand,
  prepareCommandInline,
  type ReleaseOptions,
  type RunResult,
  runCommandInline,
  StandbyGoneError,
} from "./run-inline.ts"

declare const self: Worker

const running = new Map<number, AbortController>()
/** Prepared commands waiting for their release. */
const prepared = new Map<number, PreparedCommand>()
/** Piped processes that have not exited yet. */
const pipes = new Map<number, PipeHandle>()
const post = (m: FromWorker) => self.postMessage(m)

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data
  switch (msg.type) {
    case "warmup":
      try {
        warmUpProcessTree()
      } catch {}
      return
    case "abort":
      return running.get(msg.id)?.abort()
    case "prepare":
      return prepare(msg.id, msg.request)
    case "pipe-open": {
      const { id } = msg
      let exited = false
      const handle = openPipeInline(msg.spec, (event) => {
        if (event.type === "exit") {
          exited = true
          pipes.delete(id)
        }
        post({ type: "pipe", id, event })
      })
      // A failed spawn has reported its exit already.
      if (!exited) pipes.set(id, handle)
      return
    }
    case "pipe-write":
      return pipes.get(msg.id)?.write(msg.data)
    case "pipe-close":
      return pipes.get(msg.id)?.close(msg.graceMs)
    case "dispose":
      prepared.get(msg.id)?.dispose()
      prepared.delete(msg.id)
      return
    case "run":
      return track(msg.id, msg.request, (opts) =>
        runCommandInline(msg.request.argv, { ...msg.request, ...opts }),
      )
    case "release": {
      const command = prepared.get(msg.id)
      prepared.delete(msg.id)
      return track(msg.id, msg.request, (opts) =>
        command ? command.run(opts) : Promise.reject(new StandbyGoneError("the prepared command is gone")),
      )
    }
  }
}

function prepare(id: number, request: SpawnRequest) {
  try {
    const command = prepareCommandInline(request.argv, request, () => {
      if (prepared.get(id) !== command) return
      prepared.delete(id)
      post({ type: "gone", id })
    })
    prepared.set(id, command)
  } catch {
    post({ type: "gone", id })
  }
}

/** Runs a command under an abort controller the main thread can reach, and reports back. */
function track(id: number, request: ReleaseRequest, start: (opts: ReleaseOptions) => Promise<RunResult>) {
  const abort = new AbortController()
  running.set(id, abort)
  start({
    timeoutMs: request.timeoutMs,
    signal: abort.signal,
    onChunk: (chunk) => post({ type: "chunk", id, chunk }),
    ...(request.gateLine !== undefined ? { gateLine: request.gateLine } : {}),
  })
    .then(
      (result) => post({ type: "done", id, result }),
      (err) =>
        post({
          type: "failed",
          id,
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof StandbyGoneError ? { gone: true } : {}),
        }),
    )
    .finally(() => running.delete(id))
}

post({ type: "ready" })
