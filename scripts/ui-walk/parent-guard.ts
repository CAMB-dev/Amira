import path from "node:path"
import type { Subprocess } from "bun"

export interface ParentGuard {
  exited: Promise<number>
  stop(): Promise<void>
}

/** POSIX guardian is detached from both daemon and Amira, and retains only a private lifetime pipe. */
export async function armParentGuard(
  child: Subprocess,
  root: string,
  cwd: string,
  env: Record<string, string>,
): Promise<ParentGuard> {
  const guard = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "watchdog.ts"), String(child.pid), root],
    {
      cwd,
      env,
      detached: true,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    },
  )
  let stopping: Promise<void> | undefined
  const stop = () => {
    stopping ??= (async () => {
      try {
        guard.stdin.write("disarm\n")
        guard.stdin.end()
      } catch {}
      await guard.exited
    })()
    return stopping
  }
  const reader = guard.stdout.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const ready = (async () => {
      let output = ""
      while (!output.includes("\n")) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error("POSIX parent guardian exited before arming")
        output += new TextDecoder().decode(chunk.value)
      }
      if (output !== "armed\n") throw new Error("Invalid POSIX parent guardian handshake")
    })()
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("POSIX parent guardian did not arm")), 5000)
      }),
    ])
    child.send("ui-walk-start")
    return { exited: guard.exited, stop }
  } catch (error) {
    await stop()
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    reader.releaseLock()
  }
}
