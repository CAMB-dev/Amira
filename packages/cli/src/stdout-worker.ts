import { writeSync } from "node:fs"
import type { FromStdoutWorker, ToStdoutWorker } from "./stdout-writer.ts"

// Writes stdout on its own thread: a full pipe blocks here, not on the main thread.
declare const self: Worker

const post = (m: FromStdoutWorker) => self.postMessage(m)

self.onmessage = (e: MessageEvent<ToStdoutWorker>) => {
  const buf = Buffer.from(e.data.text)
  let off = 0
  try {
    while (off < buf.length) {
      try {
        off += writeSync(1, buf, off)
      } catch (err) {
        // A non-blocking stdout (POSIX) reports a full pipe as EAGAIN; wait and retry.
        if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      }
    }
  } catch (err) {
    post({ type: "closed", error: err instanceof Error ? err.message : String(err) })
    return
  }
  post({ type: "written", seq: e.data.seq })
}
post({ type: "ready" })
