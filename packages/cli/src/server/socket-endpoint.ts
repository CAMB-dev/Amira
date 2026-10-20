import { lstatSync } from "node:fs"
import path from "node:path"

export interface DaemonEndpoint {
  readonly socket: string
  readonly uid: number
  readonly pid: number
  readonly processIdentity: string
  /** Recheck the pinned paths and ownership fence after connect, before any bytes are sent. */
  verify(): void
}

export interface SocketChecks {
  privatePath(file: string, directory: boolean): void
  socketPath(file: string): void
  ancestor(file: string): void
}

export function socketEndpoint(
  identity: Omit<DaemonEndpoint, "verify">,
  checks: SocketChecks,
  ownershipDirectory: string,
  verifyOwner: () => void,
): DaemonEndpoint {
  const socket = identity.socket
  if (!path.isAbsolute(socket) || path.normalize(socket) !== socket)
    throw new Error("Invalid daemon socket path")
  const directory = path.dirname(socket)
  const base = path.dirname(directory)
  const privateDirectories = [directory, base]
  if (directory !== ownershipDirectory) {
    if (path.basename(base) !== "amira") throw new Error("Invalid daemon socket root")
    privateDirectories.push(path.dirname(base))
  }
  const ancestors: string[] = []
  for (let current = directory; ; current = path.dirname(current)) {
    ancestors.push(current)
    if (path.dirname(current) === current) break
  }
  const inspect = () => {
    verifyOwner()
    for (const file of ancestors) checks.ancestor(file)
    for (const file of privateDirectories) checks.privatePath(file, true)
    checks.socketPath(socket)
    return [...ancestors, socket].map((file) => {
      const stat = lstatSync(file)
      return `${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}:${file === socket ? stat.ctimeMs : ""}`
    })
  }
  const pinned = inspect()
  return Object.freeze({
    ...identity,
    verify() {
      const current = inspect()
      if (current.some((value, index) => value !== pinned[index]))
        throw new Error("Daemon socket identity changed during connect")
    },
  })
}

/** The connected peer, not a pathname check alone, binds the nonce to the expected daemon. */
export function assertDaemonPeer(
  endpoint: DaemonEndpoint,
  peer: { uid: number; pid: number },
  processIdentity: string | undefined,
): void {
  if (peer.uid !== endpoint.uid || peer.pid !== endpoint.pid || processIdentity !== endpoint.processIdentity)
    throw new Error("Connected daemon process identity does not match")
  endpoint.verify()
}
