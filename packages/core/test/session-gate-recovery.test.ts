import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isProcessAlive } from "../src/file-lock.ts"
import { deleteSession } from "../src/session-list.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"
import { waitForFileLockCondition, waitForFileLockWorkerExit } from "./file-lock-test-waits.ts"

let dir: string
let origin: SessionStore
const workers: ReturnType<typeof startWorker>[] = []
// Four Windows spawns can each stall for 4-10s; setup is hang-protected, not timed work.
const RECOVERY_STARTUP_TIMEOUT_MS = 60_000
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-session-gate-"))
  origin = SessionStore.create({ cwd: dir, dir })
  origin.appendDisplay({ type: "display", level: "info", text: "original" })
})
afterEach(async () => {
  for (const worker of workers.splice(0)) await killWorker(worker)
  origin.release()
  fs.rmSync(dir, { recursive: true, force: true })
}, 150_000)

function startWorker(mode: string): Bun.Subprocess<"ignore", "ignore", "pipe"> {
  const worker = Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.join(import.meta.dir, "file-lock-worker-preload.ts"),
      path.join(import.meta.dir, "file-lock-worker.ts"),
      sessionLockFile(origin.file),
      dir,
      mode,
    ],
    {
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
      ),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  workers.push(worker)
  return worker
}
async function waitFor(
  worker: ReturnType<typeof startWorker>,
  marker: string,
  present = true,
  deadline = Date.now() + 30_000,
) {
  await waitForFileLockCondition(
    `gate worker ${worker.pid}: ${path.join(dir, marker)} ${present ? "present" : "absent"}`,
    () => {
      if (fs.existsSync(path.join(dir, marker)) === present) return true
      if (worker.exitCode !== null)
        throw new Error(`gate worker ${worker.pid} exited (${worker.exitCode}) before ${marker}`)
      return false
    },
    Math.max(0, deadline - Date.now()),
  ).catch(async (error) => {
    if (worker.exitCode !== null)
      throw new Error(`${error.message}: ${await new Response(worker.stderr).text()}`)
    throw error
  })
}
async function killWorker(worker: ReturnType<typeof startWorker>) {
  if (worker.exitCode === null) worker.kill()
  await waitForFileLockWorkerExit(worker, "gate worker cleanup")
}
async function exitBefore(worker: ReturnType<typeof startWorker>, deadline: number) {
  return waitForFileLockWorkerExit(worker, "gate worker operation", Math.max(0, deadline - Date.now()))
}
async function abandonedGate(mode: string, deadline = Date.now() + 30_000) {
  const worker = startWorker(mode)
  if (mode === "session-pause-gate-release" || mode === "session-pause-gate-retire") {
    await waitFor(worker, "acquired", true, deadline)
    fs.writeFileSync(path.join(dir, "release"), "go")
  }
  await waitFor(worker, "paused", true, deadline)
  expect(fs.existsSync(`${sessionLockFile(origin.file)}.lease-gate`)).toBe(
    mode !== "session-pause-gate-init" && mode !== "session-pause-gate-retire",
  )
  await killWorker(worker)
  expect(isProcessAlive(worker.pid)).toBe(false)
  return worker
}

