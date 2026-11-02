import { DaemonUnavailableError } from "./fallback.ts"

/** Explicit owner stop, deliberately separate from turn.abort and relay detach. */
const recovery =
  "The running daemon is incompatible. Explicitly stop it, then retry attaching. Active work will not be restarted automatically."

/** Classified refusal only; paths, versions and exception text never enter the recovery message. */
export class DaemonIncompatibilityError extends Error {
  readonly code = "incompatible_protocol"

  constructor() {
    super(recovery)
    this.name = "DaemonIncompatibilityError"
  }
}

export function daemonAttachFault(error: unknown): { code: string; message: string } {
  if (error instanceof DaemonIncompatibilityError) return { code: "incompatible_protocol", message: recovery }
  // An expected refusal (elevated session, job, network workspace) names its reason, never a path.
  if (error instanceof DaemonUnavailableError) return { code: "startup_failed", message: error.message }
  return { code: "startup_failed", message: "The remote workspace could not attach" }
}
