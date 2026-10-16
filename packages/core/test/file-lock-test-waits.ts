import * as fs from "node:fs"
import path from "node:path"
import {
  waitForSpawnCondition as waitForFileLockCondition,
  waitForSpawnExit as waitForFileLockWorkerExit,
  waitForSpawnWork,
} from "../../../scripts/spawn-test.ts"

export { waitForFileLockCondition, waitForFileLockWorkerExit }

type Worker = Pick<Bun.Subprocess, "pid" | "exitCode" | "exited" | "stderr">

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
      throw new Error(
        `${error.message}: ${await waitForSpawnWork(`worker stderr (pid ${worker.pid})`, new Response(worker.stderr).text())}`,
      )
    }
    throw error
  })
  fs.writeFileSync(path.join(dir, "worker-go"), "go")
}
