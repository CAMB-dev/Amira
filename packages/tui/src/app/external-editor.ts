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
  return (
    (configured.status === 0 && configured.stdout?.trim()) ||
    (process.platform === "win32" ? "notepad" : "vi")
  )
}
