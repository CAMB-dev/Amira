import { spawn } from "node:child_process"
import { closeSync, readFileSync } from "node:fs"
import { createConnection, createServer, type Socket } from "node:net"
import type { RemoteIO } from "../remote/connection.ts"
import { openDaemonLog } from "./daemon-log.ts"
import type { DaemonDiscovery } from "./discovery.ts"
import { readLinuxPeer } from "./linux-peer.ts"
import { assertDaemonPeer, type DaemonEndpoint } from "./socket-endpoint.ts"

export interface DaemonPlatform {
  now(): number
  sleep(ms: number): Promise<void>
  /** Undefined means proven absent, not an inconclusive probe. */
  processIdentity(pid: number): string | undefined
  spawn(discovery: DaemonDiscovery): Promise<void>
  connect(endpoint: DaemonEndpoint): Promise<RemoteIO>
  listen(socket: string, accept: (io: RemoteIO) => void): Promise<{ close(): Promise<void> }>
}

export function socketIO(socket: Socket): RemoteIO {
  return {
    input: socket,
    write: (bytes) =>
      new Promise<void>((resolve, reject) => {
        socket.write(bytes, (error) => (error ? reject(error) : resolve()))
      }),
    close: () => socket.destroy(),
  }
}

/** Linux-only OS effects. Tests substitute this entire seam, never invoke SSH or detach a child. */
export class LinuxDaemonPlatform implements DaemonPlatform {
  constructor(
    private command: readonly string[],
    private modelMode: "local-proxy" | "remote-key" = "local-proxy",
  ) {
    if (process.platform !== "linux") throw new Error("Remote daemons require Linux")
  }

  now = Date.now
  sleep = (ms: number) => Bun.sleep(ms)

  processIdentity(pid: number): string | undefined {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    if (!boot) throw new Error("Unavailable process identity")
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
      if (!boot || !start || !/^\d+$/.test(start)) throw new Error("Unavailable process identity")
      return `${boot}:${start}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  async spawn(discovery: DaemonDiscovery): Promise<void> {
    discovery.validate()
    discovery.validateSocketDirectory()
    // Startup diagnostics are fixed-size; daemon mode replaces both writers with a capped sink.
    const log = openDaemonLog(`${discovery.directory}/daemon.log`)
    try {
      const child = spawn(
        this.command[0]!,
        [
          ...this.command.slice(1),
          "daemon",
          "--cwd",
          discovery.workspace,
          ...(this.modelMode === "remote-key" ? ["--remote-key"] : []),
        ],
        {
          detached: true,
          stdio: ["ignore", log, log],
          windowsHide: true,
          env: process.env,
        },
      )
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject)
        child.once("spawn", resolve)
      })
      child.unref()
    } finally {
      closeSync(log)
    }
  }

  async connect(endpoint: DaemonEndpoint): Promise<RemoteIO> {
    endpoint.verify()
    return new Promise((resolve, reject) => {
      const connection = createConnection({ path: endpoint.socket })
      connection.setTimeout(5000, () =>
        connection.destroy(Object.assign(new Error("Daemon connect timed out"), { code: "ETIMEDOUT" })),
      )
      connection.once("error", reject)
      connection.once("connect", () => {
        void (async () => {
          const peer = await readLinuxPeer(connection)
          assertDaemonPeer(endpoint, peer, this.processIdentity(peer.pid))
          connection.setTimeout(0)
          connection.removeListener("error", reject)
          // Iterator/writes observe errors; avoid unhandled errors before the iterator starts.
          connection.on("error", () => {})
          resolve(socketIO(connection))
        })().catch((error) => {
          connection.destroy()
          reject(error)
        })
      })
    })
  }

  listen(socket: string, accept: (io: RemoteIO) => void): Promise<{ close(): Promise<void> }> {
    return new Promise((resolve, reject) => {
      const sockets = new Set<Socket>()
      const server = createServer((connection) => {
        sockets.add(connection)
        connection.on("error", () => {})
        connection.once("close", () => sockets.delete(connection))
        accept(socketIO(connection))
      })
      server.once("error", reject)
      server.listen(socket, () => {
        server.removeListener("error", reject)
        server.on("error", () => {})
        resolve({
          close: () =>
            new Promise<void>((done, fail) => {
              for (const connection of sockets) connection.destroy()
              server.close((error) => (error ? fail(error) : done()))
            }),
        })
      })
    })
  }
}
