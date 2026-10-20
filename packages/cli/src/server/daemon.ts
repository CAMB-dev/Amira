import { randomUUID } from "node:crypto"
import type { RemoteIO } from "../remote/connection.ts"
import { RemoteError } from "../remote/errors.ts"
import { REMOTE_PROTOCOL_VERSION, type RemoteRelease } from "../remote/protocol.ts"
import { workspaceAttachments } from "./attachments.ts"
import type { DaemonDiscovery, DaemonMetadata } from "./discovery.ts"
import { DaemonIncompatibilityError } from "./errors.ts"
import { IdleDeadline } from "./idle.ts"
import type { DaemonPlatform } from "./platform.ts"
import { privateMessage, readPrivatePrelude } from "./private-ipc.ts"
import type { WorkspaceRuntime } from "./runtime.ts"

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
    const authority = workspaceAttachments(runtime)
    listener = await platform.listen(discovery.socket, (io) => {
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
    })
    discovery.privateSocket()
    discovery.publish(metadata)
    const deadline = new IdleDeadline(options.idleTimeoutMs)
    const tick = async () => {
      if (stopping) return stopping
      const idle = runtime!.quiescent() && sockets.size === 0
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
          if (meta.release.buildId !== release.buildId || meta.release.version !== release.version)
            discovery.replacement(release)
          retained = retain
          return { metadata: meta, io: tail }
        }
        if (meta && identity !== undefined)
          throw new Error("Daemon PID identity changed; workspace ownership cannot be proven dead")
        if (!launched && discovery.canStart()) {
          startup ??= discovery.claim("startup")
          if (startup) {
            await platform.spawn(discovery)
            launched = true
          }
        }
      } catch (error) {
        // Missing/closed endpoints may be retiring. Permission, identity and malformed replies
        // fail closed immediately. A retry never grants authority to reclaim a live owner.
        if (!retryableLoss(error)) throw error
      } finally {
        if (!retained) io?.close()
      }
      await platform.sleep(25)
    } while (platform.now() < until)
    throw new Error("Remote daemon did not become ready before the startup deadline")
  } finally {
    startup?.release()
  }
}
