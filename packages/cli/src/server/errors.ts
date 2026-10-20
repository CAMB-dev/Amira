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
  return error instanceof DaemonIncompatibilityError
    ? { code: "incompatible_protocol", message: recovery }
    : { code: "startup_failed", message: "The remote workspace could not attach" }
}
