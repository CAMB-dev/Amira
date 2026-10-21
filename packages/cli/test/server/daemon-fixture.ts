import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { RemoteIO } from "../../src/remote/connection.ts"
import type { RemoteRelease } from "../../src/remote/protocol.ts"
import { startWorkspaceDaemon, type WorkspaceDaemon } from "../../src/server/daemon.ts"
import { DaemonDiscovery } from "../../src/server/discovery.ts"
import type { DaemonPlatform } from "../../src/server/platform.ts"
import type { WorkspaceRuntime } from "../../src/server/runtime.ts"
import { assertDaemonPeer, type DaemonEndpoint } from "../../src/server/socket-endpoint.ts"
import { loopback } from "../remote/loopback.ts"

export const release: RemoteRelease = { version: "fixture", buildId: "build-one", target: "fake-linux" }
export function discoveryTempDir(platform: NodeJS.Platform, tmpDir: string, runnerTemp?: string): string {
  // macOS's per-user TMPDIR is too long for sockaddr_un, even with a short fixture prefix.
  if (platform === "darwin") return "/tmp"
  // Windows CI's per-user Temp also exceeds the stable fallback socket budget; RUNNER_TEMP is shorter.
  return platform === "win32" && runnerTemp ? runnerTemp : tmpDir
}
export function discoveryFixture(
  tmpDir = discoveryTempDir(process.platform, os.tmpdir(), process.env.RUNNER_TEMP),
) {
  // Resolve system aliases (/tmp -> /private/tmp on macOS) before strict ancestor checks.
  const root = realpathSync(mkdtempSync(path.join(tmpDir, "ad-")))
  const home = path.join(root, "h")
  const runtimeDir = path.join(root, "r")
  const cwd = path.join(root, "w")
  for (const dir of [home, runtimeDir, cwd]) mkdirSync(dir)
  const checkPrivate = (file: string, directory: boolean) => {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
      throw new Error("Foreign or symlink runtime path")
  }
  const options = {
    home,
    runtimeDir,
    tmpDir: root,
    uid: 1,
    checkPrivate,
    checkSocket(file: string) {
      checkPrivate(file, false)
      if (readFileSync(file, "utf8") !== "fake-private-socket") throw new Error("Not a private socket")
    },
    checkAncestor(file: string) {
      const stat = lstatSync(file)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Untrusted socket ancestor")
    },
  }
  return { root, cwd, options, discovery: new DaemonDiscovery(cwd, options) }
}

/** Harness owns the runtime; fake spawn never starts a real daemon or SSH executable. */
export class FakeDaemonPlatform implements DaemonPlatform {
  time = 0
  spawns = 0
  identity: string | undefined = "boot:123"
  accept?: (io: RemoteIO) => void
  daemon?: WorkspaceDaemon
  startupError = false
  listenError = false
  constructor(
    readonly discovery: DaemonDiscovery,
    private createRuntime: (cwd: string) => Promise<WorkspaceRuntime>,
    private idleTimeoutMs = 1000,
  ) {}
  now = () => this.time
  sleep = async (ms: number) => {
    this.time += ms
    await Bun.sleep(1)
  }
  processIdentity = () => this.identity
  async spawn(): Promise<void> {
    this.spawns++
    if (this.startupError) throw new Error("Fake startup failed")
    this.daemon = await startWorkspaceDaemon({
      discovery: this.discovery,
      platform: this,
      release,
      idleTimeoutMs: this.idleTimeoutMs,
      createRuntime: this.createRuntime,
      poll: false,
    })
  }
  peer = { uid: 1, pid: process.pid }
  beforeConnect?: () => void
  async connect(endpoint: DaemonEndpoint): Promise<RemoteIO> {
    endpoint.verify()
    this.beforeConnect?.()
    if (!this.accept) throw Object.assign(new Error("No listener"), { code: "ECONNREFUSED" })
    const pipe = loopback(17)
    try {
      assertDaemonPeer(endpoint, this.peer, this.processIdentity())
      this.accept(pipe.server)
      return pipe.client
    } catch (error) {
      pipe.client.close()
      throw error
    }
  }
  async listen(_socket: string, accept: (io: RemoteIO) => void) {
    if (this.listenError) throw new Error("Fake bind failed")
    writeFileSync(this.discovery.socket, "fake-private-socket")
    this.accept = accept
    return {
      close: async () => {
        this.accept = undefined
      },
    }
  }
}
