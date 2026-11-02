import { randomUUID } from "node:crypto"
import type { RemoteIO } from "../remote/connection.ts"
import { RemoteError } from "../remote/errors.ts"
import { REMOTE_PROTOCOL_VERSION, type RemoteRelease } from "../remote/protocol.ts"
import { rolesEnabledOn } from "./attach-intent.ts"
import { workspaceAttachments } from "./attachments.ts"
import { DaemonProofError } from "./daemon-proof.ts"
import type { DaemonDiscovery, DaemonMetadata } from "./discovery.ts"
import { DaemonIncompatibilityError, DaemonNotRunningError } from "./errors.ts"
import { IdleDeadline } from "./idle.ts"
import type { DaemonPlatform } from "./platform.ts"
import { privateMessage, readPrivatePrelude } from "./private-ipc.ts"
import type { WorkspaceRuntime } from "./runtime.ts"

/** Age-based temp cleaners must never see a live daemon's files as abandoned. */
const touchIntervalMs = 60 * 60 * 1000

function retryableLoss(error: unknown): boolean {
  if (error instanceof RemoteError) return error.code === "disconnected"
  return (
    error instanceof Error &&
    ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(
      (error as NodeJS.ErrnoException).code ?? "",
    )
  )
}

export interface WorkspaceDaemon {
  readonly metadata: DaemonMetadata
  readonly closed: Promise<void>
  /** A deterministic clock seam for tests; production polls live authority every second. */
  tick(): Promise<void>
  stop(): Promise<void>
}

