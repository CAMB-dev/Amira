import { readFile } from "node:fs/promises"
import path from "node:path"
import { removeOwnedRoot } from "./ownership.ts"
import type { SessionConfig } from "./session.ts"

/** EOF is tied to a private pipe, not parent-PID polling (which could mistake a reused PID). */
export async function watchParent(
  input: AsyncIterable<Uint8Array>,
  parentDied: () => void | Promise<void>,
): Promise<void> {
  const decoder = new TextDecoder()
  let command = ""
  let disarmed = false
  try {
    for await (const chunk of input) {
      command += decoder.decode(chunk, { stream: true })
      if (command.includes("\n")) {
        if (command !== "disarm\n") throw new Error("Invalid watchdog command")
        disarmed = true
        return
      }
      if (command.length > 16) throw new Error("Invalid watchdog command")
    }
  } finally {
    if (!disarmed) await parentDied()
  }
}

if (import.meta.main) {
  const pid = Number(process.argv[2])
  const root = process.argv[3]!
  if (process.platform === "win32" || !Number.isSafeInteger(pid) || pid <= 1)
    throw new Error("Invalid POSIX watchdog target")
  const owner: SessionConfig = JSON.parse(await readFile(path.join(root, "config.json"), "utf8"))
  process.stdout.write("armed\n")
  await watchParent(Bun.stdin.stream(), async () => {
    try {
      process.kill(-pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
    await removeOwnedRoot(owner)
  })
}
