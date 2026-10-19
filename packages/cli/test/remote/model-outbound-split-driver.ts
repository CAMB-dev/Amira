import { availableParallelism } from "node:os"
import { fieldCases } from "./model-outbound-fields.ts"
import { credentialSources } from "./model-outbound-sources.ts"
import type { SplitJob, SplitReply } from "./model-outbound-split-worker.ts"

// Parent lowers only this CPU-bound subprocess's priority before opening its start gate.
// Provider execution is never part of the matrix; fail closed if a helper tries networking.
const deny = () => {
  throw new Error("Networking is forbidden in the outbound matrix")
}
globalThis.fetch = Object.assign(deny, { preconnect: deny })
Bun.connect = deny
Bun.listen = deny
if ((await Bun.stdin.text()) !== "run\n") throw new Error("Missing matrix start gate")

const fields = fieldCases()
const jobs: SplitJob[] = credentialSources().flatMap((source) =>
  source.variants.flatMap((variant) =>
    Array.from({ length: variant.length + 1 }, (_, split) => ({ source, variant, split })),
  ),
)
const done = Promise.withResolvers<void>()
const workers: Worker[] = []
let next = 0
let completed = 0
let rows = 0
let rejected = 0
const timeout = setTimeout(
  () =>
    done.reject(
      new Error(
        `Exhaustive outbound matrix exceeded its 890-second budget: ${completed}/${jobs.length} split jobs (${rows} rows) completed`,
      ),
    ),
  890_000,
)
try {
  // All rows still execute. Keeping the compute pool out of the native test VMs also
  // prevents it from starving their short process/PTY readiness deadlines.
  for (let index = 0; index < Math.min(16, availableParallelism(), jobs.length); index++) {
    const worker = new Worker(new URL("./model-outbound-split-worker.ts", import.meta.url).href)
    workers.push(worker)
    worker.onerror = (error) => done.reject(new Error(error.message))
    worker.onmessage = ({ data }: MessageEvent<SplitReply>) => {
      if ("error" in data) {
        done.reject(new Error(data.error))
        return
      }
      rows += data.rows
      rejected += data.rejected
      completed++
      if (completed === jobs.length) done.resolve()
      else if (next < jobs.length) worker.postMessage(jobs[next++]!)
    }
    worker.postMessage(jobs[next++]!)
  }
  await done.promise
  process.stdout.write(
    JSON.stringify({
      completed,
      jobs: jobs.length,
      rows,
      expectedRows: jobs.length * fields.length ** 2,
      rejected,
    }),
  )
} finally {
  clearTimeout(timeout)
  for (const worker of workers) worker.terminate()
}
