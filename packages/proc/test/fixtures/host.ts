// Stands in for Amira in the job tests: starts a background job running tree.ts, waits until
// its three processes are up, prints "ready", then ends the way the second argument says:
// "exit" (process.exit), "crash" (an uncaught exception), "sigterm" (sends itself SIGTERM) or
// "wait" (keeps running until the test kills it).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { backgroundJobs } from "../../src/index.ts"

const [pidFile, how] = process.argv.slice(2)
backgroundJobs.start({
  command: "tree",
  argv: [process.execPath, join(import.meta.dir, "tree.ts"), pidFile!],
  cwd: process.cwd(),
})
const count = () => {
  try {
    return readFileSync(pidFile!, "utf8").trim().split("\n").filter(Boolean).length
  } catch {
    return 0
  }
}
const timer = setInterval(() => {
  if (count() < 3) return
  clearInterval(timer)
  console.log("ready")
  if (how === "exit") process.exit(0)
  if (how === "crash") throw new Error("the host crashed")
  if (how === "sigterm") process.kill(process.pid, "SIGTERM")
  setInterval(() => {}, 1 << 30)
}, 20)
