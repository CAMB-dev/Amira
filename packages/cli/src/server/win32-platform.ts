import { createConnection, createServer, type Socket } from "node:net"
import path from "node:path"
import type { RemoteIO } from "../remote/connection.ts"
import { openDaemonLog } from "./daemon-log.ts"
import { proveClient, proveToDaemon } from "./daemon-proof.ts"
import { spawnDetachedDaemon } from "./daemon-spawn.ts"
import type { DaemonDiscovery } from "./discovery.ts"
import { DaemonUnavailableError } from "./fallback.ts"
import type { DaemonLayout } from "./layout.ts"
import { type DaemonPlatform, socketIO } from "./platform.ts"
import type { DaemonEndpoint } from "./socket-endpoint.ts"
import {
  closeHandle,
  handleSddl,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
  jobLimitFlags,
  openHandle,
  setHandleSddl,
  tokenFacts,
  Win32Error,
} from "./win32-ffi.ts"
import { randomPipeName, windowsProcessIdentity } from "./win32-layout.ts"
import { lockedPipeProblem, lockedPipeSddl, parseSddl } from "./win32-sddl.ts"

// GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER
const LOCKDOWN_ACCESS = (0x80000000 | 0x40000000 | 0x20000 | 0x40000 | 0x80000) >>> 0
/** PIPE_BUSY, ACCESS_DENIED, SEM_TIMEOUT: another process holds the fresh pipe's instances. */
const contendedLockdown = new Set([231, 5, 121])
const listenAttempts = 5
const connectionLimit = 128

/**
 * Bun's detached spawn does not request breakaway, so a child stays in this process's job.
 * Only a job that ends its processes on close and lets children leave silently is safe.
 * Outer jobs of a nested job cannot be queried and are not covered.
 */
export function jobProblem(flags: number | undefined): string | undefined {
  if (flags === undefined || !(flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)) return undefined
  return flags & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK ? undefined : "kill on job close"
}

export interface WindowsPlatformOptions {
  /** Test-only: runs between listen and lockdown, where another local user could race for instances. */
  beforeLockdown?: (pipe: string) => void
  /** Test-only job limit flags in place of this process's job. */
  jobFlags?: () => number | undefined
}

type Listener = { close(): Promise<void>; endpoint: string }

/**
 * Windows OS effects. Bun's pipe sockets expose no handle, so no connection can name its peer:
 * the mutual proof keyed by daemon.json's ACL-private nonce is the authentication boundary. The
 * pipe DACL and label reduce denial of service and are read back, but secrecy never relies on them.
 */
export class WindowsDaemonPlatform implements DaemonPlatform {
  constructor(
    private command: readonly string[],
    private modelMode: "local-proxy" | "remote-key",
    private layout: () => DaemonLayout,
    private options: WindowsPlatformOptions = {},
  ) {
    if (process.platform !== "win32") throw new Error("Windows daemons require Windows")
  }

  now = Date.now
  sleep = (ms: number) => Bun.sleep(ms)
  processIdentity = windowsProcessIdentity

  async spawn(discovery: DaemonDiscovery): Promise<void> {
    if (jobProblem((this.options.jobFlags ?? jobLimitFlags)())) throw new DaemonUnavailableError("job")
    discovery.validate()
    discovery.validateSocketDirectory()
    const layout = this.layout()
    const log = openDaemonLog(path.join(discovery.directory, "daemon.log"), (file) =>
      layout.checkPrivate(file, false),
    )
    await spawnDetachedDaemon(this.command, this.modelMode, discovery.workspace, log)
  }

  async connect(endpoint: DaemonEndpoint): Promise<RemoteIO> {
    endpoint.verify()
    const nonce = endpoint.nonce
    if (!nonce) throw new Error("Daemon endpoint has no connection proof key")
    const connection = await new Promise<Socket>((resolve, reject) => {
      const socket = createConnection({ path: endpoint.socket })
      socket.setTimeout(5000, () =>
        socket.destroy(Object.assign(new Error("Daemon connect timed out"), { code: "ETIMEDOUT" })),
      )
      socket.once("error", reject)
      socket.once("connect", () => {
        socket.setTimeout(0)
        socket.removeListener("error", reject)
        // Iterator/writes observe errors; avoid unhandled errors before the iterator starts.
        socket.on("error", () => {})
        resolve(socket)
      })
    })
    try {
      // Whoever answers on this name must prove the nonce before anything derived from it is sent.
      const io = await proveToDaemon(socketIO(connection), endpoint.socket, nonce)
      endpoint.verify()
      return io
    } catch (error) {
      connection.destroy()
      throw error
    }
  }

  async listen(first: string, accept: (io: RemoteIO) => void, nonce: string): Promise<Listener> {
    const user = tokenFacts().user
    for (let attempt = 0; attempt < listenAttempts; attempt++) {
      // A fresh unprefixed name every time: a contender learns nothing about whose daemon it is.
      const listener = await this.listenOnce(attempt ? randomPipeName() : first, accept, nonce, user)
      if (listener) return listener
    }
    throw new DaemonUnavailableError("start")
  }

  /** Undefined when the name is taken or its lockdown was contended; the caller retries. */
  private listenOnce(
    pipe: string,
    accept: (io: RemoteIO) => void,
    nonce: string,
    user: string,
  ): Promise<Listener | undefined> {
    return new Promise((resolve, reject) => {
      const sockets = new Set<Socket>()
      const server = createServer((connection) => {
        connection.on("error", () => {})
        if (sockets.size >= connectionLimit) return void connection.destroy()
        sockets.add(connection)
        connection.once("close", () => sockets.delete(connection))
        // Connections opened before lockdown arrive here too. The server writes nothing before a
        // well-formed challenge, so a read-only handle learns nothing and times out.
        const io = socketIO(connection)
        proveClient(io, pipe, nonce).then(accept, () => io.close())
      })
      let closing: Promise<void> | undefined
      const close = () =>
        (closing ??= new Promise<void>((done, fail) => {
          for (const connection of sockets) connection.destroy()
          server.close((error) => (error ? fail(error) : done()))
        }))
      server.once("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") resolve(undefined)
        else reject(error)
      })
      server.listen(pipe, () => {
        server.removeAllListeners("error")
        server.on("error", () => {})
        let outcome: "locked" | "contended" | Error
        try {
          outcome = this.lockdown(pipe, user)
        } catch (error) {
          outcome = error as Error
        }
        if (outcome === "locked") return resolve({ close, endpoint: pipe })
        close().then(() => (outcome === "contended" ? resolve(undefined) : reject(outcome)), reject)
      })
    })
  }

  /** Synchronous, inside the listen callback: replace the default DACL, then read it back. */
  private lockdown(pipe: string, user: string): "locked" | "contended" {
    this.options.beforeLockdown?.(pipe)
    const opened = openHandle(pipe, LOCKDOWN_ACCESS)
    if (opened.error !== undefined) {
      if (contendedLockdown.has(opened.error)) return "contended"
      throw new Win32Error("CreateFile", opened.error)
    }
    try {
      setHandleSddl(opened.handle, lockedPipeSddl(user))
      // Not retried: a lockdown that does not read back means something is badly wrong.
      const problem = lockedPipeProblem(parseSddl(handleSddl(opened.handle)), user)
      if (problem) throw new Error(`Daemon pipe lockdown did not hold (${problem})`)
      return "locked"
    } finally {
      // The server side of this handle reaches accept as a silent connection and closes with it.
      closeHandle(opened.handle)
    }
  }
}
