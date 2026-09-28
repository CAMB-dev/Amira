import { defineTool, textResult } from "@amira/api"
import type { Subprocess } from "bun"
import { type ProcessTree, trackProcessTree } from "./process-tree.ts"
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
        env: shell.env,
        gated: shell.gated,
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
    parts.push(statusLine(run, timeoutMs))
    if (!run.contained) {
      parts.push(
        "Warning: the command could not be placed in a job object, so processes it started may still be running.",
      )
    } else if (!run.settled) {
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
        fullOutputPath: out.fullOutputPath,
      },
    }
  },
})

function statusLine(run: RunResult, timeoutMs: number): string {
  if (run.timedOut) return `Command timed out after ${timeoutMs} ms and was killed.`
  if (run.aborted) return "Command was aborted."
  return `Exit code: ${run.exitCode}`
}

export interface RunOptions {
  cwd: string
  env?: Record<string, string | undefined>
  /** The command waits for a line on stdin, which is sent once the process tree is contained. */
  gated?: boolean
  timeoutMs: number
  signal: AbortSignal
  onOutput?: (output: string) => void
  /** Test seam: how the process tree is tracked and killed. */
  trackTree?: (proc: Subprocess) => ProcessTree
}

export interface RunResult {
  output: string
  exitCode: number | null
  /** Set only when the timeout fired before the process exited. */
  timedOut: boolean
  aborted: boolean
  /** False when the pipes were still open after the drain grace, i.e. something kept running. */
  settled: boolean
  /** False when the process tree could not be contained, so kills may have missed processes. */
  contained: boolean
}

/** Runs argv with stdout and stderr interleaved, killing the whole process tree on abort, timeout and exit. */
export async function runCommand(argv: string[], opts: RunOptions): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdin: opts.gated ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    // POSIX: new session, so the whole process group can be killed.
    detached: process.platform !== "win32",
  })
  const tree = (opts.trackTree ?? trackProcessTree)(proc)
  if (opts.gated) releaseGate(proc.stdin)

  let output = ""
  let finished = false
  const readers: { cancel(): Promise<void> }[] = []
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    readers.push(reader)
    const decoder = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done || finished) break
      output += decoder.decode(value, { stream: true })
      opts.onOutput?.(output)
    }
    if (!finished) output += decoder.decode()
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

  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let endGrace = () => {}
  try {
    const exitCode = await proc.exited
    clearTimeout(timer)
    opts.signal.removeEventListener("abort", onAbort)
    // Only a timeout or abort that fired before the exit explains how the command ended.
    const cause = reason
    // Kill background leftovers too; they would otherwise keep the pipes open and outlive the call.
    tree.kill()
    // An abort cuts the grace short.
    const grace = new Promise<boolean>((resolve) => {
      const give = () => resolve(false)
      graceTimer = setTimeout(give, DRAIN_GRACE_MS)
      opts.signal.addEventListener("abort", give, { once: true })
      endGrace = () => opts.signal.removeEventListener("abort", give)
      if (opts.signal.aborted) give()
    })
    const settled = await Promise.race([drained.then(() => true), grace])
    return {
      output,
      exitCode,
      timedOut: cause === "timeout",
      aborted: cause === "abort",
      settled,
      contained: tree.contained,
    }
  } finally {
    // Nothing reaches `output` or onOutput after this point, even if a pipe holder survived.
    finished = true
    clearTimeout(timer)
    clearTimeout(graceTimer)
    endGrace()
    opts.signal.removeEventListener("abort", onAbort)
    for (const r of readers) r.cancel().catch(() => {})
    tree.dispose()
  }
}

function releaseGate(stdin: Bun.FileSink | undefined): void {
  if (!stdin) return
  try {
    stdin.write("\n")
    Promise.resolve(stdin.end()).catch(() => {})
  } catch {}
}
