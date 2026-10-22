import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SPAWN_TEST_TIMEOUT_MS, waitForSpawnWork } from "../../../scripts/spawn-test.ts"
import { isProcessAlive, SessionWriteGuardError } from "../src/file-lock.ts"
import { windowsHostIdentity } from "../src/file-lock-domain.ts"
import { leaseOwner } from "../src/file-lock-owner.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"
import { waitForFileLockCondition, waitForFileLockWorkerExit } from "./file-lock-test-waits.ts"

const dirs: string[] = []
const workers: { child: Bun.Subprocess<"ignore", "ignore", "pipe">; dir: string }[] = []
afterEach(async () => {
  try {
    for (const worker of workers) fs.writeFileSync(path.join(worker.dir, "stop"), "stop")
    const stopped = await Promise.allSettled(
      workers.splice(0).map(async ({ child }) => {
        try {
          expect(await waitForFileLockWorkerExit(child, "identity worker cleanup")).toBe(0)
          expect(await waitForSpawnWork("identity stderr", new Response(child.stderr).text())).toBe("")
        } finally {
          if (child.exitCode === null) {
            child.kill()
            await waitForFileLockWorkerExit(child, "identity worker forced cleanup")
          }
        }
      }),
    )
    for (const result of stopped) if (result.status === "rejected") throw result.reason
  } finally {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  }
}, SPAWN_TEST_TIMEOUT_MS)
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-lease-identity-"))
  dirs.push(dir)
  return dir
}

function adapters(physical = "00:11:22:33:44:55", virtual?: string): ReturnType<typeof os.networkInterfaces> {
  const info = (mac: string): os.NetworkInterfaceInfo => ({
    address: "192.0.2.1",
    netmask: "255.255.255.0",
    family: "IPv4",
    mac,
    internal: false,
    cidr: "192.0.2.1/24",
  })
  return { Ethernet: [info(physical)], ...(virtual ? { VPN: [info(virtual)] } : {}) }
}
function windowsDomain(interfaces: ReturnType<typeof os.networkInterfaces>) {
  const { host, legacyHost } = windowsHostIdentity("same-hostname", interfaces)
  return { platform: "win32", host, legacyHost, boot: null, pidNamespace: null }
}
function fixture() {
  const dir = temp()
  const file = path.join(dir, "session.lock")
  const start = async (domain: object, absentPid?: number, crash = false) => {
    const marker = path.join(dir, String(workers.length))
    fs.mkdirSync(marker)
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        path.join(import.meta.dir, "file-lock-worker-preload.ts"),
        path.join(import.meta.dir, "file-lock-clone-worker.ts"),
        file,
        marker,
        JSON.stringify(domain),
        String(absentPid ?? 0),
        crash ? "crash" : "hold",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe", windowsHide: true },
    )
    workers.push({ child, dir: marker })
    await waitForFileLockCondition(`identity worker ${child.pid} result`, () => {
      if (fs.existsSync(path.join(marker, "result"))) return true
      if (child.exitCode !== null) throw new Error(`identity worker exited: ${child.exitCode}`)
      return false
    })
    if (crash) expect(await waitForFileLockWorkerExit(child, "crashed lease owner")).toBe(0)
    const result: { state: string; owner: ReturnType<typeof leaseOwner>; probes: number } = JSON.parse(
      fs.readFileSync(path.join(marker, "result"), "utf8"),
    )
    return { ...result, child }
  }
  return { file, start }
}

