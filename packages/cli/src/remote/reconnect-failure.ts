import type { FrontendConnectionIssue } from "@amira/core"
import { RemoteError, RemoteReplyError } from "./errors.ts"

export type RemoteSetupFailureCode =
  | "consent_required"
  | "provenance_rejected"
  | "platform_rejected"
  | "installation_failed"
  | "incompatible_daemon"
  | "transport"
  | "setup_failed"

export type ReconnectFailure = FrontendConnectionIssue

/** Local deployment facts, never a remote model error or a reason to bypass consent/provenance. */
export class RemoteSetupError extends Error implements ReconnectFailure {
  readonly retryable: boolean
  constructor(
    readonly code: RemoteSetupFailureCode,
    message: string,
    readonly recovery: string,
  ) {
    super(message)
    this.name = "RemoteSetupError"
    this.retryable = code === "transport"
  }
}

/** Preserve actual SSH process failure facts consistently for setup commands and final relays. */
export function sshExitError(
  code: number,
  stderr: string,
  phase: "setup" | "relay",
): RemoteSetupError | undefined {
  if (code === 0) return undefined
  const diagnostic = setupDiagnostic(new Error(stderr.slice(-768)), "") || "no diagnostics"
  const transient =
    code === 255 &&
    !/permission denied|authentication failed|host key verification failed|host identification has changed/i.test(
      stderr,
    )
  return new RemoteSetupError(
    transient ? "transport" : "setup_failed",
    phase === "relay"
      ? `Remote SSH relay exited with status ${code}: ${diagnostic}`
      : `Remote setup failed (${code}): ${diagnostic}`,
    transient
      ? "Retrying automatically. Check the SSH connection to the remote host."
      : phase === "relay"
        ? "Automatic reconnect stopped. Fix the remote attach command/account policy, then use /reconnect or run amira remote add again."
        : "Automatic reconnect stopped. Fix SSH or remote server setup, then use /reconnect or run amira remote add again.",
  )
}

/** Error text may contain paths or terminal escapes. Emit only a bounded, single-line diagnostic. */
export function setupDiagnostic(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : fallback
  return Array.from(text)
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code >= 32 && !(code >= 127 && code <= 159)
    })
    .join("")
    .slice(0, 1024)
}

export function classifyReconnectFailure(error: unknown): ReconnectFailure {
  if (error instanceof RemoteSetupError)
    return {
      code: error.code,
      message: setupDiagnostic(error, "Remote setup failed."),
      recovery: error.recovery,
      retryable: error.retryable,
    }
  if (
    (error instanceof RemoteError && error.code === "disconnected") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "EPIPE",
        "ETIMEDOUT",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "EAI_AGAIN",
        "ENOTFOUND",
      ].includes(String(error.code)))
  )
    return {
      code: "transport",
      message: "The SSH connection is unavailable.",
      recovery: "Retrying automatically. Check the connection to the remote host.",
      retryable: true,
    }
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    return {
      code: "setup_failed",
      message: "The SSH executable or required local setup file is unavailable.",
      recovery: "Automatic reconnect stopped. Check SSH installation and local setup, then use /reconnect.",
      retryable: false,
    }
  if (error instanceof RemoteReplyError || error instanceof RemoteError)
    return {
      code: error.code,
      message: setupDiagnostic(error, "Remote attachment was rejected."),
      recovery:
        "Automatic reconnect stopped. Fix the remote setup, then use /reconnect or detach and run amira remote add again.",
      retryable: false,
    }
  return {
    code: "setup_failed",
    message: "Remote setup could not be verified.",
    recovery:
      "Automatic reconnect stopped. Check SSH and the signed server bundle, then use /reconnect or run amira remote add again.",
    retryable: false,
  }
}
