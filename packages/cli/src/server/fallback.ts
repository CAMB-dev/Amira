/** Why a frontend keeps running in-process instead of using a background daemon. */
export type DaemonFallbackReason = "integrity" | "job" | "network" | "ancestor" | "start"

const messages: Record<DaemonFallbackReason, string> = {
  integrity: "Elevated or low-integrity Windows sessions run in-process, without a background daemon",
  job: "A daemon would not outlive this terminal: it runs in a job that ends its processes (such as an agent's background job)",
  network: "Network workspaces and profiles on network drives run in-process, without a background daemon",
  ancestor: "The private daemon folder can be changed by another account, so the workspace runs in-process",
  start: "Could not start a private daemon",
}

/** A refusal that is expected and safe to show: the message never names paths or accounts. */
export class DaemonUnavailableError extends Error {
  constructor(readonly reason: DaemonFallbackReason) {
    super(messages[reason])
    this.name = "DaemonUnavailableError"
  }
}

/** The in-process fallback a refusal maps to; undefined for failures that are real errors. */
export function daemonFallback(
  error: unknown,
): { reason: DaemonFallbackReason; message: string } | undefined {
  return error instanceof DaemonUnavailableError
    ? { reason: error.reason, message: error.message }
    : undefined
}
