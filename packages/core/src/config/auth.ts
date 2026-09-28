import { statSync } from "node:fs"
import path from "node:path"
import { runCommand } from "@amira/proc"
import { amiraHome } from "../home.ts"
import { readJsonFile } from "./load.ts"
import { validateAuth } from "./schema.ts"

export interface LoadedAuth {
  /** API keys by provider id. Environment variables win over these (D54). */
  keys: Record<string, string>
  warnings: string[]
}

export function authFile(home = amiraHome()): string {
  return path.join(home, "auth.json")
}

/**
 * Reads auth.json: `{"<provider>": {"apiKey": "..."}}`. A missing file means no keys. On
 * POSIX systems a file others can read is reported; Windows ACLs are not checked.
 */
export function loadAuth(file = authFile(), platform: string = process.platform): LoadedAuth {
  const raw = readJsonFile(file)
  if (raw === undefined) return { keys: {}, warnings: [] }
  const { keys, warnings } = validateAuth(raw, file)
  if (platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
    warnings.push(`${file} can be read by other users; run: chmod 600 "${file}"`)
  }
  return { keys, warnings }
}

/** Runs a program and gives its exit code and output; injectable for tests. */
export type RunProgram = (argv: string[]) => Promise<{ exitCode: number | null; output: string }>

const runProgram: RunProgram = (argv) =>
  runCommand(argv, {
    cwd: path.dirname(argv[1] ?? "."),
    timeoutMs: 20_000,
    signal: new AbortController().signal,
    // Windows: Bun stalls for seconds on some direct spawns; cmd starts quickly.
    viaCmd: true,
  })

/**
 * Makes a file (auth.json) readable by the current user only. POSIX systems get mode 600
 * when it is written (setAuthKey); on Windows, where files inherit the folder's ACL (a user
 * profile is already private to its user, SYSTEM and administrators), inheritance is removed
 * and only the current user is granted access, with icacls. Resolves with a warning when that
 * did not work; the file is then as private as its folder.
 */
export async function restrictToCurrentUser(
  file: string,
  opts: { platform?: string; env?: Record<string, string | undefined>; run?: RunProgram } = {},
): Promise<string | undefined> {
  if ((opts.platform ?? process.platform) !== "win32") return undefined
  const env = opts.env ?? process.env
  const user = env.USERNAME
  if (!user) return `could not restrict ${file} to your user: USERNAME is not set`
  const principal = env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user
  try {
    const r = await (opts.run ?? runProgram)(["icacls", file, "/inheritance:r", "/grant:r", `${principal}:F`])
    if (r.exitCode === 0) return undefined
    const why = r.output.replace(/\s+/g, " ").trim().slice(0, 200)
    return `could not restrict ${file} to your user (icacls: ${why || `exit ${r.exitCode}`})`
  } catch (err) {
    return `could not restrict ${file} to your user: ${err instanceof Error ? err.message : String(err)}`
  }
}
