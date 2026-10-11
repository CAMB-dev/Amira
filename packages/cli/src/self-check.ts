import path from "node:path"
import { commandWorkerStatus, trackProcessTree, warmUpCommands } from "@amira/proc"
import { channel, target, version } from "./version.ts"

/** No settings, network, user-home reads or external extensions. */
export async function selfCheck() {
  // The command Worker is deliberately unref'ed. Keep the CLI alive through its handshake
  // and an ignored-stdio probe, even on Bun builds where awaiting a child alone does not.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    return await check()
  } finally {
    clearInterval(keepAlive)
  }
}

async function check() {
  const errors: string[] = []
  warmUpCommands()
  const deadline = performance.now() + 5000
  while (commandWorkerStatus() === "starting" && performance.now() < deadline) await Bun.sleep(10)
  const worker = commandWorkerStatus()
  if (worker !== "worker") errors.push(`Command Worker did not send ready: ${worker}`)

  let assets = false
  try {
    const compiled = /\/(?:%7EBUN|\$bunfs)\//i.test(import.meta.url)
    const file = compiled
      ? path.join(import.meta.dir, "themes/amira.json")
      : new URL("../themes/amira.json", import.meta.url)
    const theme = await Bun.file(file).json()
    assets = theme.name === "amira" && typeof theme.dark === "object" && typeof theme.light === "object"
    if (!assets) errors.push("Built-in theme is invalid")
  } catch (error) {
    errors.push(`Cannot read built-in theme: ${error instanceof Error ? error.message : String(error)}`)
  }

  let jobObject: boolean | null = null
  if (process.platform === "win32") {
    try {
      // Hold a harmless child at stdin until assignment completes; never kill by image name.
      const child = Bun.spawn(["cmd.exe", "/d", "/q", "/c", "set /p AMIRA_SELF_CHECK= & exit /b 0"], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
      const tree = trackProcessTree(child)
      try {
        jobObject = tree.contained
        child.stdin.end()
        await child.exited
      } finally {
        tree.kill()
        tree.dispose()
      }
      if (!jobObject) errors.push("Windows Job Object is unavailable")
    } catch (error) {
      jobObject = false
      errors.push(`Windows Job Object failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { ok: errors.length === 0, version, channel, target, worker, assets, jobObject, errors }
}
