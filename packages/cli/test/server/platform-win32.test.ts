import { dlopen, ptr } from "bun:ffi"
import { afterAll, expect, test } from "bun:test"
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import {
  SPAWN_TEST_TIMEOUT_MS,
  waitForSpawnCondition,
  waitForSpawnExit,
  waitForSpawnWork,
} from "../../../../scripts/spawn-test.ts"
import { RemoteConnection } from "../../src/remote/connection.ts"
import { attachWorkspace, stopWorkspace } from "../../src/server/attach.ts"
import { ensureWorkspaceDaemon, startWorkspaceDaemon, type WorkspaceDaemon } from "../../src/server/daemon.ts"
import { openDaemonLog } from "../../src/server/daemon-log.ts"
import { DaemonDiscovery, type DaemonMetadata } from "../../src/server/discovery.ts"
import { daemonFallback } from "../../src/server/fallback.ts"
import { selectDaemonHost } from "../../src/server/host.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import {
  closeHandle,
  createDirectory,
  DRIVE_FIXED,
  driveType,
  enableLua,
  fileSddl,
  handleSddl,
  jobLimitFlags,
  localAppData,
  machineGuid,
  openHandle,
  processCreationTimes,
  tokenFacts,
} from "../../src/server/win32-ffi.ts"
import { validPipeName, windowsDaemonLayout, windowsProcessIdentity } from "../../src/server/win32-layout.ts"
import {
  jobProblem,
  WindowsDaemonPlatform,
  type WindowsPlatformOptions,
} from "../../src/server/win32-platform.ts"
import {
  HIGH_INTEGRITY,
  integrityProblem,
  lockedPipeProblem,
  parseSddl,
  privateDescriptorProblem,
  privateDirectorySddl,
} from "../../src/server/win32-sddl.ts"
import { hello, loopback } from "../remote/loopback.ts"
import { release } from "./daemon-fixture.ts"

// Native Windows checks. Everything runs against temporary roots and pipes this file creates.
function skipReason(): string | undefined {
  if (process.platform !== "win32") return "Windows only"
  const token = tokenFacts()
  if (integrityProblem(token.integrity, token.integrity >= HIGH_INTEGRITY ? enableLua() : undefined))
    return "this token may not run daemons (elevated with UAC on, or below Medium integrity)"
  return undefined
}
const reason = skipReason()
const native = (name: string, run: () => unknown, timeout?: number) =>
  reason ? test.skip(`${name} [skipped: ${reason}]`, () => {}) : test(name, run as () => void, timeout)
const jobReason = (() => {
  if (reason) return reason
  // CI runners can run tests inside a job that ends its processes; the daemon check refuses that.
  return jobProblem(jobLimitFlags()) ? "this process runs in a job that kills detached children" : undefined
})()

const GENERIC_READ = 0x80000000
const READ_CONTROL = 0x20000
const roots: string[] = []
const daemons: WorkspaceDaemon[] = []
afterAll(async () => {
  for (const daemon of daemons) await daemon.stop().catch(() => {})
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

function tempRoot(): string {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "amira-win-")))
  roots.push(root)
  return root
}

/** A test-only root with its directories above trusted; the layout still owns everything below. */
function fixture(options: Parameters<typeof windowsDaemonLayout>[0] = {}) {
  const root = tempRoot()
  const cwd = path.join(root, "workspace")
  mkdirSync(cwd)
  const layout = windowsDaemonLayout({ root, checkAncestor: () => {}, ...options })
  return { root, cwd, layout, discovery: new DaemonDiscovery(cwd, layout) }
}

