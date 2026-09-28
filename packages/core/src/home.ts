import os from "node:os"
import path from "node:path"

/**
 * Amira's per-user directory: `$AMIRA_HOME`, or `~/.amira`. Holds settings, auth, sessions,
 * caches, packages and worktrees (D35, D54, D56, D60, D62).
 */
export function amiraHome(env: Record<string, string | undefined> = process.env): string {
  return env.AMIRA_HOME ? path.resolve(env.AMIRA_HOME) : path.join(os.homedir(), ".amira")
}

/** A path inside the user directory, e.g. `amiraPath("sessions")`. */
export function amiraPath(...parts: string[]): string {
  return path.join(amiraHome(), ...parts)
}

/** The project-level directory for a working directory: `<cwd>/.amira`. */
export function projectAmiraDir(cwd: string): string {
  return path.join(cwd, ".amira")
}
