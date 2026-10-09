import { type BashDetails, defineTool, type HostRunResult, hostRunCommand, textResult } from "@amira/api"
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
import {
  NOT_CONTAINED_WARNING,
  OUTPUT_OPEN_NOTE,
  TIMEOUT_BACKGROUND_NOTE,
  TIMEOUT_RETRY_NOTE,
} from "./shell-notes.ts"
import { StandbyPool } from "./standby.ts"
import { keepOutput } from "./truncate.ts"

export const DEFAULT_TIMEOUT_MS = 600_000
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
    `Fresh shell in working directory; cd, variables/functions do not persist. To change directory: ${cd}. Concurrent calls run in parallel; chain dependencies (${chain}) or use separate turns.`,
    `timeout: ms, default/max ${MAX_TIMEOUT_MS}; kills command and descendants. Leftover processes are killed on completion too. For longer/persistent commands use background:true (ignores timeout): returns job id/output immediately. Read via job_output with wait_for, not polling; stop via job_stop. Never use &/nohup. Root jobs survive /clear, /resume, /fork until Amira exits; child jobs end with their sub-agent.`,
    "stdin closed: use non-interactive flags. Long output: artifact with start/end preview; output_read reads the rest. Prefer file/search tools for reading, editing and searching.",
  ]
}

const PARAMETERS = {
  type: "object",
  properties: {
    command: { type: "string" },
    timeout: {
      type: "integer",
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
      description: `Milliseconds; default ${DEFAULT_TIMEOUT_MS}, ignored in background.`,
    },
    background: {
      type: "boolean",
      description: "Persistent job; returns immediately.",
    },
  },
  required: ["command"],
  additionalProperties: false,
}

/**
 * A tool that runs commands in the shell `resolve()` returns; bash and powershell share it.
 * With a pool, commands run on a process started ahead of time when one matches.
 */
function shellTool(
  name: string,
  shellKind: "bash" | "powershell",
  description: string[],
  resolve: () => Promise<Shell>,
  pool?: StandbyPool,
) {
  return defineTool<BashParams>({
    name,
    description: description.join("\n"),
    parameters: PARAMETERS,
    traits: { shell: shellKind },
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
      let run: HostRunResult
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
          run = await hostRunCommand(argv, { ...spawn, ...opts })
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
      if (run.timedOut) {
        parts.push(timeoutMs < MAX_TIMEOUT_MS ? TIMEOUT_RETRY_NOTE : TIMEOUT_BACKGROUND_NOTE)
      }
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
  "bash",
  [
    "Run bash; returns combined stdout/stderr and exit code. Windows: Git Bash, POSIX syntax/forward slashes; without Git Bash, PowerShell fallback labels results with Shell: edition; use PowerShell syntax then.",
    "pipefail: any pipeline failure fails the call, except a successful last command with earlier statuses only 0/SIGPIPE(141). That exception still fails inside the shell, so subsequent && won't run; use command output-limit options when chaining. Other nonzero statuses fail.",
    "UTF-8 output; legacy Windows code pages may garble non-ASCII.",
    ...sharedNotes("cd dir && cmd", "`a && b`"),
  ],
  resolveShell,
)

/** The powershell tool's description, for the edition at `path`. */
export function powershellDescription(path: string): string[] {
  const edition = powershellEdition(path)
  const legacy = edition.startsWith("Windows")
  return [
    `Run ${edition}; returns all streams (errors/warnings/Write-Host included) as UTF-8 text and exit code.`,
    "Use for Windows-specific work (registry/services/processes, Windows paths/APIs, .ps1); prefer bash for general git/package/POSIX work when available.",
    `PowerShell syntax: ; or newlines, $env:NAME.${legacy ? " No &&/||; test $LASTEXITCODE after native commands." : ""}`,
    `Exit: last native $LASTEXITCODE, or 1 if final statement failed; earlier cmdlet failure only prints error. Codes mod 256. Fail-fast: $ErrorActionPreference = 'Stop'.${legacy ? " Native stderr also stops scripts in this edition." : ""}`,
    ...sharedNotes("cd dir; cmd", legacy ? "`a; if ($LASTEXITCODE -eq 0) { b }`" : "`a && b`"),
  ]
}

/** A powershell tool bound to one PowerShell executable. */
export function createPowershellTool(path = findPowerShell()) {
  const own = path === findPowerShell()
  const shell = own ? resolvePowerShell : () => Promise.resolve(gatedPowerShell(path))
  return shellTool(
    "powershell",
    "powershell",
    powershellDescription(path),
    shell,
    own ? powershellStandby : new StandbyPool(),
  )
}

/** Windows only: PowerShell next to bash, for Windows-specific work. */
export const powershellTool = createPowershellTool()

function statusLine(run: HostRunResult, timeoutMs: number): string {
  if (run.timedOut) return `Command timed out after ${timeoutMs} ms and was killed.`
  if (run.aborted) return "Command was aborted."
  if (run.exitCode === null)
    return `Command was killed by signal${run.signalCode ? ` ${run.signalCode}` : ""}.`
  return `Exit code: ${run.exitCode}`
}
