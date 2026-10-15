import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type FileLock, isProcessAlive, tryFileLock } from "../src/file-lock.ts"
import { takeFilesystemGate } from "../src/file-lock-gate.ts"
import { deadLease, expectReleasedArtifacts } from "./file-lock-fixtures.ts"
import {
  waitForFileLockCondition,
  waitForFileLockWorkerExit,
  waitForFileLockWorkerReady,
} from "./file-lock-test-waits.ts"

let dir: string
let deadPid: number
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-strict-file-lock-"))
  // A known, uniquely owned child that has exited, not an assumed unused pid.
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.join(import.meta.dir, "file-lock-worker-preload.ts"),
      "--eval",
      "process.exit(0)",
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
  deadPid = child.pid
  try {
    expect(await waitForFileLockWorkerExit(child, "strict dead-PID fixture")).toBe(0)
    expect(await new Response(child.stderr).text()).toBe("")
    expect(isProcessAlive(deadPid)).toBe(false)
  } finally {
    await finishWorker(child)
  }
}, 65_000)
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

test("strict recovery cannot grant a third lease while renaming an interleaved replacement", () => {
  const file = path.join(dir, "session.lock")
  deadLease(file, deadPid)
  const read = fs.readFileSync
  const rename = fs.renameSync
  let judgedDead = false
  let replacementAttempted = false
  let recoveryGapObserved = false
  let replacement: FileLock | undefined
  let third: FileLock | undefined
  let recovering: FileLock | undefined
  const readHook = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof read>) => {
    const contents = read(...args)
    if (args[0] === file && !judgedDead) {
      judgedDead = true
      // A has read the dead pid. B now replaces it through the real public seam.
      replacement = tryFileLock(file, 60_000, undefined, true)
      replacementAttempted = true
    }
    return contents
  }) as typeof read)
  const renameHook = spyOn(fs, "renameSync").mockImplementation((...args) => {
    rename(...args)
    if (args[0] === file && replacementAttempted) {
      // A moved the pathname aside (B's live file on the broken implementation).
      // C attempts a normal exclusive create before A validates/restores the move.
      recoveryGapObserved = true
      third = tryFileLock(file, 60_000, undefined, true)
    }
  })
  try {
    recovering = tryFileLock(file, 60_000, undefined, true)
    expect(judgedDead).toBe(true)
    expect(replacementAttempted).toBe(true)
    expect(recoveryGapObserved).toBe(true)
    expect(third).toBeUndefined()
    expect([recovering, replacement, third].filter(Boolean)).toHaveLength(1)
    expect(tryFileLock(file, 60_000, undefined, true)).toBeUndefined()
  } finally {
    readHook.mockRestore()
    renameHook.mockRestore()
    recovering?.release()
    replacement?.release()
    third?.release()
  }
})

test("strict release does not remove a different holder's replacement", () => {
  const file = path.join(dir, "session.lock")
  const original = tryFileLock(file, 60_000, undefined, true)!
  fs.renameSync(file, `${file}.displaced`)
  const replacement = tryFileLock(file, 60_000, undefined, true)!
  const contents = fs.readFileSync(file, "utf8")
  try {
    original.release()
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file, "utf8")).toBe(contents)
    expect(tryFileLock(file, 60_000, undefined, true)).toBeUndefined()
  } finally {
    original.release()
    replacement.release()
  }
})

test("strict takeover needs proof of death, not a failed process probe", () => {
  const file = path.join(dir, "session.lock")
  const contents = deadLease(file, deadPid)
  fs.utimesSync(file, new Date(0), new Date(0))
  const probe = spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("process probe unavailable"), { code: "EACCES" })
  })
  let lease: FileLock | undefined
  try {
    lease = tryFileLock(file, 1, undefined, true)
    expect(lease).toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith(deadPid, 0)
    expect(fs.readFileSync(file, "utf8")).toBe(contents)
  } finally {
    probe.mockRestore()
    lease?.release()
  }
})