for (const mode of [
  "session-pause-gate-create",
  "session-pause-gate-release",
  "session-pause-gate-init",
  "session-pause-gate-retire",
]) {
  test(`SessionStore recovers exact killed child inside ${mode}`, async () => {
    const worker = await abandonedGate(mode)
    const file = sessionLockFile(origin.file)
    const gate = `${file}.lease-gate`
    const expected = [path.basename(origin.file), "paused"]
    if (mode === "session-pause-gate-release" || mode === "session-pause-gate-retire")
      expected.push("acquired", "release")
    if (fs.existsSync(gate)) {
      const owner = JSON.parse(fs.readFileSync(path.join(gate, "owner.json"), "utf8"))
      expect(owner.pid).toBe(worker.pid)
      expect(fs.readdirSync(dir).sort()).toEqual(
        [
          ...expected,
          path.basename(gate),
          ...(mode === "session-pause-gate-release" ? [path.basename(file)] : []),
        ].sort(),
      )
      expected.push(`${path.basename(gate)}.dead-${owner.nonce}`)
    } else {
      const prefix = `${path.basename(gate)}.${mode === "session-pause-gate-init" ? "pending" : "retired"}-${worker.pid}-`
      const privatePath = fs.readdirSync(dir).find((name) => name.startsWith(prefix))
      expect(privatePath).toBeDefined()
      // Exact list: an unknown file is a failure, not silently excluded from comparison.
      expect(fs.readdirSync(dir).sort()).toEqual([...expected, privatePath!].sort())
      expect(fs.readdirSync(path.join(dir, privatePath!))).toEqual(
        mode === "session-pause-gate-init" ? [] : ["owner.json"],
      )
      expected.push(privatePath!)
    }
    expect(origin.claim()).toBe(true)
    origin.append({ type: "custom", ext: "gate-test", data: "recovered" })
    expect(
      SessionStore.open(origin.file).entries.map((entry) =>
        entry.type === "custom" ? entry.data : entry.type === "display" ? entry.text : null,
      ),
    ).toEqual(["original", "recovered"])
    origin.release()
    expect(fs.existsSync(`${sessionLockFile(origin.file)}.lease-gate`)).toBe(false)
    expect(fs.existsSync(sessionLockFile(origin.file))).toBe(false)
    expect(fs.readdirSync(dir).sort()).toEqual(expected.sort())
  }, 210_000)
}

