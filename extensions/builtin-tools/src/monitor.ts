import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineTool, type ShellMode, type ToolPresenter, textResult } from "@amira/api"
import { jobsConfig } from "./jobs.ts"
import { MonitorEvents, type MonitorTiming } from "./monitor-events.ts"
import { resolvePowerShell } from "./powershell.ts"
import { resolveShell, type Shell } from "./shell.ts"
import { resolveExecutionShell, validateShellCommand } from "./shell-execution.ts"
import { NOT_CONTAINED_WARNING } from "./shell-notes.ts"

export const DEFAULT_MONITOR_TIMEOUT_MS = 30 * 60_000
export const MAX_MONITOR_TIMEOUT_MS = 2 * 60 * 60_000

export interface MonitorParams {
  command: string
  filter?: string
  timeout_ms?: number
  description?: string
}

/** The monitor tool's description for the shell its commands run in. */
export function monitorDescription(shell: "bash" | "powershell"): string {
  return [
    shell === "powershell"
      ? "Monitor a PowerShell command (same shell as the powershell tool; PowerShell syntax); return job id immediately. Normal shell permissions apply."
      : "Monitor a bash command (same shell as the bash tool: Git Bash on Windows; bash syntax, not PowerShell); return job id immediately. Normal shell permissions apply.",
    "Never wrap the command in another shell (pwsh/powershell -Command, bash -c, cmd /c).",
    "New/matching lines wake you. filter: case-insensitive line regex; invalid = literal. Narrow chatty output.",
    "Batch ~1s; max one notice/2s, ~4KB each; pause output notices after 200 events. Final notice on exit/timeout.",
    `Stop via job_stop; read via job_output. timeout_ms: default ${DEFAULT_MONITOR_TIMEOUT_MS / 60_000}m, max ${MAX_MONITOR_TIMEOUT_MS / 3_600_000}h. Child monitors end with owner; -p waits until exit/stop/timeout.`,
  ].join("\n")
}

/** Uses the same runtime shell classification and permission checks as bash. */
export function createMonitorTool(
  resolve?: () => Promise<Shell>,
  timing: MonitorTiming = {},
  mode: () => ShellMode | undefined = () => undefined,
) {
  const shell = resolve ?? (() => (mode() === "powershell" ? resolvePowerShell() : resolveShell()))
  return defineTool<MonitorParams>({
    name: "monitor",
    // Read on every request: the session's shell mode can change, and naming the shell keeps
    // the model from guessing PowerShell on Windows and nesting it inside bash.
    get description() {
      return monitorDescription(mode() === "powershell" ? "powershell" : "bash")
    },
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        filter: { type: "string" },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          maximum: MAX_MONITOR_TIMEOUT_MS,
        },
        description: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    get traits() {
      return { shell: mode() === "powershell" ? ("powershell" as const) : ("bash" as const) }
    },
    shellKind: async () => (await shell()).kind,
    concurrency: "parallel",
    async execute({ command, filter, timeout_ms, description }, ctx) {
      const invalid = await validateShellCommand(command, ctx)
      if (invalid) return invalid
      const registry = ctx.backgroundJobs
      if (!registry) return textResult("Background jobs are unavailable in this host.", true)
      const expectNotice = ctx.expectNotice ?? ctx.session?.expectNotice?.bind(ctx.session)
      if (ctx.session && !expectNotice) {
        return textResult(
          "This session cannot receive monitor notices. Use a background shell job with job_output (wait_for), or run the monitor in a persistent agent.",
          true,
        )
      }
      const timeoutMs = Math.min(
        MAX_MONITOR_TIMEOUT_MS,
        Math.max(1, Math.floor(timeout_ms ?? DEFAULT_MONITOR_TIMEOUT_MS)),
      )
      let resolved: Shell
      try {
        resolved = await resolveExecutionShell(
          resolve ??
            (() =>
              ctx.shellKind === "powershell"
                ? resolvePowerShell()
                : ctx.shellKind === "bash"
                  ? resolveShell()
                  : shell()),
          ctx,
        )
      } catch (error) {
        return textResult((error as Error).message, true)
      }
      const pending = expectNotice?.()
      const events = expectNotice
        ? new MonitorEvents(registry, expectNotice, pending, filter, timing)
        : undefined
      try {
        const job = registry.start({
          ...resolved.command(command, ctx.cwd),
          command,
          kind: "monitor",
          ...(events ? { onChange: events.observe } : {}),
          shell: resolved.kind,
          logDir: join(ctx.session?.dir ?? join(tmpdir(), "amira"), "jobs"),
          ...(jobsConfig.maxLogBytes !== undefined ? { maxLogBytes: jobsConfig.maxLogBytes } : {}),
          meta: { tool: "monitor", shell: resolved.path, ...(description ? { description } : {}) },
        })
        if (events) {
          void events.run(job, timeoutMs).catch(() => {})
        } else {
          // Hosts without a model session still enforce the process lifetime.
          void registry
            .waitFor(job.id, { timeoutMs })
            .then((result) => {
              if (result.reason === "timeout") return registry.stop(job.id, 0)
            })
            .catch(() => {})
        }
        return {
          ...textResult(
            `${resolved.label ? `Shell: ${resolved.label}\n` : ""}Started monitor ${job.id}${description ? `: ${description}` : ""}. Events arrive automatically; stop with job_stop (job_id "${job.id}"). Timeout: ${timeoutMs} ms.${job.contained ? "" : `\n${NOT_CONTAINED_WARNING}`}`,
          ),
          details: { jobId: job.id, command, status: job.status, exitCode: job.exitCode, outputLines: 0 },
        }
      } catch (error) {
        pending?.cancel()
        return textResult(`Failed to start monitor: ${(error as Error).message}`, true)
      }
    },
  })
}

export const monitorTool = createMonitorTool()

export const monitorPresenter: ToolPresenter<MonitorParams> = {
  verbs: { past: "Monitored", running: "Starting monitor" },
  summary: (args) => args.description ?? args.command,
  result: (call) => {
    const details = call.result.details as { jobId?: string } | undefined
    return details?.jobId
  },
  body: () => [],
}
