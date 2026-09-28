import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

export interface Shell {
  kind: "bash" | "powershell"
  path: string
  args(command: string): string[]
}

/** WSL's bash.exe (System32) and the Store alias (WindowsApps) are never Git Bash. */
export function isRejectedShellPath(path: string): boolean {
  const p = path.replaceAll("/", "\\").toLowerCase()
  return p.includes("\\system32\\") || p.includes("\\windowsapps\\")
}

function bashIn(root: string, exists: (p: string) => boolean): string | undefined {
  // bin/bash.exe is Git's launcher: it sets up PATH (/usr/bin etc.) before starting usr/bin/bash.exe.
  for (const rel of ["bin/bash.exe", "usr/bin/bash.exe"]) {
    const p = join(root, rel)
    if (exists(p) && !isRejectedShellPath(p)) return p
  }
  return undefined
}

/** Walks up from `git --exec-path` (e.g. <root>/mingw64/libexec/git-core) looking for the Git root. */
export function bashFromGitExecPath(execPath: string, exists: (p: string) => boolean = existsSync) {
  let dir = execPath.trim()
  for (let i = 0; i < 4 && dir; i++) {
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
    const found = bashIn(dir, exists)
    if (found) return found
  }
  return undefined
}

async function gitExecPath(): Promise<string | undefined> {
  try {
    const p = Bun.spawn(["git", "--exec-path"], { stdout: "pipe", stderr: "ignore", windowsHide: true })
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
    return code === 0 ? out.trim() : undefined
  } catch {
    return undefined
  }
}

export interface FindGitBashDeps {
  env?: Record<string, string | undefined>
  exists?: (p: string) => boolean
  gitExecPath?: () => Promise<string | undefined>
}

export async function findGitBash(deps: FindGitBashDeps = {}): Promise<string | undefined> {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const override = env.AMIRA_BASH
  if (override && exists(override) && !isRejectedShellPath(override)) return override

  const execPath = await (deps.gitExecPath ?? gitExecPath)()
  const derived = execPath ? bashFromGitExecPath(execPath, exists) : undefined
  if (derived) return derived

  const roots = [
    env.ProgramFiles && join(env.ProgramFiles, "Git"),
    env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Git"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Git"),
    env.USERPROFILE && join(env.USERPROFILE, "scoop", "apps", "git", "current"),
    "C:\\Program Files\\Git",
  ]
  for (const root of roots) {
    const found = root && bashIn(root, exists)
    if (found) return found
  }
  return undefined
}

function bashShell(path: string): Shell {
  return { kind: "bash", path, args: (command) => [path, "-c", command] }
}

function powershell(): Shell {
  const path = Bun.which("pwsh") ?? Bun.which("powershell") ?? "powershell.exe"
  return {
    kind: "powershell",
    path,
    args: (command) => [path, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
  }
}

let cached: Promise<Shell> | undefined

/** Git Bash on Windows (PowerShell if it is missing), /bin/bash elsewhere. Resolved once per process. */
export function resolveShell(): Promise<Shell> {
  cached ??=
    process.platform === "win32"
      ? findGitBash().then((bash) => (bash ? bashShell(bash) : powershell()))
      : Promise.resolve(bashShell("/bin/bash"))
  return cached
}
