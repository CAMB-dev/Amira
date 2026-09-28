import { defineTool, textResult } from "@amira/api"
import { type RunResult, runCommand } from "@amira/proc"
import { statOrNull } from "./files.ts"
import { resolveShell } from "./shell.ts"
import { truncateOutput } from "./truncate.ts"

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000
const UPDATE_INTERVAL_MS = 250
const UPDATE_TAIL_CHARS = 4000

export interface BashParams {
  command: string
  timeout?: number
}

export const bashTool = defineTool<BashParams>({
  name: "bash",
  description: [
    "Run a shell command and return its combined stdout and stderr plus the exit code.",
    "- Runs in bash (Git Bash on Windows, so use POSIX syntax and forward slashes). If Git Bash is not installed, Windows falls back to PowerShell: every result then starts with a `Shell: PowerShell` line and you must use PowerShell syntax.",
    "- Starts in the working directory. Each call is a fresh shell: `cd`, variables and functions do not persist between calls. Prefer absolute paths or `cd dir && cmd`.",
    `- \`timeout\` is in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). On timeout the command and everything it started are killed.`,
    "- Background processes (`cmd &`) are killed when the command finishes; do not use this tool to start long-running servers.",
    "- stdin is closed, so interactive commands (editors, prompts, `git rebase -i`) will not work; pass flags that avoid prompts.",
    "- Output is decoded as UTF-8. Windows programs that print in a legacy console code page may show garbled non-ASCII text.",
    "- Very long output is cut in the middle; the full output is saved to a file you can read.",
    "- Prefer the read, write, edit, grep and glob tools over cat, sed, echo >, grep and find.",
  ].join("\n"),
  parameters: {
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
  },
  concurrency: "serial",
  async execute({ command, timeout }, ctx) {
    if (typeof command !== "string" || command.trim() === "") return textResult("command is required", true)
    if (ctx.signal.aborted) return textResult("Aborted before the command started", true)
    if (!(await statOrNull(ctx.cwd))?.isDirectory()) {
      return textResult(`Working directory does not exist: ${ctx.cwd}`, true)
    }
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(timeout ?? DEFAULT_TIMEOUT_MS)))
    const shell = await resolveShell()

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

    const out = await truncateOutput(run.output.trimEnd(), "bash")
    const parts = [out.text || "(no output)"]
    if (shell.label) parts.unshift(`Shell: ${shell.label}`)
    parts.push(statusLine(run, timeoutMs))
    if (!run.contained) {
      parts.push(
        "Warning: the command could not be placed in a job object, so processes it started may still be running.",
      )
    } else if (!run.settled && !run.aborted) {
      // After an abort the job was terminated, so open pipes are not a sign of survivors.
      parts.push("Note: output was still open after the command ended; some processes may still be running.")
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

function statusLine(run: RunResult, timeoutMs: number): string {
  if (run.timedOut) return `Command timed out after ${timeoutMs} ms and was killed.`
  if (run.aborted) return "Command was aborted."
  if (run.exitCode === null)
    return `Command was killed by signal${run.signalCode ? ` ${run.signalCode}` : ""}.`
  return `Exit code: ${run.exitCode}`
}
