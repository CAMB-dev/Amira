import { encodeRemoteMessage } from "../remote/codec.ts"
import type { RemoteIO } from "../remote/connection.ts"
import { REMOTE_LIMITS, type RemoteRelease } from "../remote/protocol.ts"
import { validateRemoteFrame } from "../remote-schema.ts"
import { openWorkspaceDaemon } from "./daemon.ts"
import type { DaemonDiscovery } from "./discovery.ts"
import { daemonAttachFault } from "./errors.ts"
import type { DaemonPlatform } from "./platform.ts"
import { privateMessage, readPrivatePrelude } from "./private-ipc.ts"

/** Copies one bounded chunk at a time and awaits each write. EOF/EPIPE closes only the relay. */
export async function relayBytes(frontend: RemoteIO, daemon: RemoteIO): Promise<void> {
  const copy = async (from: RemoteIO, to: RemoteIO) => {
    for await (const bytes of from.input) await to.write(bytes)
  }
  try {
    await Promise.race([copy(frontend, daemon), copy(daemon, frontend)])
  } finally {
    frontend.close()
    daemon.close()
  }
}

export async function attachWorkspace(options: {
  io: RemoteIO
  discovery(workspace: string): DaemonDiscovery
  platform: DaemonPlatform
  release: RemoteRelease
}): Promise<void> {
  let daemon: RemoteIO | undefined
  let relaying = false
  try {
    const { value, tail } = await readPrivatePrelude(options.io, REMOTE_LIMITS.lineBytes)
    const hello = validateRemoteFrame(value)
    if (hello.kind !== "hello") throw new Error("Expected attach hello")
    const discovery = options.discovery(hello.workspace)
    const ready = await openWorkspaceDaemon({ ...options, discovery })
    daemon = ready.io
    await privateMessage(daemon, { action: "attach", nonce: ready.metadata.nonce })
    // Canonicalization is remote-only. The client learns the canonical identity in welcome.
    for (const bytes of encodeRemoteMessage({ ...hello, workspace: discovery.workspace }))
      await daemon.write(bytes)
    relaying = true
    await relayBytes(tail, daemon)
  } catch (error) {
    if (relaying) return
    // Details remain private. Never emit banners, paths, settings or raw exceptions on stdout.
    try {
      for (const bytes of encodeRemoteMessage({
        v: 1,
        kind: "reject",
        error: daemonAttachFault(error),
      }))
        await options.io.write(bytes)
    } catch {}
  } finally {
    options.io.close()
    daemon?.close()
  }
}

/** Explicit owner stop, deliberately separate from turn.abort and relay detach. */
export async function stopWorkspace(discovery: DaemonDiscovery, platform: DaemonPlatform): Promise<void> {
  const meta = discovery.read()
  if (!meta) return
  if (platform.processIdentity(meta.pid) !== meta.processIdentity)
    throw new Error("Daemon process identity changed; refusing to stop it")
  const io = await platform.connect(discovery.endpoint(meta))
  try {
    await privateMessage(io, { action: "stop", nonce: meta.nonce })
    const { value } = await readPrivatePrelude(io)
    const response = value as { nonce?: string; stopped?: boolean }
    if (response?.nonce !== meta.nonce || response.stopped !== true)
      throw new Error("Daemon stop was not acknowledged")
  } finally {
    io.close()
  }
}