test("live gate blocks with an accurate stale-write-guard path and safe manual recovery guidance", async () => {
  const worker = startWorker("session-pause-gate-create")
  await waitFor(worker, "paused")
  const gate = `${sessionLockFile(origin.file)}.lease-gate`
  let error: unknown
  try {
    origin.claim()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe(
    `session stale-write guard is busy or unverifiable: ${gate}; retry, or remove this directory manually only after confirming no Amira process is running on any host using these session files`,
  )
  expect((error as Error).message).toContain(gate)
  expect((error as Error).message).toContain("confirming no Amira process is running")
  expect((error as Error).message).not.toContain("open in another Amira process")
  expect(SessionStore.open(origin.file).entries).toHaveLength(1)
  expect(isProcessAlive(worker.pid)).toBe(true)
  fs.writeFileSync(path.join(dir, "continue"), "go")
  await waitFor(worker, "acquired")
  fs.writeFileSync(path.join(dir, "release"), "go")
  expect(await waitForFileLockWorkerExit(worker, "gate worker operation")).toBe(0)
  expect(await new Response(worker.stderr).text()).toBe("")
}, 210_000)

for (const fault of [undefined, "EPERM", "EBUSY", "EACCES"]) {
  test(`cross-process simultaneous dead-gate recoverers grant exactly one lease and preserve its live authority (${fault ?? "real OS"})`, async () => {
    await abandonedGate("session-pause-gate-create", Date.now() + RECOVERY_STARTUP_TIMEOUT_MS)
    fs.rmSync(path.join(dir, "paused"))
    const disk = fs.readFileSync(origin.file)
    const mode = fault ? `session-contend-recover-${fault}` : "session-contend-recover"
    const startupDeadline = Date.now() + RECOVERY_STARTUP_TIMEOUT_MS
    const contenders = Array.from({ length: 4 }, () => startWorker(mode))
    await Promise.all(
      contenders.map((worker) => waitFor(worker, `ready-${worker.pid}`, true, startupDeadline)),
    )
    fs.writeFileSync(path.join(dir, "contend"), "go")
    await Promise.all(
      contenders.map((worker) => waitFor(worker, `recovery-ready-${worker.pid}`, true, startupDeadline)),
    )
    // The rendezvous must not consume the real two-second sharing-error retry budget.
    if (fault) await Bun.sleep(2500)
    // Start the operation watchdog only after every recoverer has reached the barrier.
    const operationDeadline = Date.now() + 6000
    fs.writeFileSync(path.join(dir, "recover"), "go")
    await Promise.all(
      contenders.map((worker) => waitFor(worker, `result-${worker.pid}`, true, operationDeadline)),
    )
    const winners = contenders.filter((worker) => {
      const result = JSON.parse(fs.readFileSync(path.join(dir, `result-${worker.pid}`), "utf8"))
      if (!result.held) expect(result.error).toMatch(/stale-write guard|open in another Amira process/)
      return result.held
    })
    expect(winners).toHaveLength(1)
    if (fault) expect(fs.readdirSync(dir).some((name) => name.startsWith("sharing-"))).toBe(true)
    // A result is not a quiescence barrier: losers may still be finalizing their
    // short-lived gates. Finish them and the winner's gate before probing its lease.
    for (const worker of contenders.filter((worker) => worker !== winners[0]))
      expect(await exitBefore(worker, operationDeadline)).toBe(0)
    await waitFor(
      winners[0]!,
      path.basename(`${sessionLockFile(origin.file)}.lease-gate`),
      false,
      operationDeadline,
    )
    expect(fs.readFileSync(origin.file)).toEqual(disk)
    expect(isProcessAlive(winners[0]!.pid)).toBe(true)
    const contents = fs.readFileSync(sessionLockFile(origin.file), "utf8")
    expect(Number.parseInt(contents, 10)).toBe(winners[0]!.pid)
    expect(() => origin.claim()).toThrow("open in another Amira process")
    expect(fs.readFileSync(sessionLockFile(origin.file), "utf8")).toBe(contents)
    fs.writeFileSync(path.join(dir, "release"), "go")
    for (const worker of contenders) {
      expect(await exitBefore(worker, operationDeadline)).toBe(0)
      expect(await new Response(worker.stderr).text()).toBe("")
    }
    expect(origin.claim()).toBe(true)
  }, 130_000)
}

for (const barrier of ["session-pause-gate-proof", "session-pause-gate-recheck"]) {
  for (const laterWriter of [false, true]) {
    test(`delayed ${barrier} loses without mutating ${laterWriter ? "a newer" : "the replacement"} writer's gate`, async () => {
      await abandonedGate("session-pause-gate-create")
      fs.rmSync(path.join(dir, "paused"))
      const file = sessionLockFile(origin.file)
      const gate = `${file}.lease-gate`
      const disk = fs.readFileSync(origin.file)
      const deadOwner = fs.readFileSync(path.join(gate, "owner.json"), "utf8")
      const nonce = JSON.parse(deadOwner).nonce
      const tombstone = `${gate}.dead-${nonce}`
      const delayed = startWorker(barrier)
      await waitFor(delayed, "paused-proof")
      let writer = startWorker("session-pause-gate-create")
      await waitFor(writer, "paused")
      if (laterWriter) {
        fs.writeFileSync(path.join(dir, "continue"), "go")
        await waitFor(writer, "acquired")
        const lease = fs.readFileSync(file, "utf8")
        expect(Number.parseInt(lease, 10)).toBe(writer.pid)
        fs.writeFileSync(path.join(dir, "release"), "go")
        expect(await waitForFileLockWorkerExit(writer, "gate writer operation")).toBe(0)
        expect(await new Response(writer.stderr).text()).toBe("")
        // Below, verify that ordinary release retained the old nonce fence.
        for (const marker of ["paused", "continue", "acquired", "release"]) fs.rmSync(path.join(dir, marker))
        writer = startWorker("session-pause-gate-create")
        await waitFor(writer, "paused")
      }
      const replacement = fs.readFileSync(path.join(gate, "owner.json"), "utf8")
      expect(JSON.parse(replacement).pid).toBe(writer.pid)
      expect(fs.existsSync(file)).toBe(false)
      fs.writeFileSync(path.join(dir, "continue-proof"), "go")
      await waitFor(delayed, `result-${delayed.pid}`)
      const result = JSON.parse(fs.readFileSync(path.join(dir, `result-${delayed.pid}`), "utf8"))
      expect(result.held).toBe(false)
      expect(result.error).toContain("stale-write guard")
      expect(await waitForFileLockWorkerExit(delayed, "delayed gate worker operation")).toBe(0)
      expect(await new Response(delayed.stderr).text()).toBe("")
      expect(fs.readFileSync(path.join(gate, "owner.json"), "utf8")).toBe(replacement)
      expect(fs.readFileSync(path.join(tombstone, "owner.json"), "utf8")).toBe(deadOwner)
      expect(fs.existsSync(file)).toBe(false)
      expect(fs.readFileSync(origin.file)).toEqual(disk)
      fs.writeFileSync(path.join(dir, "continue"), "go")
      await waitFor(writer, "acquired")
      const liveLease = fs.readFileSync(file, "utf8")
      expect(Number.parseInt(liveLease, 10)).toBe(writer.pid)
      expect(() => origin.claim()).toThrow("open in another Amira process")
      expect(fs.readFileSync(file, "utf8")).toBe(liveLease)
      fs.writeFileSync(path.join(dir, "release"), "go")
      expect(await waitForFileLockWorkerExit(writer, "gate writer operation")).toBe(0)
      expect(await new Response(writer.stderr).text()).toBe("")
      expect(origin.claim()).toBe(true)
    }, 210_000)
  }
}

test("a killed reclaimer after deterministic retirement leaves a nonempty fence and no authority gap", async () => {
  await abandonedGate("session-pause-gate-create")
  const file = sessionLockFile(origin.file)
  const gate = `${file}.lease-gate`
  const contents = fs.readFileSync(path.join(gate, "owner.json"), "utf8")
  const nonce = JSON.parse(contents).nonce
  const tombstone = `${gate}.dead-${nonce}`
  const disk = fs.readFileSync(origin.file)
  const worker = startWorker("session-pause-gate-recovery-retire")
  await waitFor(worker, "paused-recovery")
  expect(fs.existsSync(gate)).toBe(false)
  expect(fs.readdirSync(tombstone)).toEqual(["owner.json"])
  expect(fs.readFileSync(path.join(tombstone, "owner.json"), "utf8")).toBe(contents)
  await killWorker(worker)
  expect(isProcessAlive(worker.pid)).toBe(false)
  expect(origin.claim()).toBe(true)
  expect(fs.readFileSync(origin.file)).toEqual(disk)
  origin.release()
  expect(fs.existsSync(file)).toBe(false)
  expect(fs.existsSync(gate)).toBe(false)
  expect(fs.readFileSync(path.join(tombstone, "owner.json"), "utf8")).toBe(contents)
}, 210_000)

test("a killed cross-process gate reclaimer does not abandon another recovery mutex", async () => {
  await abandonedGate("session-pause-gate-create")
  const worker = startWorker("session-pause-gate-proof")
  await waitFor(worker, "paused-proof")
  await killWorker(worker)
  expect(isProcessAlive(worker.pid)).toBe(false)
  expect(origin.claim()).toBe(true)
}, 210_000)

test("a failed OS process probe is not proof to remove a dead-looking same-host gate", async () => {
  const worker = await abandonedGate("session-pause-gate-create")
  const gate = `${sessionLockFile(origin.file)}.lease-gate`
  const contents = fs.readFileSync(path.join(gate, "owner.json"), "utf8")
  const probe = spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("probe unavailable"), { code: "EACCES" })
  })
  try {
    expect(() => origin.claim()).toThrow("stale-write guard")
    expect(probe).toHaveBeenCalledWith(worker.pid, 0)
    expect(fs.readFileSync(path.join(gate, "owner.json"), "utf8")).toBe(contents)
  } finally {
    probe.mockRestore()
  }
  expect(origin.claim()).toBe(true)
}, 210_000)

