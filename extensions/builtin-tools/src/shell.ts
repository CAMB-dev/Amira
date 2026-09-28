import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, win32 } from "node:path"
import { runCommand } from "@amira/proc"

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

export function powershellShell(
  path = Bun.which("pwsh") ?? Bun.which("powershell") ?? "powershell.exe",
): Shell {
  return {
    kind: "powershell",
    path,
    label: "PowerShell (Git Bash not found)",
    command: (command) => ({
      argv: [path, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      env: { ...process.env },
      gated: false,
    }),
  }
}

let cached: Promise<Shell> | undefined

/** Git Bash on Windows (PowerShell if it is missing), /bin/bash elsewhere. Resolved once per process. */
/**
 * The script run for the powershell tool. It waits for the gate line (sent once the process
 * is in its Job Object), switches output to UTF-8, runs the command, and exits with the last
 * native exit code, or 1 when the last statement failed.
 */
export function powershellScript(command: string): string {
  return [
    "$null = [Console]::In.ReadLine()",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$global:LASTEXITCODE = 0",
    command,
    "if (-not $?) { if ($global:LASTEXITCODE) { exit $global:LASTEXITCODE } else { exit 1 } }",
    "exit $global:LASTEXITCODE",
  ].join("\n")
}

/** -EncodedCommand takes base64 of UTF-16LE, which sidesteps every argument-quoting quirk. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64")
}

/** PowerShell for the powershell tool: gated like Git Bash, so nothing escapes the job. */
export function gatedPowerShell(
  path = Bun.which("pwsh") ?? Bun.which("powershell") ?? "powershell.exe",
): Shell {
  return {
    kind: "powershell",
    path,
    command: (command) => ({
      argv: [
        path,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodePowerShell(powershellScript(command)),
      ],
      env: { ...process.env },
      gated: true,
    }),
  }
}

let cachedPowerShell: Promise<Shell> | undefined
export function resolvePowerShell(): Promise<Shell> {
  cachedPowerShell ??= Promise.resolve(gatedPowerShell())
  return cachedPowerShell
}

export function resolveShell(): Promise<Shell> {
  cached ??=
    process.platform === "win32"
      ? findGitBash().then((bash) => (bash ? windowsBashShell(bash) : powershellShell()))
      : Promise.resolve(posixBashShell("/bin/bash"))
  return cached
}

/** Starts shell discovery in the background so the first bash call does not wait for it. */
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
