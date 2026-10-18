import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import path from "node:path"
import { tryFileLock } from "@amira/core"
import { cleanupInstall } from "../src/update/files.ts"
import { createUpdater } from "../src/update/index.ts"
import { type InstallRecord, readInstall } from "../src/update/install.ts"
import { RETENTION_GATE } from "../src/update/retention-gate.ts"
import { createVersionLease, liveVersionLeases } from "../src/update/version-leases.ts"
import { startBackgroundUpdate } from "../src/update-background.ts"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "amira-retention-"))
  directories.push(root)
  const bin = path.join(root, "bin", "amira.exe")
  await mkdir(path.dirname(bin))
  for (const version of ["1.2.0", "1.2.1", "1.2.2", "1.2.3", "1.2.4"]) {
    await mkdir(path.join(root, "versions", version), { recursive: true })
    await writeFile(path.join(root, "versions", version, "amira.exe"), version)
  }
  const record: InstallRecord = {
    kind: "single-file",
    version: "1.2.4",
    previousVersion: "1.2.3",
    channel: "stable",
    target: "bun-windows-x64-baseline",
    bin,
  }
  await writeFile(bin, record.version)
  await writeFile(path.join(root, "install.json"), JSON.stringify(record))
  return { root, bin, record }
}

test("cleanup protects an older running executable independently of the install marker", async () => {
  const f = await fixture()
  await cleanupInstall(f.root, f.bin, f.record, ["1.2.0"])
  expect(await readdir(path.join(f.root, "versions"))).toContain("1.2.0")
})

test("cleanup protects a version used by another live process lease", async () => {
  const f = await fixture()
  const directory = path.join(f.root, "leases", "1.2.0")
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, "session.lease"),
    `amira-version-lease-v1\n${hostname().toLowerCase()}\n${process.pid}\n1.2.0\n`,
  )
  await cleanupInstall(f.root, f.bin, f.record)
  expect(await readdir(path.join(f.root, "versions"))).toContain("1.2.0")
})

test.each(["updater", "installer"] as const)(
  "lease publication cannot pass a paused %s cleanup scan",
  async (writer) => {
    const f = await fixture()
    const file = path.join(f.root, RETENTION_GATE)
    const lock = writer === "updater" ? tryFileLock(file, 600_000, undefined, true)! : undefined
    if (writer === "installer") await writeFile(file, `${process.pid}\n`)
    try {
      // Updaters and installers hold the same short gate across scan and deletion.
      expect((await liveVersionLeases(f.root))?.size).toBe(0)
      await expect(createVersionLease(f.root, "1.2.0")).rejects.toThrow("retention is busy")
      await rm(path.join(f.root, "versions", "1.2.0"), { recursive: true })
      expect(await readdir(path.join(f.root, "versions"))).not.toContain("1.2.0")
    } finally {
      if (lock) lock.release()
      else await rm(file)
    }
    // Once pruning finishes, a deleted executable cannot be accepted as a protected session.
    await expect(createVersionLease(f.root, "1.2.0")).rejects.toThrow()
    const older = createUpdater({
      installRoot: f.root,
      bin: f.bin,
      platform: "win32",
      target: f.record.target,
      version: "1.2.0",
      executable: path.join(f.root, "versions", "1.2.0", "amira.exe"),
      env: {},
    })
    const startup = await startBackgroundUpdate({}, { updater: older, checks: false })
    await startup.finished
    expect((await liveVersionLeases(f.root))?.has("1.2.0")).not.toBe(true)
    await startup.stop()
  },
)

test.each([false, true])(
  "an aliased managed root protects physical paths without blocking startup for deleted images (%s)",
  async (deleted) => {
    const f = await fixture()
    const alias = path.join(f.root, "alias")
    await symlink(f.root, alias, process.platform === "win32" ? "junction" : "dir")
    const bin = path.join(alias, "bin", "amira.exe")
    await writeFile(path.join(f.root, "install.json"), JSON.stringify({ ...f.record, bin }))
    const options = {
      installRoot: alias,
      bin,
      platform: "win32" as const,
      target: f.record.target,
      version: "1.2.0",
      executable: deleted ? path.join(alias, "versions", "1.2.0", "amira.exe") : f.bin,
      env: {},
    }
    const older = createUpdater(options)
    if (deleted) {
      await rm(path.join(f.root, "versions", "1.2.0"), { recursive: true })
      await expect(older.pinVersion()).rejects.toThrow()
      const startup = await startBackgroundUpdate({}, { updater: older, checks: false })
      await startup.finished
      await startup.stop()
    } else {
      expect((await readInstall(options)).version).toBe("1.2.4")
      const startup = await startBackgroundUpdate({}, { updater: older, checks: false })
      expect((await liveVersionLeases(f.root))?.has("1.2.0")).toBe(true)
      await cleanupInstall(f.root, f.bin, f.record)
      expect(await readdir(path.join(f.root, "versions"))).toContain("1.2.0")
      await startup.stop()
    }
    await older.stop()
  },
)

test("brief retention contention retries publication instead of abandoning protection", async () => {
  const f = await fixture()
  const lock = tryFileLock(path.join(f.root, RETENTION_GATE), 600_000, undefined, true)!
  let accepted = false
  const pending = createVersionLease(f.root, "1.2.0").then((lease) => {
    accepted = true
    return lease
  })
  await Bun.sleep(0)
  expect(accepted).toBe(false)
  lock.release()
  const lease = await pending
  await cleanupInstall(f.root, f.bin, f.record)
  expect(await readdir(path.join(f.root, "versions"))).toContain("1.2.0")
  await lease.release()
})

