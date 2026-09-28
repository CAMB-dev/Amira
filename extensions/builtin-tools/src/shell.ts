import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, win32 } from "node:path"

export interface Shell {
  kind: "bash" | "powershell"
  path: string
  /** Shown to the model in every result when the shell is not bash. */
  label?: string
  args(command: string): string[]
  /** Built fresh on each read from the current process environment. */
  readonly env: Record<string, string | undefined>
  /** The command waits for a line on stdin before it runs, so the caller can contain it first. */
  gated: boolean
}

/** WSL's bash.exe (System32) and the Store alias (WindowsApps) are never Git Bash. */
export function isRejectedShellPath(path: string): boolean {
  const p = path.replaceAll("/", "\\").toLowerCase()
  return p.includes("\\system32\\") || p.includes("\\windowsapps\\")
}

function bashIn(root: string, exists: (p: string) => boolean): string | undefined {
  // bin/bash.exe is Git's launcher; windowsBashShell maps it to usr/bin/bash.exe.
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

/** Maps Git's bin/bash.exe launcher to the real usr/bin/bash.exe and finds the Git root when it can. */
export function gitBashLayout(path: string, exists: (p: string) => boolean = existsSync) {
  const p = win32.normalize(path)
  const lower = p.toLowerCase()
  if (lower.endsWith("\\usr\\bin\\bash.exe")) {
    return { bash: p, root: win32.dirname(win32.dirname(win32.dirname(p))) }
  }
  if (lower.endsWith("\\bin\\bash.exe")) {
    const root = win32.dirname(win32.dirname(p))
    const real = win32.join(root, "usr", "bin", "bash.exe")
    if (exists(real)) return { bash: real, root }
  }
  return { bash: p, root: undefined }
}

function envKey(env: Record<string, string | undefined>, name: string): string {
  return Object.keys(env).find((k) => k.toUpperCase() === name) ?? name
}

/** The environment Git's bin/bash.exe launcher would give usr/bin/bash.exe. */
export function gitBashEnv(
  root: string,
  base: Record<string, string | undefined> = process.env,
  home = homedir(),
): Record<string, string | undefined> {
  const env = { ...base }
  const pathKey = envKey(env, "PATH")
  const prefix = [win32.join(root, "mingw64", "bin"), win32.join(root, "usr", "bin"), win32.join(home, "bin")]
  env[pathKey] = [...prefix, env[pathKey]].filter(Boolean).join(";")
  for (const [name, value] of [
    ["MSYSTEM", "MINGW64"],
    ["PLINK_PROTOCOL", "ssh"],
  ] as const) {
    const key = envKey(env, name)
    env[key] ??= value
  }
  return env
}

/**
 * Runs the command ($1) only after a line arrives on stdin (see runCommand). The trailing `exit $?` keeps
 * bash from exec-ing the inner shell: a Windows process killed by an MSYS signal exits 0, while the outer
 * shell reports it as 128+n.
 */
export const GATE_SCRIPT = 'read -r _ || exit 125; "$BASH" -c "$1" bash; exit $?'

export function windowsBashShell(found: string, exists: (p: string) => boolean = existsSync): Shell {
  const { bash, root } = gitBashLayout(found, exists)
  return {
    kind: "bash",
    path: bash,
    // A getter, so variables set after the shell was resolved still reach commands.
    get env() {
      return root ? gitBashEnv(root) : { ...process.env }
    },
    gated: true,
    args: (command) => [bash, "-c", GATE_SCRIPT, "bash", command],
  }
}

function posixBashShell(path: string): Shell {
  return {
    kind: "bash",
    path,
    get env() {
      return { ...process.env }
    },
    gated: false,
    args: (command) => [path, "-c", command],
  }
}

export function powershellShell(
  path = Bun.which("pwsh") ?? Bun.which("powershell") ?? "powershell.exe",
): Shell {
  return {
    kind: "powershell",
    path,
    label: "PowerShell (Git Bash not found)",
    get env() {
      return { ...process.env }
    },
    gated: false,
    args: (command) => [path, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
  }
}

let cached: Promise<Shell> | undefined

/** Git Bash on Windows (PowerShell if it is missing), /bin/bash elsewhere. Resolved once per process. */
export function resolveShell(): Promise<Shell> {
  cached ??=
    process.platform === "win32"
      ? findGitBash().then((bash) => (bash ? windowsBashShell(bash) : powershellShell()))
      : Promise.resolve(posixBashShell("/bin/bash"))
  return cached
}

/** Starts shell discovery in the background so the first bash call does not wait for it. */
export function warmUpShell(): void {
  resolveShell().catch(() => {})
}