test("strict live authority survives a stopped heartbeat and an arbitrarily old file", () => {
  const file = path.join(dir, "session.lock")
  const held = tryFileLock(file, 1, undefined, true)!
  try {
    fs.utimesSync(file, new Date(0), new Date(0))
    expect(tryFileLock(file, 1, undefined, true)).toBeUndefined()
  } finally {
    held.release()
    held.release()
  }
  expectReleasedArtifacts(dir, [file])
})

test("strict authority preserves fresh legacy leases even without a valid holder pid", () => {
  const file = path.join(dir, "session.lock")
  for (const contents of ["", "not-a-pid\n", "0\n", `${deadPid}\n`]) {
    fs.writeFileSync(file, contents)
    expect(tryFileLock(file, 60_000, undefined, true)).toBeUndefined()
    expect(fs.readFileSync(file, "utf8")).toBe(contents)
  }
})

test("strict release also protects an in-place replacement using its nonce", () => {
  const file = path.join(dir, "session.lock")
  const held = tryFileLock(file, 60_000, undefined, true)!
  const replacement = `${process.pid}\nreplacement-nonce\n`
  fs.writeFileSync(file, replacement)
  held.release()
  expect(fs.readFileSync(file, "utf8")).toBe(replacement)
  expect(tryFileLock(file, 60_000, undefined, true)).toBeUndefined()
})

test("a strict release racing a gated acquisition waits before checking and unlinking", async () => {
  const file = path.join(dir, "session.lock")
  const held = tryFileLock(file, 60_000, undefined, true)!
  const stat = fs.statSync
  let releaseAttempted = false
  let remainedWhileGated = false
  const hook = spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof stat>) => {
    const result = stat(...args)
    if (args[0] === file && !releaseAttempted) {
      releaseAttempted = true
      held.release()
      remainedWhileGated = fs.existsSync(file)
    }
    return result
  }) as typeof stat)
  try {
    expect(tryFileLock(file, 60_000, undefined, true)).toBeUndefined()
    expect(releaseAttempted).toBe(true)
    expect(remainedWhileGated).toBe(true)
  } finally {
    hook.mockRestore()
    held.release()
  }
  await waitForFileLockCondition(`strict gated release: ${file}`, () => !fs.existsSync(file))
  expectReleasedArtifacts(dir, [file])
  tryFileLock(file, 60_000, undefined, true)!.release()
}, 35_000)

function startWorker(file: string, mode: string) {
  return Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.join(import.meta.dir, "file-lock-worker-preload.ts"),
      path.join(import.meta.dir, "file-lock-worker.ts"),
      file,
      dir,
      mode,
      "ready-go",
    ],
    {
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
      ),
      stdout: "ignore",
      stderr: "pipe",
    },
  )
}

async function waitForWorker(worker: ReturnType<typeof startWorker>, marker: string) {
  await waitForFileLockCondition(`strict worker ${worker.pid}: ${path.join(dir, marker)}`, () => {
    if (fs.existsSync(path.join(dir, marker))) return true
    if (worker.exitCode !== null)
      throw new Error(`strict worker ${worker.pid} exited (${worker.exitCode}) before ${marker}`)
    return false
  }).catch(async (error) => {
    if (worker.exitCode !== null)
      throw new Error(`${error.message}: ${await new Response(worker.stderr).text()}`)
    throw error
  })
}

async function finishWorker(worker: ReturnType<typeof startWorker>) {
  // Never kill by process name or an unowned pid; always await this exact child's exit.
  if (worker.exitCode === null) worker.kill()
  await waitForFileLockWorkerExit(worker, "strict worker cleanup")
}

