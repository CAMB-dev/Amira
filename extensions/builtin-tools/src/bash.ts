import { defineTool, textResult } from "@amira/api"
import { trackProcessTree } from "./process-tree.ts"
import { resolveShell } from "./shell.ts"
import { truncateOutput } from "./truncate.ts"

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000
const UPDATE_INTERVAL_MS = 250
const UPDATE_TAIL_CHARS = 4000
/** How long to wait for pipes to drain after the process tree is gone. */
const DRAIN_GRACE_MS = 2000

export interface BashParams {
  command: string
  timeout?: number
}

export const bashTool = defineTool<BashParams>({
  name: "bash",
  description: [
    "Run a shell command and return its combined stdout and stderr plus the exit code.",
    "- Runs in bash (Git Bash on Windows, so use POSIX syntax and forward slashes; PowerShell only if Git Bash is not installed).",
    "- Starts in the working directory. Each call is a fresh shell: `cd`, variables and functions do not persist between calls. Prefer absolute paths or `cd dir && cmd`.",
    `- \`timeout\` is in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). On timeout the command and everything it started are killed.`,
    "- Background processes (`cmd &`) are killed when the command finishes; do not use this tool to start long-running servers.",
    "- stdin is closed, so interactive commands (editors, prompts, `git rebase -i`) will not work; pass flags that avoid prompts.",
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
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(timeout ?? DEFAULT_TIMEOUT_MS)))
    const shell = await resolveShell()

    let lastUpdate = 0
    let run: RunResult
    try {
      run = await runCommand(shell.args(command), {
        cwd: ctx.cwd,
        timeoutMs,
        signal: ctx.signal,
        onOutput(output) {
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
    if (run.timedOut) parts.push(`Command timed out after ${timeoutMs} ms and was killed.`)
    else if (run.aborted) parts.push("Command was aborted.")
    else parts.push(`Exit code: ${run.exitCode}`)
    return {
      content: [{ type: "text", text: parts.join("\n\n") }],
      isError: run.timedOut || run.aborted || run.exitCode !== 0,
      details: {
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        aborted: run.aborted,
        shell: shell.path,
        fullOutputPath: out.fullOutputPath,
      },
    }
  },
})

export interface RunOptions {
  cwd: string
  timeoutMs: number
  signal: AbortSignal
  onOutput?: (output: string) => void
}

export interface RunResult {
  output: string
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
}

/** Runs argv with stdout and stderr interleaved, killing the whole process tree on abort, timeout and exit. */
export async function runCommand(argv: string[], opts: RunOptions): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    // POSIX: new session, so the whole process group can be killed.
    detached: process.platform !== "win32",
  })
  const tree = trackProcessTree(proc)

  let output = ""
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true })
      opts.onOutput?.(output)
    }
    output += decoder.decode()
  }
  const drained = Promise.all([pump(proc.stdout), pump(proc.stderr)]).catch(() => {})

  let reason: "timeout" | "abort" | undefined
  const stop = (why: "timeout" | "abort") => {
    reason ??= why
    tree.kill()
  }
  const timer = setTimeout(() => stop("timeout"), opts.timeoutMs)
  const onAbort = () => stop("abort")
  opts.signal.addEventListener("abort", onAbort, { once: true })
  if (opts.signal.aborted) onAbort()

  try {
    const exitCode = await proc.exited
    // Kill background leftovers too; they would otherwise keep the pipes open and outlive the call.
    tree.kill()
    await Promise.race([drained, Bun.sleep(DRAIN_GRACE_MS)])
    return { output, exitCode, timedOut: reason === "timeout", aborted: reason === "abort" }
  } finally {
    clearTimeout(timer)
    opts.signal.removeEventListener("abort", onAbort)
    tree.dispose()
  }
}
