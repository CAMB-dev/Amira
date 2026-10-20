import { commandWorkerStatus, warmUpCommands } from "../../packages/proc/src/index.ts"

/** Settings-free native smoke: no network, shell child, themes or user-home access. */
export async function serverSelfCheck() {
  const errors: string[] = []
  const keepAlive = setInterval(() => {}, 1000)
  let stdout: Worker | undefined
  try {
    warmUpCommands()
    const deadline = performance.now() + 5000
    while (commandWorkerStatus() === "starting" && performance.now() < deadline) await Bun.sleep(10)
    const worker = commandWorkerStatus()
    if (worker !== "worker") errors.push(`Command Worker did not send ready: ${worker}`)
    let stdoutWorker = false
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Stdout Worker did not send ready")), 5000)
        try {
          stdout = new Worker(new URL("./stdout-worker.ts", import.meta.url).href)
          stdout.onmessage = (event) => {
            if (event.data?.type !== "ready") return
            clearTimeout(timeout)
            stdoutWorker = true
            resolve()
          }
          stdout.onerror = () => {
            clearTimeout(timeout)
            reject(new Error("Stdout Worker failed"))
          }
        } catch (error) {
          clearTimeout(timeout)
          reject(error)
        }
      })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
    return { ok: errors.length === 0, worker, stdoutWorker, errors }
  } finally {
    await stdout?.terminate()
    clearInterval(keepAlive)
  }
}