for (const mode of ["pause-recovery", "pause-create"]) {
  test(`strict cross-process ${mode} blocks contenders throughout the authority gap`, async () => {
    const file = path.join(dir, "session.lock")
    if (mode === "pause-recovery") deadLease(file, deadPid)
    const worker = startWorker(file, mode)
    try {
      await waitForFileLockWorkerReady(worker, dir, `strict ${mode} startup`)
      await waitForWorker(worker, "paused")
      expect(fs.existsSync(`${file}.lease-gate`)).toBe(true)
      if (mode === "pause-recovery") expect(fs.existsSync(file)).toBe(false)
      else {
        expect(fs.existsSync(file)).toBe(false)
        const pending = fs.readdirSync(dir).find((name) => name.startsWith("session.lock.pending-"))!
        expect(pending).toBeDefined()
        expect(fs.readFileSync(path.join(dir, pending), "utf8")).toBe("")
      }
      expect(tryFileLock(file, 1, undefined, true)).toBeUndefined()
      const unrelated = tryFileLock(path.join(dir, "unrelated.lock"), 1, undefined, true)
      expect(unrelated).toBeDefined()
      unrelated!.release()
      fs.writeFileSync(path.join(dir, "continue"), "ready")
      await waitForWorker(worker, "acquired")
      expect(fs.existsSync(`${file}.lease-gate`)).toBe(false)
      fs.utimesSync(file, new Date(0), new Date(0))
      // A real living writer, with no heartbeat, remains the only writer despite old mtime.
      expect(tryFileLock(file, 1, undefined, true)).toBeUndefined()
      fs.writeFileSync(path.join(dir, "release"), "ready")
      expect(await waitForFileLockWorkerExit(worker, "strict worker operation")).toBe(0)
      expect(await new Response(worker.stderr).text()).toBe("")
      expect(fs.existsSync(file)).toBe(false)
      tryFileLock(file, 1, undefined, true)!.release()
    } finally {
      await finishWorker(worker)
    }
  }, 130_000)
}

test("strict ordinary crashed process leases remain recoverable", async () => {
  const file = path.join(dir, "session.lock")
  const worker = startWorker(file, "crash-lease")
  try {
    await waitForFileLockWorkerReady(worker, dir, "strict crash-lease startup")
    expect(await waitForFileLockWorkerExit(worker, "strict worker operation")).toBe(0)
    expect(await new Response(worker.stderr).text()).toBe("")
    expect(isProcessAlive(worker.pid)).toBe(false)
    expect(fs.existsSync(`${file}.lease-gate`)).toBe(false)
    expect(Number.parseInt(fs.readFileSync(file, "utf8"), 10)).toBe(worker.pid)
    const recovered = tryFileLock(file, 60_000, undefined, true)
    expect(recovered).toBeDefined()
    recovered!.release()
    expectReleasedArtifacts(dir, [file])
  } finally {
    await finishWorker(worker)
  }
}, 95_000)

test("strict recovery crashes automatically recover a provably dead gate", async () => {
  const file = path.join(dir, "session.lock")
  deadLease(file, deadPid)
  const worker = startWorker(file, "crash-recovery")
  try {
    await waitForFileLockWorkerReady(worker, dir, "strict crash-recovery startup")
    expect(await waitForFileLockWorkerExit(worker, "strict worker operation")).toBe(0)
    expect(await new Response(worker.stderr).text()).toBe("")
    expect(isProcessAlive(worker.pid)).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(`${file}.lease-gate`)).toBe(true)
    fs.utimesSync(`${file}.lease-gate`, new Date(0), new Date(0))
    const recovered = tryFileLock(file, 1, undefined, true)
    expect(recovered).toBeDefined()
    expect(tryFileLock(file, 1, undefined, true)).toBeUndefined()
    recovered!.release()
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(`${file}.lease-gate`)).toBe(false)
  } finally {
    await finishWorker(worker)
  }
}, 95_000)

