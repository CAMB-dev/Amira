import * as fs from "node:fs"
import path from "node:path"

const WAIT_MS = 30_000

type Worker = Pick<Bun.Subprocess, "pid" | "exitCode" | "exited" | "stderr">

/** A polling interval is not a completion estimate; only the observed event ends the wait. */
export async function waitForFileLockCondition(
  label: string,
  condition: () => boolean,
  timeoutMs = WAIT_MS,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(`${label} timed out after ${timeoutMs}ms`)
    await Bun.sleep(10)
  }
}

/** Keep interpreter/module startup outside the operation being exercised. */
export async function fileLockWorkerReady(dir: string): Promise<void> {
  fs.writeFileSync(path.join(dir, "worker-ready"), "ready")
  await waitForFileLockCondition("file-lock worker waiting for go", () =>
    fs.existsSync(path.join(dir, "worker-go")),
  )
  fs.rmSync(path.join(dir, "worker-ready"))
  fs.rmSync(path.join(dir, "worker-go"))
}

export async function waitForFileLockWorkerReady(worker: Worker, dir: string, label: string) {
  await waitForFileLockCondition(`${label} readiness (pid ${worker.pid})`, () => {
    if (fs.existsSync(path.join(dir, "worker-ready"))) return true
    if (worker.exitCode !== null)
      throw new Error(`${label} exited before readiness (pid ${worker.pid}, code ${worker.exitCode})`)
    return false
  }).catch(async (error) => {
    if (worker.exitCode !== null && worker.stderr instanceof ReadableStream) {
      throw new Error(`${error.message}: ${await new Response(worker.stderr).text()}`)
    }
    throw error
  })
  fs.writeFileSync(path.join(dir, "worker-go"), "go")
}

export async function waitForFileLockWorkerExit(worker: Worker, label: string, timeoutMs = WAIT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      worker.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exit timed out after ${timeoutMs}ms (pid ${worker.pid})`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