test(
  "two live Linux clones with the same host identity cannot both acquire",
  async () => {
    const f = fixture()
    const common = { platform: "linux", host: "cloned-host", pidNamespace: "pid:[same-inode]" }
    const first = await f.start({ ...common, boot: "boot-a" })
    expect(first.state).toBe("acquired")
    const original = fs.readFileSync(f.file, "utf8")
    const second = await f.start({ ...common, boot: "boot-b" }, first.child.pid)
    expect(second.state).toBe("blocked")
    expect(second.probes).toBe(0)
    expect(isProcessAlive(first.child.pid) && isProcessAlive(second.child.pid)).toBe(true)
    expect(fs.readFileSync(f.file, "utf8")).toBe(original)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "different Windows boot GUIDs never prove a live clone dead, even with shared installation identity",
  async () => {
    const f = fixture()
    const common = {
      platform: "win32",
      host: "shared-installation-hash",
      pidNamespace: null,
      machineGuid: "12345678-1234-4abc-8def-123456789abc",
    }
    const first = await f.start({ ...common, boot: `windows:${"11".repeat(16)}` })
    expect(first.state).toBe("acquired")
    const original = fs.readFileSync(f.file, "utf8")
    const second = await f.start({ ...common, boot: `windows:${"22".repeat(16)}` }, first.child.pid)
    expect(second.state).toBe("blocked")
    expect(second.probes).toBe(0)
    expect(isProcessAlive(first.child.pid) && isProcessAlive(second.child.pid)).toBe(true)
    expect(fs.readFileSync(f.file, "utf8")).toBe(original)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "two live Windows clones with distinct hardware MACs never both acquire",
  async () => {
    const f = fixture()
    const firstDomain = windowsDomain(adapters("00:11:22:33:44:55", "02:aa:bb:cc:dd:ee"))
    const secondDomain = windowsDomain(adapters("00:66:77:88:99:aa", "02:aa:bb:cc:dd:ee"))
    const first = await f.start(firstDomain)
    expect(first.state).toBe("acquired")
    const original = fs.readFileSync(f.file, "utf8")
    const second = await f.start(secondDomain, first.child.pid)
    expect(second.state).toBe("blocked")
    expect(firstDomain.host).not.toBe(secondDomain.host)
    expect(second.probes).toBe(0)
    expect(isProcessAlive(first.child.pid) && isProcessAlive(second.child.pid)).toBe(true)
    expect(fs.readFileSync(f.file, "utf8")).toBe(original)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.each([false, true])(
  "dead-PID recovery survives adding/removing a virtual adapter (initially present: %s)",
  async (present) => {
    const f = fixture()
    const without = windowsDomain(adapters())
    const withVirtual = windowsDomain(adapters(undefined, "02:aa:bb:cc:dd:ee"))
    const first = await f.start(present ? withVirtual : without, undefined, true)
    expect(first.state).toBe("acquired")
    expect(isProcessAlive(first.child.pid)).toBe(false)
    expect(without.host).toBe(withVirtual.host)
    const second = await f.start(present ? without : withVirtual, first.child.pid)
    expect(second.state).toBe("acquired")
    expect(second.probes).toBe(1)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a dead legacy full-MAC-hash lease is accepted only when the current full set matches",
  async () => {
    const f = fixture()
    const domain = windowsDomain(adapters(undefined, "02:aa:bb:cc:dd:ee"))
    expect(domain.host).not.toBe(domain.legacyHost)
    const first = await f.start({ ...domain, host: domain.legacyHost }, undefined, true)
    expect(first.state).toBe("acquired")
    const second = await f.start(domain, first.child.pid)
    expect(second.state).toBe("acquired")
    expect(second.probes).toBe(1)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "a legacy full-MAC lease stays protected when neither current hash matches",
  async () => {
    const f = fixture()
    const before = windowsDomain(adapters(undefined, "02:aa:bb:cc:dd:ee"))
    const after = windowsDomain(adapters(undefined, "06:aa:bb:cc:dd:ee"))
    const first = await f.start({ ...before, host: before.legacyHost }, undefined, true)
    expect(first.state).toBe("acquired")
    const original = fs.readFileSync(f.file, "utf8")
    const second = await f.start(after, first.child.pid)
    expect(second.state).toBe("blocked")
    expect(second.probes).toBe(0)
    expect(fs.readFileSync(f.file, "utf8")).toBe(original)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(process.platform === "win32")(
  "incident legacy host mismatch stays protected with actionable diagnostics",
  () => {
    const dir = temp()
    const store = SessionStore.create({ cwd: dir, dir })
    const file = sessionLockFile(store.file)
    const record = {
      ...leaseOwner(),
      pid: 17768,
      createdAt: 1792603509188,
      host: `2a8e30${"0".repeat(58)}`,
      boot: null,
      pidNamespace: null,
    }
    const contents = `${record.pid}\n${record.nonce}\n${JSON.stringify(record)}\n`
    fs.writeFileSync(file, contents)
    let error: unknown
    try {
      store.claim()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(SessionWriteGuardError)
    expect((error as Error).message).toContain("host identity mismatch")
    expect((error as Error).message).toContain("verify the originating hostname and hardware MACs")
    expect((error as Error).message).toContain("no Amira process is running on any host")
    expect((error as Error).message).toContain("each sharing host's OS process list")
    expect((error as Error).message).toContain(file)
    expect(fs.readFileSync(file, "utf8")).toBe(contents)
  },
)
