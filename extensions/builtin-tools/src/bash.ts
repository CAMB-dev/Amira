import { type BashDetails, defineTool, textResult } from "@amira/api"
import { type RunResult, runCommand } from "@amira/proc"
import { statOrNull } from "./files.ts"
import { startBackground } from "./jobs.ts"
import {
  findPowerShell,
  gatedPowerShell,
  powershellEdition,
  powershellStandby,
  resolvePowerShell,
} from "./powershell.ts"
import { resolveShell, type Shell } from "./shell.ts"
import { NOT_CONTAINED_WARNING, OUTPUT_OPEN_NOTE } from "./shell-notes.ts"
import { StandbyPool } from "./standby.ts"
import { keepOutput } from "./truncate.ts"

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000
const UPDATE_INTERVAL_MS = 250
const UPDATE_TAIL_CHARS = 4000

export interface BashParams {
  command: string
  timeout?: number
  background?: boolean
}

/** Notes for every shell tool; `cd` and `chain` show how that shell sequences commands. */
function sharedNotes(cd: string, chain: string): string[] {
  return [
    `- Starts in the working directory. Each call is a fresh shell: \`cd\`, variables and functions do not persist between calls. Prefer absolute paths or \`${cd}\`.`,
    `- \`timeout\` is in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). On timeout the command and everything it started are killed.`,
    "- Processes the command leaves running are killed when it finishes. For commands that keep running (dev servers, watchers, long builds you want to check on later), pass `background: true`: the call returns at once with a job id and the output so far, and the job keeps running. Read its new output with job_output (use wait_for to wait for a line such as a ready message instead of polling) and stop it with job_stop. Do not append `&` or use nohup yourself. Background jobs are stopped when Amira exits, and a sub-agent's when it ends.",
    `- Several calls issued together run at the same time. Put commands that depend on each other in one call (${chain}) or in separate turns.`,
    "- stdin is closed, so interactive commands (editors, prompts, `git rebase -i`) will not work; pass flags that avoid prompts.",
    "- Very long output is saved whole as an artifact: you get its start and end, and output_read reads the rest.",
    "- Prefer the available file reading, editing and search tools over shell commands for those tasks.",
  ]
}