/** Owns runtime/socket/lease lifetime. A relay never owns any of these resources. */
export async function startWorkspaceDaemon(options: {
  discovery: DaemonDiscovery
  platform: DaemonPlatform
  release: RemoteRelease
  idleTimeoutMs: number
  createRuntime(cwd: string): Promise<WorkspaceRuntime>
  poll?: boolean
  /** Honor attachment roles; defaults to the platforms whose daemons check the socket peer. */
  roles?: boolean
}): Promise<WorkspaceDaemon> {
  const { discovery, platform } = options
  const owner = discovery.claim("owner")
  if (!owner) throw new Error("A daemon already owns this workspace")
  let runtime: WorkspaceRuntime | undefined
  let listener: Awaited<ReturnType<DaemonPlatform["listen"]>> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let stopping: Promise<void> | undefined
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const sockets = new Set<{ close(): void }>()
  const stop = () => {
    stopping ??= (async () => {
      clearInterval(timer)
      for (const socket of sockets) socket.close()
      try {
        // Retire readiness before the endpoint closes: a client then sees a live owner lock
        // and no metadata, and relaunches after release instead of meeting a freed endpoint.
        discovery.retireMetadata()
      } finally {
        try {
          await listener?.close()
        } finally {
          try {
            await runtime?.stop()
          } finally {
            try {
              discovery.clearOwnedFiles()
            } finally {
              owner.release()
              resolveClosed()
            }
          }
        }
      }
    })()
    return stopping
  }
  try {
    discovery.clearOwnedFiles()
    discovery.clearReplacement()
    runtime = await options.createRuntime(discovery.workspace)
    const identity = platform.processIdentity(process.pid)
    if (!identity) throw new Error("Daemon process identity is unavailable")
    const metadata: DaemonMetadata = {
      workspace: discovery.workspace,
      socket: discovery.socket,
      protocol: REMOTE_PROTOCOL_VERSION,
      release: options.release,
      daemonEpoch: runtime.journal.daemonEpoch,
      pid: process.pid,
      processIdentity: identity,
      nonce: randomUUID(),
      lockIdentity: discovery.lockIdentity(),
    }
    const authority = workspaceAttachments(runtime, { roles: options.roles ?? rolesEnabledOn() })
    const accept = (io: RemoteIO) => {
      if (stopping || sockets.size >= 128) {
        io.close()
        return
      }
      sockets.add(io)
      void (async () => {
        try {
          let { value, tail } = await readPrivatePrelude(io)
          const validate = (value: unknown) => {
            const request = value as { action: string; nonce: string }
            if (
              !request ||
              Object.keys(request).sort().join(",") !== "action,nonce" ||
              request.nonce !== metadata.nonce
            )
              throw new Error("Stale daemon connection")
            return request
          }
          let request = validate(value)
          if (request.action === "open") {
            // Reserve this very connection through attach admission; idle drain cannot cut between them.
            await privateMessage(io, { nonce: metadata.nonce, daemonEpoch: metadata.daemonEpoch })
            const admission = await readPrivatePrelude(tail)
            tail = admission.tail
            request = validate(admission.value)
            if (request.action !== "attach") throw new Error("Expected attachment admission")
          }
          if (request.action === "probe") {
            await privateMessage(io, { nonce: metadata.nonce, daemonEpoch: metadata.daemonEpoch })
          } else if (request.action === "stop") {
            await privateMessage(io, { nonce: metadata.nonce, stopped: true })
            void stop().catch(() => {})
          } else if (request.action === "attach") {
            const connection = authority.connect(tail, {
              release: options.release,
              workspace: metadata.workspace,
            })
            await connection.closed
          } else throw new Error("Invalid daemon action")
        } catch {
          // No exception text or protocol diagnostics on a relay's stdout.
        } finally {
          sockets.delete(io)
          io.close()
        }
      })()
    }
    listener = await platform.listen(discovery.socket, accept, metadata.nonce)
    // A platform that had to pick another endpoint (a busy Windows pipe name) reports it here.
    metadata.socket = listener.endpoint ?? metadata.socket
    discovery.privateSocket()
    discovery.publish(metadata)
    const deadline = new IdleDeadline(options.idleTimeoutMs)
    let touched = platform.now()
    const tick = async () => {
      if (stopping) return stopping
      // A replaced or deleted owner lock ends this daemon's authority; its files are no longer ours.
      if (!discovery.ownsLock()) return stop().catch(() => {})
      if (platform.now() - touched >= touchIntervalMs) {
        touched = platform.now()
        try {
          discovery.touch()
        } catch {
          // Best effort; a lost lock is caught by the check above on the next tick.
        }
      }
      // Viewers never keep the daemon alive or hold back a replacement; they reconnect or see it stop.
      const idle = runtime!.quiescent() && sockets.size - authority.viewers <= 0
      if (
        (idle && discovery.replacement()) ||
        deadline.sample(platform.now(), { idle, revision: runtime!.activityVersion })
      )
        await stop()
    }
    // Establish the deadline at readiness, not a second later.
    await tick()
    if (options.poll !== false) {
      timer = setInterval(() => {
        void tick().catch(() => stop().catch(() => {}))
      }, 1000)
    }
    return { metadata, closed, tick, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

interface StartupOptions {
  discovery: DaemonDiscovery
  platform: DaemonPlatform
  release: RemoteRelease
  startupTimeoutMs?: number
  /** false: only a running daemon; a viewer never starts one (DaemonNotRunningError). */
  start?: boolean
}

/** Bounded startup readiness. Contenders never spawn unless they own the startup lock. */
export async function ensureWorkspaceDaemon(options: StartupOptions): Promise<DaemonMetadata> {
  return (await readyWorkspaceDaemon(options, false)).metadata
}

/** Readiness and attach admission share a reserved, identity-verified connection. Caller owns close. */
export function openWorkspaceDaemon(
  options: StartupOptions,
): Promise<{ metadata: DaemonMetadata; io: RemoteIO }> {
  return readyWorkspaceDaemon(options, true)
}

async function readyWorkspaceDaemon(
  options: StartupOptions,
  retain: boolean,
): Promise<{ metadata: DaemonMetadata; io: RemoteIO }> {
  const { discovery, platform, release } = options
  const until = platform.now() + (options.startupTimeoutMs ?? 15_000)
  let startup: ReturnType<DaemonDiscovery["claim"]>
  let launched = false
  let unverified = false
  try {
    do {
      let io: RemoteIO | undefined
      let retained = false
      try {
        const meta = discovery.read()
        const identity = meta && platform.processIdentity(meta.pid)
        if (meta && identity === meta.processIdentity) {
          if (meta.protocol !== REMOTE_PROTOCOL_VERSION) throw new DaemonIncompatibilityError()
          // Metadata, ownership and endpoint acquisition can race normal idle retirement too.
          io = await platform.connect(discovery.endpoint(meta))
          await privateMessage(io, { action: retain ? "open" : "probe", nonce: meta.nonce })
          const { value, tail } = await readPrivatePrelude(io)
          const result = value as { nonce?: string; daemonEpoch?: string }
          if (result?.nonce !== meta.nonce || result.daemonEpoch !== meta.daemonEpoch)
            throw new Error("Daemon readiness identity changed")
          // Only a caller that may start a daemon asks for its replacement; a viewer just watches.
          if (
            options.start !== false &&
            (meta.release.buildId !== release.buildId || meta.release.version !== release.version)
          )
            discovery.replacement(release)
          retained = retain
          return { metadata: meta, io: tail }
        }
        if (options.start === false) throw new DaemonNotRunningError()
        // A recorded PID that now names another process only says the daemon is gone. The owner
        // lock decides: a lease policy can prove its holder dead, the default probe cannot.
        if (!launched) {
          if (discovery.canStart()) {
            startup ??= discovery.claim("startup")
            if (startup) {
              await platform.spawn(discovery)
              launched = true
            }
          } else if (meta && identity !== undefined)
            throw new Error("Daemon PID identity changed; workspace ownership cannot be proven dead")
        }
      } catch (error) {
        // Missing/closed endpoints may be retiring. Permission, identity and malformed replies
        // fail closed immediately. A retry never grants authority to reclaim a live owner.
        if (!retryableLoss(error)) throw error
        unverified = error instanceof DaemonProofError
      } finally {
        if (!retained) io?.close()
      }
      await platform.sleep(25)
    } while (platform.now() < until)
    if (options.start === false) throw new DaemonNotRunningError()
    throw new Error(
      unverified
        ? "Remote daemon could not be verified before the startup deadline"
        : "Remote daemon did not become ready before the startup deadline",
    )
  } finally {
    startup?.release()
  }
}
