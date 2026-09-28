// Runs commands off the main thread: spawning can block its thread for seconds on
// some Windows machines (antivirus scanning), which would freeze the UI.
import { warmUpProcessTree } from "./process-tree.ts"
import type { FromWorker, ToWorker } from "./protocol.ts"
import { runCommandInline } from "./run-inline.ts"

declare const self: Worker

const running = new Map<number, AbortController>()
const post = (m: FromWorker) => self.postMessage(m)

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data
  if (msg.type === "warmup") return warmUpProcessTree()
  if (msg.type === "abort") return running.get(msg.id)?.abort()
  const { id, request } = msg
  const abort = new AbortController()
  running.set(id, abort)
  runCommandInline(request.argv, {
    cwd: request.cwd,
    timeoutMs: request.timeoutMs,
    signal: abort.signal,
    onChunk: (chunk) => post({ type: "chunk", id, chunk }),
    ...(request.env ? { env: request.env } : {}),
    ...(request.gated ? { gated: true } : {}),
    ...(request.stdoutOnly ? { stdoutOnly: true } : {}),
  })
    .then(
      (result) => post({ type: "done", id, result }),
      (err) => post({ type: "failed", id, error: err instanceof Error ? err.message : String(err) }),
    )
    .finally(() => running.delete(id))
}