test("retention retry exhaustion is best effort for startup and can be retried later", async () => {
  const f = await fixture()
  const updater = createUpdater({
    installRoot: f.root,
    bin: f.bin,
    platform: "win32",
    target: f.record.target,
    version: "1.2.0",
    executable: path.join(f.root, "versions", "1.2.0", "amira.exe"),
    publicKey: "",
    env: {},
  })
  const lock = tryFileLock(path.join(f.root, RETENTION_GATE), 600_000, undefined, true)!
  let startup: Awaited<ReturnType<typeof startBackgroundUpdate>>
  try {
    startup = await startBackgroundUpdate({}, { updater })
    await startup.finished
    expect(await readdir(path.join(f.root, "versions"))).toHaveLength(5)
  } finally {
    lock.release()
  }
  await updater.pinVersion()
  expect((await liveVersionLeases(f.root))?.has("1.2.0")).toBe(true)
  await startup.stop()
})

test("live leases are additional to three retained versions and disappear after release", async () => {
  const f = await fixture()
  const leases = [await createVersionLease(f.root, "1.2.0"), await createVersionLease(f.root, "1.2.1")]
  await cleanupInstall(f.root, f.bin, f.record)
  expect(await readdir(path.join(f.root, "versions"))).toHaveLength(5)
  await Promise.all(leases.map((lease) => lease.release()))
  await cleanupInstall(f.root, f.bin, f.record)
  expect(await readdir(path.join(f.root, "versions"))).toEqual(["1.2.2", "1.2.3", "1.2.4"])
})

test("dead local leases are pruned but unknown liveness, foreign owners and malformed leases are retained", async () => {
  for (const kind of ["dead", "unknown", "foreign", "malformed"] as const) {
    const f = await fixture()
    await createVersionLease(f.root, "1.2.0", { host: kind === "foreign" ? "foreign-host" : hostname() })
    if (kind === "malformed") {
      const directory = path.join(f.root, "leases", "1.2.0")
      await writeFile(path.join(directory, (await readdir(directory))[0]!), "unrecognized lease")
    }
    await cleanupInstall(f.root, f.bin, f.record, [], {
      liveness: () => (kind === "unknown" ? "unknown" : "dead"),
    })
    expect((await readdir(path.join(f.root, "versions"))).includes("1.2.0")).toBe(kind !== "dead")
  }
})

test("unreadable or unexpected lease layouts fail closed", async () => {
  const f = await fixture()
  await writeFile(path.join(f.root, "leases"), "not a lease directory")
  await cleanupInstall(f.root, f.bin, f.record)
  expect(await readdir(path.join(f.root, "versions"))).toHaveLength(5)
  await rm(path.join(f.root, "leases"))
  await mkdir(path.join(f.root, "leases"))
  await writeFile(path.join(f.root, "leases", "unknown"), "unrecognized layout")
  await cleanupInstall(f.root, f.bin, f.record)
  expect(await readdir(path.join(f.root, "versions"))).toHaveLength(5)
})

test("lease liveness errors retain the executable", async () => {
  const f = await fixture()
  await createVersionLease(f.root, "1.2.0")
  const held = await liveVersionLeases(f.root, {
    liveness: () => {
      throw new Error("permission denied")
    },
  })
  expect(held?.has("1.2.0")).toBe(true)
})

test("leases pin the loaded version even when automatic updates, networking and signing are disabled", async () => {
  const f = await fixture()
  const older = createUpdater({
    installRoot: f.root,
    bin: f.bin,
    platform: "win32",
    target: f.record.target,
    version: "1.2.0",
    executable: path.join(f.root, "versions", "1.2.0", "amira.exe"),
    publicKey: "",
    env: { AMIRA_DISABLE_UPDATES: "1", AMIRA_DISABLE_AUTOUPDATE: "1", AMIRA_OFFLINE: "1" },
  })
  const startup = await startBackgroundUpdate({}, { updater: older, checks: false })
  await startup.finished
  await older.pinVersion()
  expect(await readdir(path.join(f.root, "leases", "1.2.0"))).toHaveLength(1)
  const current = createUpdater({
    installRoot: f.root,
    bin: f.bin,
    platform: "win32",
    target: f.record.target,
    version: f.record.version,
    executable: f.bin,
    publicKey: "",
    env: {},
  })
  await current.cleanup()
  expect(await readFile(path.join(f.root, "versions", "1.2.0", "amira.exe"), "utf8")).toBe("1.2.0")
  await startup.stop()
  await current.cleanup()
  expect(await readdir(path.join(f.root, "versions"))).toEqual(["1.2.2", "1.2.3", "1.2.4"])
  await current.stop()
})

test("lease establishment failure prevents this updater from pruning", async () => {
  const f = await fixture()
  await writeFile(path.join(f.root, "leases"), "unusable")
  const updater = createUpdater({
    installRoot: f.root,
    bin: f.bin,
    platform: "win32",
    target: f.record.target,
    version: "1.2.0",
    executable: path.join(f.root, "versions", "1.2.0", "amira.exe"),
    publicKey: "",
    env: {},
  })
  await expect(updater.cleanup()).rejects.toThrow()
  expect(await readdir(path.join(f.root, "versions"))).toHaveLength(5)
  await updater.stop()
})

test("source and package-manager processes never create install leases", async () => {
  const f = await fixture()
  for (const executable of ["/usr/bin/bun", "/usr/lib/node_modules/amira-linux-x64/bin/amira"]) {
    const updater = createUpdater({
      installRoot: f.root,
      bin: f.bin,
      target: f.record.target,
      version: "1.2.0",
      executable,
    })
    await updater.pinVersion()
    await updater.stop()
  }
  await expect(readdir(path.join(f.root, "leases"))).rejects.toThrow()
})