for (const corruption of [
  "foreign",
  "missing-host",
  "foreign-boot",
  "missing-boot",
  "foreign-pid-namespace",
  "missing-pid-namespace",
  "legacy-version",
  "live-owner-record",
  "unknown",
  "empty-directory",
]) {
  test(`SessionStore fails closed for ${corruption} gate identity even with a dead pid and old mtime`, async () => {
    await abandonedGate("session-pause-gate-create")
    const gate = `${sessionLockFile(origin.file)}.lease-gate`
    const metadata = path.join(gate, "owner.json")
    const owner = JSON.parse(fs.readFileSync(metadata, "utf8"))
    expect(owner.pid).toBe(workers[0]!.pid)
    expect(typeof owner.nonce).toBe("string")
    expect(owner.createdAt).toBeGreaterThan(0)
    expect(typeof owner.host).toBe("string")
    if (corruption === "foreign")
      fs.writeFileSync(metadata, JSON.stringify({ ...owner, host: "another-host" }))
    else if (corruption === "missing-host")
      fs.writeFileSync(metadata, JSON.stringify({ ...owner, host: null }))
    else if (corruption === "foreign-boot")
      fs.writeFileSync(metadata, JSON.stringify({ ...owner, boot: "another-boot" }))
    else if (corruption === "missing-boot") {
      delete owner.boot
      fs.writeFileSync(metadata, JSON.stringify(owner))
    } else if (corruption === "foreign-pid-namespace")
      fs.writeFileSync(metadata, JSON.stringify({ ...owner, pidNamespace: "another-namespace" }))
    else if (corruption === "missing-pid-namespace") {
      delete owner.pidNamespace
      fs.writeFileSync(metadata, JSON.stringify(owner))
    } else if (corruption === "legacy-version") fs.writeFileSync(metadata, JSON.stringify({ ...owner, v: 1 }))
    else if (corruption === "live-owner-record")
      fs.writeFileSync(metadata, JSON.stringify({ ...owner, pid: process.pid }))
    else if (corruption === "unknown") fs.writeFileSync(metadata, "not initialized")
    else fs.rmSync(metadata)
    fs.utimesSync(gate, new Date(0), new Date(0))
    const before = fs.readdirSync(gate).map((name) => [name, fs.readFileSync(path.join(gate, name), "utf8")])
    let error: unknown
    try {
      origin.claim()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      `session stale-write guard is busy or unverifiable: ${gate}; retry, or remove this directory manually only after confirming no Amira process is running on any host using these session files`,
    )
    expect(
      fs.readdirSync(gate).map((name) => [name, fs.readFileSync(path.join(gate, name), "utf8")]),
    ).toEqual(before)
    expect(fs.existsSync(sessionLockFile(origin.file))).toBe(false)
    expect(SessionStore.open(origin.file).entries).toHaveLength(1)
  }, 210_000)
}

