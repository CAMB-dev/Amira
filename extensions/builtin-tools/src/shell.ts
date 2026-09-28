import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, win32 } from "node:path"
import { runCommand } from "@amira/proc"
import { findPowerShell, gatedPowerShell, powershellEdition, resolvePowerShell } from "./powershell.ts"

/** How to run one command: argv plus the matching runCommand options. */
export interface ShellCommand {
  argv: string[]
  /** Built fresh from the current process environment. */
  env: Record<string, string | undefined>
  /** The command waits for a line on stdin before it runs, so the caller can contain it first. */
  gated: boolean
  gateLine?: string
  viaCmd?: boolean
}

export interface Shell {
  kind: "bash" | "powershell"
  path: string
  /** Shown to the model in every result when the shell is not bash. */
  label?: string
  command(command: string): ShellCommand
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
    // Off the main thread: a slow spawn must not freeze the UI.
    const run = await runCommand(["git", "--exec-path"], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      stdoutOnly: true,
      viaCmd: true,
    })
    return run.exitCode === 0 ? run.output.trim() : undefined
  } catch {
    return undefined
  }
}

export interface FindGitBashDeps {
  env?: Record<string, string | undefined>
  exists?: (p: string) => boolean
  gitExecPath?: () => Promise<string | undefined>
  /** Looks a program up on PATH. Defaults to Bun.which. */
  which?: (name: string) => string | null
}

export async function findGitBash(deps: FindGitBashDeps = {}): Promise<string | undefined> {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const override = env.AMIRA_BASH
  if (override && exists(override) && !isRejectedShellPath(override)) return override

  // Cheapest first: git.exe on PATH points at the Git root without spawning anything.
  // Spawning git can take seconds on machines where antivirus scans new processes.
  const gitOnPath = (deps.which ?? Bun.which)("git")
  const fromPath =
    gitOnPath && !isRejectedShellPath(gitOnPath) ? bashFromGitExecPath(gitOnPath, exists) : undefined
  if (fromPath) return fromPath

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

  // Last resort: ask git where it lives.
  const execPath = await (deps.gitExecPath ?? gitExecPath)()
  return execPath ? bashFromGitExecPath(execPath, exists) : undefined
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

/** Carries the command to GATE_SCRIPT, so it never appears on cmd's command line. */
export const COMMAND_VAR = "AMIRA_COMMAND"

/**
 * Runs $AMIRA_COMMAND once the gate is open: cmd.exe held it (AMIRA_GATE is set, stdin is at its
 * end) or a line arrives on stdin (see RunOptions.viaCmd). The trailing `exit $?` keeps bash from
 * exec-ing the inner shell: a Windows process killed by an MSYS signal exits 0, while the outer
 * shell reports it as 128+n.
 */
export const GATE_SCRIPT = `read -r _ || [ -n "$AMIRA_GATE" ] || exit 125; c=$${COMMAND_VAR}; unset AMIRA_GATE ${COMMAND_VAR}; "$BASH" -c "$c" bash; exit $?`

export function windowsBashShell(found: string, exists: (p: string) => boolean = existsSync): Shell {
  const { bash, root } = gitBashLayout(found, exists)
  return {
    kind: "bash",
    path: bash,
    // Built per command, so variables set after the shell was resolved still reach commands.
    command: (command) => ({
      argv: [bash, "-c", GATE_SCRIPT, "bash"],
      env: { ...(root ? gitBashEnv(root) : process.env), [COMMAND_VAR]: command },
      gated: true,
      // Bun stalls for seconds on some direct spawns of MSYS programs.
      viaCmd: true,
    }),
  }
}

function posixBashShell(path: string): Shell {
  return {
    kind: "bash",
    path,
    command: (command) => ({ argv: [path, "-c", command], env: { ...process.env }, gated: false }),
  }
}

/** The bash tool's shell when Git Bash is missing: gated PowerShell, labelled so the model knows. */
export function fallbackPowerShell(path = findPowerShell()): Shell {
  return gatedPowerShell(path, `${powershellEdition(path)} (Git Bash not found)`)
}

let cached: Promise<Shell> | undefined

/** Git Bash on Windows (PowerShell if it is missing), /bin/bash elsewhere. Resolved once per process. */
export function resolveShell(): Promise<Shell> {
  cached ??=
    process.platform === "win32"
      ? findGitBash().then((bash) => (bash ? windowsBashShell(bash) : fallbackPowerShell()))
      : Promise.resolve(posixBashShell("/bin/bash"))
  return cached
}

/**
 * Finds the shells and runs an empty command in each, in the background. On machines where
 * antivirus scans each new program, the first start of bash or PowerShell takes seconds;
 * paying that at startup keeps the model's first command fast.
 */
export function warmUpShell(): void {
  const warm = (shell: Shell, command: string) => {
    const { argv, ...spawn } = shell.command(command)
    return runCommand(argv, {
      ...spawn,
      cwd: process.cwd(),
      timeoutMs: 60_000,
      signal: new AbortController().signal,
    }).catch(() => {})
  }
  resolveShell()
    .then((shell) =>
      process.platform === "win32" ? warm(shell, shell.kind === "bash" ? ":" : "$null") : undefined,
    )
    .catch(() => {})
  if (process.platform === "win32") {
    resolvePowerShell()
      .then((shell) => warm(shell, "$null"))
      .catch(() => {})
  }
}
