import { spawn } from "node:child_process"
import { closeSync } from "node:fs"

/** Starts `<command> daemon --cwd <workspace>` detached, with both outputs on the opened log. */
export async function spawnDetachedDaemon(
  command: readonly string[],
  modelMode: "local-proxy" | "remote-key",
  workspace: string,
  log: number,
): Promise<void> {
  try {
    const child = spawn(
      command[0]!,
      [
        ...command.slice(1),
        "daemon",
        "--cwd",
        workspace,
        ...(modelMode === "remote-key" ? ["--remote-key"] : []),
      ],
      {
        detached: true,
        stdio: ["ignore", log, log],
        windowsHide: true,
        env: process.env,
      },
    )
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject)
      child.once("spawn", resolve)
    })
    child.unref()
  } finally {
    closeSync(log)
  }
}
