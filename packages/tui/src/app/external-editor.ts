// Owns external-editor command selection and Windows shell quoting.
import { spawnSync } from "node:child_process"

/** Selects an editor command, keeping its arguments for the shell that launches it. */
export function externalEditor(env: Record<string, string | undefined>, cwd: string): string {
  const preferred = env.VISUAL?.trim() || env.EDITOR?.trim()
  if (preferred) return preferred
  const configured = spawnSync("git", ["config", "--get", "core.editor"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
  const command = configured.status === 0 ? configured.stdout?.trim() : ""
  if (command) return process.platform === "win32" ? cmdQuotes(command) : command
  return process.platform === "win32" ? "notepad" : "vi"
}

/** Git for Windows writes `'C:/Program Files/app.exe' -w`; cmd.exe only understands double quotes. */
function cmdQuotes(command: string): string {
  const quoted = /^'([^']*)'/.exec(command)
  return quoted ? `"${quoted[1]}"${command.slice(quoted[0].length)}` : command
}
