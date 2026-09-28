import { defineTool, textResult } from "@amira/api"
import { type RunResult, runCommand } from "@amira/proc"
import { statOrNull } from "./files.ts"
import { resolvePowerShell, resolveShell, type Shell } from "./shell.ts"
import { truncateOutput } from "./truncate.ts"

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000
const UPDATE_INTERVAL_MS = 250
const UPDATE_TAIL_CHARS = 4000

export interface BashParams {
  command: string
  timeout?: number
}

const SHARED_NOTES = [
  "- Starts in the working directory. Each call is a fresh shell: `cd`, variables and functions do not persist between calls. Prefer absolute paths or `cd dir && cmd`.",
  `- \`timeout\` is in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). On timeout the command and everything it started are killed.`,
  "- Background processes are killed when the command finishes; do not use this tool to start long-running servers.",
  "- Several calls issued together run at the same time. Put commands that depend on each other in one call (`a && b`) or in separate turns.",
  "- stdin is closed, so interactive commands (editors, prompts, `git rebase -i`) will not work; pass flags that avoid prompts.",
  "- Very long output is cut in the middle; the full output is saved to a file you can read.",
  "- Prefer the read, write, edit, grep and glob tools over shell commands for reading, editing and searching files.",
]

const PARAMETERS = {
  type: "object",
  properties: {
    command: { type: "string", description: "The command to run" },
    timeout: {
      type: "integer",
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
      description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
    },
  },
  required: ["command"],
  additionalProperties: false,
}

/** A tool that runs commands in the shell `resolve()` returns; bash and powershell share it. */
function shellTool(name: string, description: string[], resolve: () => Promise<Shell>) {
  return defineTool<BashParams>({
    name,
    description: [...description, ...SHARED_NOTES].join("\n"),
    parameters: PARAMETERS,
    // Commands issued together run at the same time (D71); the model orders dependent ones.
    concurrency: "parallel",
    async execute({ command, timeout }, ctx) {
      if (typeof command !== "string" || command.trim() === "") return textResult("command is required", true)
      if (ctx.signal.aborted) return textResult("Aborted before the command started", true)
      if (!(await statOrNull(ctx.cwd))?.isDirectory()) {
        return textResult(`Working directory does not exist: ${ctx.cwd}`, true)
      }
      const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(timeout ?? DEFAULT_TIMEOUT_MS)))
      const shell = await resolve()

      let lastUpdate = 0
      let output = ""
      let run: RunResult
      try {
        run = await runCommand(shell.args(command), {
          cwd: ctx.cwd,
          env: shell.env,
          gated: shell.gated,
          timeoutMs,
          signal: ctx.signal,
          onChunk(chunk) {
            output += chunk
            const now = Date.now()
            if (now - lastUpdate < UPDATE_INTERVAL_MS) return
            lastUpdate = now
            ctx.update(textResult(output.slice(-UPDATE_TAIL_CHARS)))
          },
        })
      } catch (err) {
        return textResult(`Failed to start ${shell.path}: ${(err as Error).message}`, true)
      }

      const out = await truncateOutput(run.output.trimEnd(), name)
      const parts = [out.text || "(no output)"]
      if (shell.label) parts.unshift(`Shell: ${shell.label}`)
      parts.push(statusLine(run, timeoutMs))
      if (!run.contained) {
        parts.push(
          "Warning: the command could not be placed in a job object, so processes it started may still be running.",
        )
      } else if (!run.settled && !run.aborted) {
        // After an abort the job was terminated, so open pipes are not a sign of survivors.
        parts.push(
          "Note: output was still open after the command ended; some processes may still be running.",
        )
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
          fullOutputPath: out.fullOutputPath,
        },
      }
    },
  })
}

export const bashTool = shellTool(
  "bash",
  [
    "Run a shell command and return its combined stdout and stderr plus the exit code.",
    "- Runs in bash (Git Bash on Windows, so use POSIX syntax and forward slashes). If Git Bash is not installed, Windows falls back to PowerShell: every result then starts with a `Shell: PowerShell` line and you must use PowerShell syntax.",
    "- Output is decoded as UTF-8. Windows programs that print in a legacy console code page may show garbled non-ASCII text.",
  ],
  resolveShell,
)

/** Windows only: PowerShell next to bash, for Windows-specific work. */
export const powershellTool = shellTool(
  "powershell",
  [
    "Run a PowerShell command (pwsh if installed, otherwise Windows PowerShell 5.1) and return its output plus the exit code.",
    "- Use it for Windows-specific work: the registry, services, processes, Windows paths and APIs, .ps1 scripts, or tools that only behave well from PowerShell. For general work (git, package managers, POSIX tools) prefer the bash tool when it is available.",
    "- Use PowerShell syntax (`;` or newlines between statements, `$env:NAME` for variables). Output is UTF-8; the exit code of the last native command is returned.",
  ],
  resolvePowerShell,
)

function statusLine(run: RunResult, timeoutMs: number): string {
  if (run.timedOut) return `Command timed out after ${timeoutMs} ms and was killed.`
  if (run.aborted) return "Command was aborted."
  if (run.exitCode === null)
    return `Command was killed by signal${run.signalCode ? ` ${run.signalCode}` : ""}.`
  return `Exit code: ${run.exitCode}`
}