for (const state of ["live", "unknown"]) {
  test(`deletion reports the exact ${state} guard and preserves session bytes`, async () => {
    const gate = `${sessionLockFile(origin.file)}.lease-gate`
    if (state === "live") {
      const worker = startWorker("session-pause-gate-create")
      await waitFor(worker, "paused")
    } else {
      fs.mkdirSync(gate)
      fs.writeFileSync(path.join(gate, "owner.json"), "unverifiable")
    }
    const physicalGate = fs.realpathSync.native(gate)
    const before = fs.readFileSync(origin.file)
    let error: unknown
    try {
      deleteSession(dir, origin.id, undefined, dir)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("stale-write guard")
    expect((error as Error).message).toContain(physicalGate)
    expect((error as Error).message).not.toContain("currently open")
    expect(fs.readFileSync(origin.file)).toEqual(before)
    expect(fs.existsSync(gate)).toBe(true)
  }, 210_000)
}

test("resume and deletion name an unverifiable persistent lease without suggesting removal of an absent guard", async () => {
  const worker = startWorker("crash-lease")
  expect(await waitForFileLockWorkerExit(worker, "gate worker operation")).toBe(0)
  expect(await new Response(worker.stderr).text()).toBe("")
  expect(isProcessAlive(worker.pid)).toBe(false)
  const lease = sessionLockFile(origin.file)
  const lines = fs.readFileSync(lease, "utf8").trimEnd().split("\n")
  const owner = { ...JSON.parse(lines[2]!), host: "foreign-host" }
  const contents = `${owner.pid}\n${owner.nonce}\n${JSON.stringify(owner)}\n`
  fs.writeFileSync(lease, contents)
  const before = fs.readFileSync(origin.file)
  // Resume names the store's lease namespace; deletion resolves the public physical path.
  const attempts = [
    { run: () => origin.claim(), lease },
    { run: () => deleteSession(dir, origin.id, undefined, dir), lease: fs.realpathSync.native(lease) },
  ]
  for (const { run, lease: expectedLease } of attempts) {
    let error: unknown
    try {
      run()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain("stale-write guard")
    expect(message).toContain(expectedLease)
    expect(message).toContain("remove this lease file")
    expect(message).toContain("no Amira process is running on any host")
    expect(message).not.toContain(".lease-gate")
    expect(message).not.toContain("open in another Amira process")
    expect(fs.existsSync(`${lease}.lease-gate`)).toBe(false)
    expect(fs.readFileSync(lease, "utf8")).toBe(contents)
    expect(fs.readFileSync(origin.file)).toEqual(before)
  }
}, 210_000)
