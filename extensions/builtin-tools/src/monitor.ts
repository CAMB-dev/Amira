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

/** Uses the same runtime shell classification and permission checks as bash. */
export function createMonitorTool(
  resolve?: () => Promise<Shell>,
  timing: MonitorTiming = {},
  mode: () => ShellMode | undefined = () => undefined,
) {
  const shell = resolve ?? (() => (mode() === "powershell" ? resolvePowerShell() : resolveShell()))
  return defineTool<MonitorParams>({
    name: "monitor",
    description: [
      "Run a command in the session shell as a background monitor and return its job id immediately. Normal shell permissions apply.",
      "Each new line (or case-insensitive filter match; invalid regex is literal) wakes you with an automatic notice. Lines batch for ~1s, at most once per 2s, capped at ~4KB; notifications pause after 200 events. Use a narrow filter for chatty commands.",
      "Exit/timeout sends a final notice. Stop with job_stop; job_output reads the full buffered output. Owned by this session/sub-agent and stopped when it ends. In print mode (-p), the run stays alive until monitors exit, stop, or time out.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        filter: { type: "string", description: "Case-insensitive line regex; invalid regex is literal" },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          maximum: MAX_MONITOR_TIMEOUT_MS,
          description: `Milliseconds; default ${DEFAULT_MONITOR_TIMEOUT_MS}, max ${MAX_MONITOR_TIMEOUT_MS}`,
        },
        description: { type: "string", description: "Short label for the monitor" },
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