const runtime = (cwd: string) =>
  createWorkspaceRuntime({
    cwd,
    autoTitle: false,
    model: "mock/m",
    ai: createAi({
      dialects: [createMockDialect()],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    builtins: async () => [],
  })

async function startDaemon(f: ReturnType<typeof fixture>, options: WindowsPlatformOptions = {}) {
  const platform = new WindowsDaemonPlatform(["unused-daemon-command"], "remote-key", () => f.layout, options)
  const daemon = await startWorkspaceDaemon({
    discovery: f.discovery,
    platform,
    release,
    idleTimeoutMs: 600_000,
    createRuntime: runtime,
    poll: false,
  })
  daemons.push(daemon)
  return { platform, daemon }
}

const pipeSddl = (pipe: string) => {
  const opened = openHandle(pipe, READ_CONTROL)
  if (opened.error !== undefined) throw new Error(`open ${opened.error}`)
  try {
    return handleSddl(opened.handle)
  } finally {
    closeHandle(opened.handle)
  }
}

const peek = (() => {
  if (process.platform !== "win32") return () => 0
  const { PeekNamedPipe, GetLastError } = dlopen("kernel32.dll", {
    PeekNamedPipe: { args: ["u64", "ptr", "u32", "ptr", "ptr", "ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  }).symbols
  /** Bytes the server ever wrote to this handle that are waiting, or -error when the pipe broke. */
  return (handle: bigint) => {
    const available = new Uint32Array(1)
    return PeekNamedPipe(handle, null, 0, null, ptr(available), null) ? available[0]! : -GetLastError()
  }
})()

native(
  "process identity covers this process, an exited child, a never-used PID and unopenable processes",
  async () => {
    const self = windowsProcessIdentity(process.pid)
    expect(self).toMatch(/^w:\d+$/)
    expect(windowsProcessIdentity(process.pid)).toBe(self)
    const list = processCreationTimes()
    expect(`w:${list.get(process.pid)}`).toBe(self!)
    const child = Bun.spawn(["cmd.exe", "/d", "/c", "exit 0"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    await waitForSpawnExit(child, "short child")
    expect(windowsProcessIdentity(child.pid)).toBeUndefined()
    expect(windowsProcessIdentity(0x7ffffff1)).toBeUndefined()
    // The System process (PID 4) denies a normal user's OpenProcess; the process list still knows it.
    expect(list.has(4)).toBe(true)
    expect(windowsProcessIdentity(4)).toBe(`w:${list.get(4)}`)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

native("token, machine and known-folder facts come from the OS, not the environment", () => {
  const token = tokenFacts()
  expect(token.user).toMatch(/^S-1-5-21-\d+-\d+-\d+-\d+$/)
  expect(token.integrity).toBeGreaterThanOrEqual(0x2000)
  expect(machineGuid()).toMatch(/^[0-9a-f-]{36}$/)
  // The test preload already points USERPROFILE at a temporary home; the shell must ignore it.
  const saved = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = "Z:\\spoofed"
  try {
    expect(localAppData()).not.toBe("Z:\\spoofed")
    expect(localAppData().toLowerCase().startsWith(process.env.USERPROFILE!.toLowerCase())).toBe(false)
  } finally {
    process.env.LOCALAPPDATA = saved
  }
  expect(driveType(localAppData().slice(0, 3))).toBe(DRIVE_FIXED)
  const flags = jobLimitFlags()
  expect(flags === undefined || Number.isInteger(flags)).toBe(true)
})

native(
  "a labelled private directory reads back as protected user+SYSTEM, and files inside inherit it",
  () => {
    const user = tokenFacts().user
    const directory = path.join(tempRoot(), "private")
    expect(createDirectory(directory, privateDirectorySddl(user))).toBe(true)
    // An existing directory is reported, never re-labelled.
    expect(createDirectory(directory, privateDirectorySddl(user))).toBe(false)
    const descriptor = parseSddl(fileSddl(directory))
    const principal = { user, owners: [user, tokenFacts().owner] }
    expect(descriptor.dacl?.protected).toBe(true)
    expect(descriptor.labels.map((label) => [label.sid, label.rights])).toEqual([["S-1-16-8192", 3]])
    expect(privateDescriptorProblem(descriptor, principal)).toBeUndefined()
    const file = path.join(directory, "daemon.json")
    writeFileSync(file, "{}")
    expect(privateDescriptorProblem(parseSddl(fileSddl(file)), principal)).toBeUndefined()
    // A directory under the temp folder inherits its parent's ACL, which names Administrators.
    const plain = path.join(tempRoot(), "plain")
    mkdirSync(plain)
    expect(privateDescriptorProblem(parseSddl(fileSddl(plain)), principal)).toBe("foreign access")
  },
)

native("the layout keys junction, case and private-root variants of one folder alike", () => {
  const f = fixture()
  expect(f.layout.stableRoot).toBe(path.join(f.root, "amira-daemons"))
  expect(f.discovery.ownershipDirectory).toBe(
    path.join(f.layout.stableRoot, path.basename(f.discovery.ownershipDirectory)),
  )
  expect(f.discovery.directory).toBe(f.discovery.ownershipDirectory)
  expect(validPipeName(f.discovery.socket)).toBe(true)
  const junction = path.join(f.root, "linked")
  symlinkSync(f.cwd, junction, "junction")
  const viaJunction = f.layout.workspaceKey(junction)
  const viaCase = f.layout.workspaceKey(f.cwd.toUpperCase())
  expect(viaJunction).toEqual(f.layout.workspaceKey(f.cwd))
  expect(viaCase).toEqual(viaJunction)
  expect(viaJunction.workspace).toBe(f.cwd[0]!.toUpperCase() + f.cwd.slice(1))
  expect(viaJunction.key).toMatch(/^[0-9a-f]{24}$/)
  const principal = { user: tokenFacts().user, owners: [tokenFacts().user, tokenFacts().owner] }
  for (const directory of [f.layout.stableRoot, f.discovery.ownershipDirectory])
    expect(privateDescriptorProblem(parseSddl(fileSddl(directory)), principal)).toBeUndefined()
  // The lease policy uses this machine and the platform's process identity.
  expect(f.layout.leasePolicy?.domain.host).toMatch(/^[0-9a-f]{64}$/)
  expect(f.layout.leasePolicy?.start(process.pid)).toBe(windowsProcessIdentity(process.pid))
})

native("a top directory that is not private, or an elevated token, falls back to in-process", () => {
  const root = tempRoot()
  // As the installer's own folder would be: it inherits the profile's ACL.
  mkdirSync(path.join(root, "amira-daemons"))
  mkdirSync(path.join(root, "w"))
  const layout = windowsDaemonLayout({ root, checkAncestor: () => {} })
  const refusal = (run: () => unknown) => {
    try {
      run()
    } catch (error) {
      return daemonFallback(error)?.reason ?? String(error)
    }
  }
  expect(refusal(() => new DaemonDiscovery(path.join(root, "w"), layout))).toBe("ancestor")
  expect(refusal(() => windowsDaemonLayout({ root, integrity: { rid: HIGH_INTEGRITY, enableLua: 1 } }))).toBe(
    "integrity",
  )
  expect(refusal(() => windowsDaemonLayout({ root, integrity: { rid: 0x1000, enableLua: 0 } }))).toBe(
    "integrity",
  )
  // A UNC workspace is refused before any directory is made for it.
  expect(refusal(() => new DaemonDiscovery("\\\\localhost\\C$\\Windows", fixture().layout))).toBe("network")
})

native("publish and read retry while another handle denies delete or read sharing", () => {
  let release: (() => void) | undefined
  let pauses = 0
  const f = fixture({
    pause: () => {
      pauses++
      release?.()
      release = undefined
    },
  })
  const owner = f.discovery.claim("owner")!
  try {
    const meta: DaemonMetadata = {
      workspace: f.discovery.workspace,
      socket: f.discovery.socket,
      protocol: 1,
      release: { version: "fixture", buildId: "build", target: "test-native" },
      daemonEpoch: "epoch",
      pid: process.pid,
      processIdentity: windowsProcessIdentity(process.pid)!,
      nonce: "nonce",
      lockIdentity: f.discovery.lockIdentity(),
    }
    f.discovery.publish(meta)
    const hold = (share: number) => {
      const opened = openHandle(f.discovery.metadataFile, GENERIC_READ, share)
      if (opened.error !== undefined) throw new Error(`open ${opened.error}`)
      release = () => closeHandle(opened.handle)
    }
    // FILE_SHARE_READ only: no delete sharing, so the rename over it fails until release.
    hold(1)
    f.discovery.publish({ ...meta, daemonEpoch: "second" })
    expect(pauses).toBe(1)
    // No sharing at all: reading fails until release.
    hold(0)
    expect(f.discovery.read()?.daemonEpoch).toBe("second")
    expect(pauses).toBe(2)
  } finally {
    release?.()
    f.discovery.clearOwnedFiles()
    owner.release()
  }
})

native("the daemon log opens only as a private regular file", () => {
  const f = fixture()
  const check = (file: string) => f.layout.checkPrivate(file, false)
  const log = path.join(f.discovery.directory, "daemon.log")
  closeSync(openDaemonLog(log, check))
  expect(existsSync(log)).toBe(true)
  closeSync(openDaemonLog(log, check))
  rmSync(log)
  // A reparse point in its place is refused, wherever it points.
  const target = path.join(f.root, "elsewhere")
  mkdirSync(target)
  symlinkSync(target, log, "junction")
  expect(() => openDaemonLog(log, check)).toThrow("not private")
  rmSync(log)
})

native(
  "a locked daemon round-trips publish, connect, probe, attach and stop",
  async () => {
    const f = fixture()
    const { platform, daemon } = await startDaemon(f)
    const user = tokenFacts().user
    expect(validPipeName(daemon.metadata.socket)).toBe(true)
    expect(lockedPipeProblem(parseSddl(pipeSddl(daemon.metadata.socket)), user)).toBeUndefined()
    expect(f.discovery.read()).toEqual(daemon.metadata)
    expect(await ensureWorkspaceDaemon({ discovery: f.discovery, platform, release })).toEqual(
      daemon.metadata,
    )
    const pipes = loopback(13)
    const relay = attachWorkspace({ io: pipes.server, discovery: () => f.discovery, platform, release })
    const connection = new RemoteConnection(pipes.client, {
      handshake: { role: "client", hello: { ...hello, workspace: f.cwd } },
    })
    const welcome = await waitForSpawnWork("attach welcome", connection.ready)
    expect(welcome.daemonEpoch).toBe(daemon.metadata.daemonEpoch)
    expect(welcome.workspace).toBe(f.discovery.workspace)
    connection.close()
    await relay
    await stopWorkspace(f.discovery, platform)
    await waitForSpawnWork("daemon stop", daemon.closed)
    expect(f.discovery.read()).toBeUndefined()
  },
  SPAWN_TEST_TIMEOUT_MS,
)

native(
  "a server that cannot prove the nonce is retried as unverified, and the client never answers it",
  async () => {
    const f = fixture()
    const { platform, daemon } = await startDaemon(f)
    // The same pipe and process, but the client holds another nonce: the server's proof cannot match.
    const endpoint = f.discovery.endpoint({ ...daemon.metadata, nonce: "wrong-nonce" })
    const error = await platform.connect(endpoint).catch((e) => e)
    expect(error.name).toBe("DaemonProofError")
    expect(error.code).toBe("disconnected")
    let now = 0
    const clock = Object.assign(Object.create(platform), {
      now: () => now,
      sleep: async () => {
        now += 1000
      },
      connect: () => platform.connect(endpoint),
      spawn: async () => {
        throw new Error("must not spawn while the recorded daemon is alive")
      },
    })
    await expect(
      ensureWorkspaceDaemon({ discovery: f.discovery, platform: clock, release, startupTimeoutMs: 3000 }),
    ).rejects.toThrow("could not be verified")
    await daemon.stop()
  },
  SPAWN_TEST_TIMEOUT_MS,
)

native(
  "handles opened before lockdown force a fresh name and never receive a byte",
  async () => {
    const held: bigint[] = []
    const names: string[] = []
    const f = fixture()
    const { platform, daemon } = await startDaemon(f, {
      beforeLockdown(pipe) {
        names.push(pipe)
        // First name: take every pending instance, as another account racing the window would.
        // Second name: two read-only handles that lockdown does not notice.
        for (let i = 0; i < (names.length === 1 ? 4 : 2); i++) {
          const opened = openHandle(pipe, GENERIC_READ)
          if (opened.error === undefined) held.push(opened.handle)
        }
      },
    })
    try {
      expect(names).toHaveLength(2)
      expect(names[0]).not.toBe(names[1])
      expect(daemon.metadata.socket).toBe(names[1]!)
      expect(lockedPipeProblem(parseSddl(pipeSddl(names[1]!)), tokenFacts().user)).toBeUndefined()
      // A real client completes its proof and probe while the early handles sit there.
      expect(await ensureWorkspaceDaemon({ discovery: f.discovery, platform, release })).toEqual(
        daemon.metadata,
      )
      for (const handle of held) expect(peek(handle)).toBeLessThanOrEqual(0)
      expect(held.slice(4).map(peek)).toEqual([0, 0])
    } finally {
      for (const handle of held) closeHandle(handle)
      await daemon.stop()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

native(
  "a start that stays contended gives up after five names and falls back",
  async () => {
    const held: bigint[] = []
    const f = fixture()
    const platform = new WindowsDaemonPlatform(["unused"], "remote-key", () => f.layout, {
      beforeLockdown(pipe) {
        for (let i = 0; i < 4; i++) {
          const opened = openHandle(pipe, GENERIC_READ)
          if (opened.error === undefined) held.push(opened.handle)
        }
      },
    })
    try {
      const error = await platform.listen(f.discovery.socket, () => {}, "nonce").catch((e) => e)
      expect(daemonFallback(error)?.reason).toBe("start")
      expect(held).toHaveLength(20)
    } finally {
      for (const handle of held) closeHandle(handle)
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

native(
  "only this user's Medium token opens a locked pipe: Low integrity and a deny-only user SID cannot",
  async () => {
    const f = fixture()
    const platform = new WindowsDaemonPlatform(["unused"], "remote-key", () => f.layout)
    const listener = await platform.listen(f.discovery.socket, () => {}, "nonce")
    try {
      const worker = Bun.spawn(
        [process.execPath, path.join(import.meta.dir, "win32-impersonation-worker.ts"), listener.endpoint],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const output = new Response(worker.stdout).text()
      const errors = new Response(worker.stderr).text()
      expect(await waitForSpawnExit(worker, "impersonation worker")).toBe(0)
      expect(await errors).toBe("")
      // ERROR_ACCESS_DENIED for both restricted variants; the plain duplicate opens.
      expect(JSON.parse(await output)).toEqual({ low: 5, restricted: 5, normal: 0 })
    } finally {
      await listener.close()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

const jobTest = jobReason ? test.skip : test
jobTest(
  `a detached daemon spawn writes to the private log and refuses a job that kills its children${jobReason ? ` [skipped: ${jobReason}]` : ""}`,
  async () => {
    const f = fixture()
    const marker = path.join(f.root, "spawned.json")
    const script = path.join(f.root, "fake-daemon.ts")
    writeFileSync(
      script,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2))); console.error("fake daemon log line")`,
    )
    const platform = new WindowsDaemonPlatform([process.execPath, script], "remote-key", () => f.layout)
    await platform.spawn(f.discovery)
    await waitForSpawnCondition("detached fake daemon", () => existsSync(marker))
    await waitForSpawnCondition("fake daemon log", () =>
      readFileSync(path.join(f.discovery.directory, "daemon.log"), "utf8").includes("fake daemon log line"),
    )
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual([
      "daemon",
      "--cwd",
      f.discovery.workspace,
      "--remote-key",
    ])
    const killing = new WindowsDaemonPlatform([process.execPath, script], "remote-key", () => f.layout, {
      jobFlags: () => 0x2000 | 0x800,
    })
    rmSync(marker)
    const error = await killing.spawn(f.discovery).catch((e) => e)
    expect(daemonFallback(error)?.reason).toBe("job")
    expect(existsSync(marker)).toBe(false)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

native("host selection picks the Windows platform and resolves the layout once, on use", () => {
  const host = selectDaemonHost("win32", { command: ["unused"], modelMode: "remote-key" })
  expect(host.platform).toBeInstanceOf(WindowsDaemonPlatform)
  expect(host.layout()).toBe(host.layout())
  expect(host.layout().stableRoot).toBe(path.join(localAppData(), "amira-daemons"))
})

native(
  "an owner lock whose PID now runs another process, or no process, is recovered",
  async () => {
    const f = fixture()
    const lock = path.join(f.discovery.ownershipDirectory, "owner.lock")
    const record = (pid: number, start: string | undefined) => {
      const nonce = crypto.randomUUID()
      const owner = { v: 2, pid, nonce, createdAt: Date.now(), ...f.layout.leasePolicy!.domain, start }
      const { platform: _, legacyHost: __, ...fields } = owner
      writeFileSync(lock, `${pid}\n${nonce}\n${JSON.stringify(fields)}\n`)
    }
    // A live PID (this process) with another start time: a crashed holder whose PID was reused.
    record(process.pid, "w:1")
    expect(f.discovery.canStart()).toBe(true)
    record(process.pid, windowsProcessIdentity(process.pid))
    expect(f.discovery.canStart()).toBe(false)
    // A holder that has exited, as after TerminateProcess.
    const child = Bun.spawn(["cmd.exe", "/d", "/c", "exit 0"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    const start = windowsProcessIdentity(child.pid)
    await waitForSpawnExit(child, "short child")
    record(child.pid, start ?? "w:2")
    expect(f.discovery.canStart()).toBe(true)
    const owner = f.discovery.claim("owner")
    expect(owner).toBeDefined()
    expect(readFileSync(lock, "utf8")).toContain(`"start":"${windowsProcessIdentity(process.pid)}"`)
    owner!.release()
  },
  SPAWN_TEST_TIMEOUT_MS,
)