for (const corruption of [
  "foreign",
  "missing-host",
  "foreign-boot",
  "missing-boot",
  "foreign-pid-namespace",
  "missing-pid-namespace",
  "legacy",
  "invalid-version",
  "invalid-created-at",
  "invalid-nonce",
  "mismatched-pid",
  "mismatched-nonce",
]) {
  test(`strict persistent ${corruption} lease blocks local ESRCH recovery and reports the lease, not an absent guard`, () => {
    const file = path.join(dir, "session.lock")
    const held = tryFileLock(file, 60_000, undefined, true)!
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n")
    expect(lines).toHaveLength(3)
    const owner = JSON.parse(lines[2]!)
    owner.pid = deadPid
    if (corruption === "foreign") owner.host = "another-host"
    if (corruption === "missing-host") owner.host = null
    if (corruption === "foreign-boot") owner.boot = "another-boot"
    if (corruption === "missing-boot") delete owner.boot
    if (corruption === "foreign-pid-namespace") owner.pidNamespace = "another-namespace"
    if (corruption === "missing-pid-namespace") delete owner.pidNamespace
    if (corruption === "invalid-version") owner.v = 1
    if (corruption === "invalid-created-at") owner.createdAt = 0
    if (corruption === "invalid-nonce") owner.nonce = "invalid-nonce"
    const pid = corruption === "mismatched-pid" ? process.pid : deadPid
    const nonce = corruption === "mismatched-nonce" ? "mismatched-nonce" : owner.nonce
    const contents =
      corruption === "legacy"
        ? `${deadPid}\n${owner.nonce}\n`
        : `${pid}\n${nonce}\n${JSON.stringify(owner)}\n`
    fs.writeFileSync(file, contents)
    held.release()
    fs.utimesSync(file, new Date(0), new Date(0))
    let blocked: string | undefined
    const contender = tryFileLock(file, 1, undefined, true, (name) => {
      blocked = name
    })
    try {
      expect(contender).toBeUndefined()
      expect(blocked).toBe(file)
      expect(fs.readFileSync(file, "utf8")).toBe(contents)
      expect(fs.existsSync(`${file}.lease-gate`)).toBe(false)
    } finally {
      contender?.release()
    }
  })
}

test("strict filesystem arbitration is per lease, including canonical directory aliases", () => {
  const first = path.join(dir, "first.lock")
  const alias = path.join(dir, "alias")
  fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir")
  const unlock = takeFilesystemGate(first)!
  let other: FileLock | undefined
  try {
    expect(unlock).toBeDefined()
    expect(takeFilesystemGate(path.join(alias, "first.lock"))).toBeUndefined()
    if (process.platform === "win32") expect(takeFilesystemGate(first.toUpperCase())).toBeUndefined()
    other = tryFileLock(path.join(dir, "other.lock"), 60_000, undefined, true)
    expect(other).toBeDefined()
  } finally {
    other?.release()
    unlock()
  }
})

for (const mode of [
  "release-missing-parent",
  "release-replaced-parent",
  "release-replaced-directory",
  "release-fs-error",
  "release-cleanup-error",
]) {
  test(`strict filesystem release worker ${mode} contains faults and closes retained descriptors`, async () => {
    const worker = Bun.spawn(
      [
        process.execPath,
        "--preload",
        path.join(import.meta.dir, "file-lock-worker-preload.ts"),
        path.join(import.meta.dir, "file-lock-review-worker.ts"),
        dir,
        mode,
      ],
      {
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
        ),
        stdout: "ignore",
        stderr: "pipe",
      },
    )
    try {
      await waitForWorker(worker, `ready-${worker.pid}`)
      fs.writeFileSync(path.join(dir, "review-go"), "go")
      await waitForFileLockWorkerExit(worker, `review worker ${mode} operation`, 65_000)
      const stderr = await new Response(worker.stderr).text()
      expect(stderr).toBe("")
      expect(await waitForFileLockWorkerExit(worker, "strict worker operation")).toBe(0)
      expect(fs.readFileSync(path.join(dir, "survived"), "utf8")).toBe("unchanged")
    } finally {
      await finishWorker(worker)
    }
  }, 130_000)
}

test("120 ordinary strict claims/releases leave no gates, tombstones or other artifacts", () => {
  const file = path.join(dir, "session.lock")
  for (let turn = 0; turn < 120; turn++) {
    const lease = tryFileLock(file, 60_000, undefined, true)
    expect(lease).toBeDefined()
    expect(tryFileLock(file, 60_000, undefined, true)).toBeUndefined()
    lease!.release()
    expectReleasedArtifacts(dir, [file])
  }
}, 30_000)