const PARAMETERS = {
  type: "object",
  properties: {
    command: { type: "string", description: "The command to run" },
    timeout: {
      type: "integer",
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
      description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}); not for background commands`,
    },
    background: {
      type: "boolean",
      description:
        "Run in the background and return at once with a job id (for dev servers, watchers and other commands that keep running); see job_output and job_stop",
    },
  },
  required: ["command"],
  additionalProperties: false,
}

/**
 * A tool that runs commands in the shell `resolve()` returns; bash and powershell share it.
 * With a pool, commands run on a process started ahead of time when one matches.
 */
function shellTool(name: string, description: string[], resolve: () => Promise<Shell>, pool?: StandbyPool) {
  return defineTool<BashParams>({
    name,
    description: description.join("\n"),
    parameters: PARAMETERS,
    // Commands issued together run at the same time (D71); the model orders dependent ones.
    concurrency: "parallel",
    // The permission policy reads the command as the shell that runs it will: bash may fall
    // back to PowerShell on Windows.
    shellKind: async () => (await resolve()).kind,
    async execute({ command, timeout, background }, ctx) {
      if (typeof command !== "string" || command.trim() === "") return textResult("command is required", true)
      if (command.includes("\0")) return textResult("command must not contain NUL characters", true)
      if (ctx.signal.aborted) return textResult("Aborted before the command started", true)
      if (!(await statOrNull(ctx.cwd))?.isDirectory()) {
        return textResult(`Working directory does not exist: ${ctx.cwd}`, true)
      }
      const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(timeout ?? DEFAULT_TIMEOUT_MS)))
      const shell = await resolve()
      if (background === true) return startBackground(name, shell, command, ctx)

      const started = performance.now()
      let lastUpdate = 0
      let output = ""
      let run: RunResult
      try {
        const opts = {
          timeoutMs,
          signal: ctx.signal,
          onChunk(chunk: string) {
            output += chunk
            const now = Date.now()
            if (now - lastUpdate < UPDATE_INTERVAL_MS) return
            lastUpdate = now
            ctx.update(textResult(output.slice(-UPDATE_TAIL_CHARS)))
          },
        }
        const cmd = shell.command(command, ctx.cwd)
        if (pool) run = await pool.run(cmd, opts)
        else {
          const { argv, ...spawn } = cmd
          run = await runCommand(argv, { ...spawn, ...opts })
        }
      } catch (err) {
        return textResult(`Failed to start ${shell.path}: ${(err as Error).message}`, true)
      }

      const durationMs = Math.round(performance.now() - started)
      const printed = run.output.trimEnd()
      const out = await keepOutput(ctx, {
        text: printed,
        tool: name,
        ...(run.timedOut || run.aborted
          ? { facts: [run.timedOut ? "the command timed out" : "the command was aborted"] }
          : {}),
      })
      const parts = [out.text || "(no output)"]
      if (shell.label) parts.unshift(`Shell: ${shell.label}`)
      parts.push(statusLine(run, timeoutMs))
      if (!run.contained) {
        parts.push(NOT_CONTAINED_WARNING)
      } else if (!run.settled && !run.aborted) {
        // After an abort the job was terminated, so open pipes are not a sign of survivors.
        parts.push(OUTPUT_OPEN_NOTE)
      }
      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
        isError: run.timedOut || run.aborted || run.exitCode !== 0,
        details: {
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          aborted: run.aborted,
          settled: run.settled,
          shell: shell.path,
          shellKind: shell.kind,
          ...(out.artifact ? { fullOutputPath: out.artifact.path, artifact: out.artifact.id } : {}),
          durationMs,
          outputLines: printed === "" ? 0 : printed.split("\n").length,
        } satisfies BashDetails,
      }
    },
  })
}

export const bashTool = shellTool(
  "bash",
  [
    "Run a shell command and return its combined stdout and stderr plus the exit code.",
    "- Runs in bash (Git Bash on Windows, so use POSIX syntax and forward slashes). If Git Bash is not installed, Windows falls back to PowerShell: every result then starts with a `Shell:` line naming the PowerShell edition, and you must use PowerShell syntax.",
    "- Output is decoded as UTF-8. Windows programs that print in a legacy console code page may show garbled non-ASCII text.",
    ...sharedNotes("cd dir && cmd", "`a && b`"),
  ],
  resolveShell,
)

/** The powershell tool's description, for the edition at `path`. */
export function powershellDescription(path: string): string[] {
  const edition = powershellEdition(path)
  const legacy = edition.startsWith("Windows")
  return [
    `Run a command in ${edition} and return its output plus the exit code.`,
    "- Use it for Windows-specific work: the registry, services, processes, Windows paths and APIs, .ps1 scripts, or tools that only behave well from PowerShell. For general work (git, package managers, POSIX tools) prefer the bash tool when it is available.",
    `- Use PowerShell syntax: \`;\` or newlines between statements, \`$env:NAME\` for environment variables.${legacy ? " `&&` and `||` do not exist in this edition; test `$LASTEXITCODE` after native commands instead." : ""}`,
    "- All output streams (output, errors, warnings, Write-Host) are combined as plain text. Output is UTF-8.",
    `- The exit code is \`$LASTEXITCODE\` of the last native command, or 1 if the final statement failed; an earlier failing cmdlet only prints its error. Exit codes are reported mod 256 (\`exit 300\` shows 44, -1 shows 255). For fail-fast scripts start with \`$ErrorActionPreference = 'Stop'\`${legacy ? " (in this edition a native command writing to stderr then also stops the script)" : ""}.`,
    ...sharedNotes("cd dir; cmd", legacy ? "`a; if ($LASTEXITCODE -eq 0) { b }`" : "`a && b`"),
  ]
}

/** A powershell tool bound to one PowerShell executable. */
export function createPowershellTool(path = findPowerShell()) {
  const own = path === findPowerShell()
  const shell = own ? resolvePowerShell : () => Promise.resolve(gatedPowerShell(path))
  return shellTool(
    "powershell",
    powershellDescription(path),
    shell,
    own ? powershellStandby : new StandbyPool(),
  )
}

/** Windows only: PowerShell next to bash, for Windows-specific work. */
export const powershellTool = createPowershellTool()

function statusLine(run: RunResult, timeoutMs: number): string {
  if (run.timedOut) return `Command timed out after ${timeoutMs} ms and was killed.`
  if (run.aborted) return "Command was aborted."
  if (run.exitCode === null)
    return `Command was killed by signal${run.signalCode ? ` ${run.signalCode}` : ""}.`
  return `Exit code: ${run.exitCode}`
}
