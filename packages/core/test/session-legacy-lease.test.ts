import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isProcessAlive } from "../src/file-lock.ts"
import { deleteSession } from "../src/session-list.ts"
import { SESSION_LOCK_STALE_MS, SessionStore, sessionLockFile } from "../src/session-store.ts"

let dir: string
let origin: SessionStore
let deadPid: number
const workers: Bun.Subprocess<"ignore", "ignore", "pipe">[] = []
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-session-legacy-lease-"))
  origin = SessionStore.create({ cwd: dir, dir })
  origin.appendDisplay({ type: "display", level: "info", text: "original" })
  const child = startWorker("crash-lease")
  expect(await child.exited).toBe(0)
  expect(await new Response(child.stderr).text()).toBe("")
  deadPid = child.pid
  expect(isProcessAlive(deadPid)).toBe(false)
})
afterEach(async () => {
  for (const worker of workers.splice(0)) {
    if (worker.exitCode === null) worker.kill()
    await worker.exited
  }
  origin.release()
  fs.rmSync(dir, { recursive: true, force: true })
})

function startWorker(mode: string) {
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

async function waitFor(worker: ReturnType<typeof startWorker>, marker: string) {
  const deadline = Date.now() + 4000
  while (!fs.existsSync(path.join(dir, marker))) {
    if (worker.exitCode !== null)
      throw new Error(`legacy lease worker exited: ${await new Response(worker.stderr).text()}`)
    if (Date.now() > deadline) throw new Error(`legacy lease worker timed out: ${marker}`)
    await Bun.sleep(10)
  }
}

function legacyLease(contents: string, stale = true) {
  const file = sessionLockFile(origin.file)
  fs.writeFileSync(file, contents)
  if (stale) {
    const old = new Date(Date.now() - SESSION_LOCK_STALE_MS - 5000)
    fs.utimesSync(file, old, old)
  }
  return file
}

for (const kind of ["dead pid", "empty", "unparseable"]) {
  test(`resume recovers a stale legacy ${kind} lease as an owner-record lease`, () => {
    const file = legacyLease(kind === "dead pid" ? `${deadPid}\n` : kind === "empty" ? "" : "not-a-pid\n")
    const disk = fs.readFileSync(origin.file)
    const resumed = SessionStore.open(origin.file)
    try {
      expect(resumed.claim()).toBe(true)
      const [pid, nonce, record] = fs.readFileSync(file, "utf8").trimEnd().split("\n")
      expect(pid).toBe(String(process.pid))
      expect(JSON.parse(record!)).toMatchObject({ v: 2, pid: process.pid, nonce })
      expect(fs.readFileSync(origin.file)).toEqual(disk)
      expect(resumed.entries).toHaveLength(1)
    } finally {
      resumed.release()
    }
    expect(fs.readdirSync(dir)).toEqual([path.basename(origin.file)])
  })
}

for (const kind of ["live pid", "fresh dead pid"]) {
  test(`resume blocks a legacy ${kind} lease and explains how to close the older build`, () => {
    const contents = `${kind === "live pid" ? process.pid : deadPid}\n`
    const file = legacyLease(contents, kind === "live pid")
    expect(() => SessionStore.open(origin.file).claim()).toThrow(
      /older Amira build appears to hold the session.*close it/i,
    )
    expect(fs.readFileSync(file, "utf8")).toBe(contents)
    expect(fs.readdirSync(dir).sort()).toEqual([path.basename(origin.file), path.basename(file)].sort())
  })
}

test("two concurrent legacy lease recoverers grant exactly one session holder", async () => {
  const file = legacyLease(`${deadPid}\n`)
  const contenders = [startWorker("session-contend"), startWorker("session-contend")]
  await Promise.all(contenders.map((worker) => waitFor(worker, `ready-${worker.pid}`)))
  fs.writeFileSync(path.join(dir, "contend"), "go")
  await Promise.all(contenders.map((worker) => waitFor(worker, `result-${worker.pid}`)))
  const winners = contenders.filter(
    (worker) => JSON.parse(fs.readFileSync(path.join(dir, `result-${worker.pid}`), "utf8")).held,
  )
  expect(winners).toHaveLength(1)
  const contents = fs.readFileSync(file, "utf8")
  expect(JSON.parse(contents.trimEnd().split("\n")[2]!)).toMatchObject({
    v: 2,
    pid: winners[0]!.pid,
  })
  expect(() => origin.claim()).toThrow("open in another Amira process")
  expect(fs.readFileSync(file, "utf8")).toBe(contents)
  fs.writeFileSync(path.join(dir, "release"), "go")
  for (const worker of contenders) {
    expect(await worker.exited).toBe(0)
    expect(await new Response(worker.stderr).text()).toBe("")
  }
}, 10000)

for (const change of ["heartbeat", "replacement", "in-place replacement"]) {
  test(`legacy recovery rechecks a ${change} after proving local pid death`, () => {
    const file = legacyLease(`${deadPid}\n`)
    const identity = fs.statSync(file)
    const probe = process.kill
    let contents = `${deadPid}\n`
    const hook = spyOn(process, "kill").mockImplementation(((...args: Parameters<typeof probe>) => {
      try {
        return probe(...args)
      } catch (error) {
        if (change === "heartbeat") fs.utimesSync(file, new Date(), new Date())
        else {
          if (change === "replacement") fs.renameSync(file, `${file}.displaced`)
          else contents = `${process.pid}\n`
          fs.writeFileSync(file, contents)
          fs.utimesSync(file, identity.atime, identity.mtime)
        }
        throw error
      }
    }) as typeof probe)
    try {
      expect(() => origin.claim()).toThrow()
      expect(hook).toHaveBeenCalledWith(deadPid, 0)
      expect(fs.readFileSync(file, "utf8")).toBe(contents)
    } finally {
      hook.mockRestore()
    }
  })
}

for (const change of ["heartbeat", "replacement"]) {
  test(`legacy retirement protects a ${change} after the final authoritative recheck`, () => {
    const file = legacyLease(`${deadPid}\n`)
    const rename = fs.renameSync
    let changed = false
    let contents = `${deadPid}\n`
    const hook = spyOn(fs, "renameSync").mockImplementation((...args) => {
      if (args[0] === file && !changed) {
        changed = true
        if (change === "replacement") {
          rename(file, `${file}.displaced`)
          contents = `${process.pid}\n`
          fs.writeFileSync(file, contents)
        } else fs.utimesSync(file, new Date(), new Date())
      }
      return rename(...args)
    })
    try {
      expect(() => origin.claim()).toThrow()
      expect(changed).toBe(true)
      expect(fs.readFileSync(file, "utf8")).toBe(contents)
    } finally {
      hook.mockRestore()
    }
  })
}

test("failed legacy restoration cannot grant authority on a later acquisition", () => {
  const file = legacyLease(`${deadPid}\n`)
  const rename = fs.renameSync
  const link = fs.linkSync
  let changed = false
  const renameHook = spyOn(fs, "renameSync").mockImplementation((...args) => {
    if (args[0] === file && !changed) {
      changed = true
      fs.writeFileSync(file, `${process.pid}\n`)
    }
    return rename(...args)
  })
  const linkHook = spyOn(fs, "linkSync").mockImplementation((from, to) => {
    if (String(from).includes("stale") && to === file)
      throw Object.assign(new Error("restoration sharing violation"), { code: "EPERM" })
    return link(from, to)
  })
  try {
    expect(() => origin.claim()).toThrow()
    expect(fs.existsSync(file)).toBe(false)
  } finally {
    renameHook.mockRestore()
    linkHook.mockRestore()
  }
  expect(() => origin.claim()).toThrow(/older Amira build appears to hold the session/)
  expect(fs.readFileSync(file, "utf8")).toBe(`${process.pid}\n`)
})

test("interrupted legacy retirement restores the moved lease before granting authority", async () => {
  const file = legacyLease(`${deadPid}\n`)
  const worker = startWorker("pause-recovery")
  await waitFor(worker, "paused")
  const moved = fs
    .readdirSync(dir)
    .find((name) => name.startsWith(`${path.basename(file)}.`) && name.includes("stale"))!
  expect(moved).toBeDefined()
  // Model a live legacy replacement that was moved just before the recoverer crashed.
  fs.writeFileSync(path.join(dir, moved), `${process.pid}\n`)
  worker.kill()
  await worker.exited
  expect(isProcessAlive(worker.pid)).toBe(false)
  expect(() => origin.claim()).toThrow(/older Amira build appears to hold the session/)
  expect(fs.readFileSync(file, "utf8")).toBe(`${process.pid}\n`)
}, 10000)

for (const code of ["EPERM", "EACCES", "EINVAL"]) {
  test(`legacy recovery fails closed on process probe ${code}`, () => {
    const file = legacyLease(`${deadPid}\n`)
    const hook = spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("probe unavailable"), { code })
    })
    try {
      expect(() => origin.claim()).toThrow()
      expect(hook).toHaveBeenCalledWith(deadPid, 0)
      expect(fs.readFileSync(file, "utf8")).toBe(`${deadPid}\n`)
    } finally {
      hook.mockRestore()
    }
  })
}

test("unclaimed session writes recover stale legacy leases under the same gate", () => {
  const file = legacyLease(`${deadPid}\n`)
  origin.appendDisplay({ type: "display", level: "info", text: "after upgrade" })
  expect(SessionStore.open(origin.file).entries).toHaveLength(2)
  expect(fs.existsSync(file)).toBe(false)
  expect(fs.readdirSync(dir)).toEqual([path.basename(origin.file)])
})

test("session deletion recovers stale legacy leases", () => {
  legacyLease(`${deadPid}\n`)
  expect(deleteSession(dir, origin.id, undefined, dir)).toEqual([origin.file])
  expect(fs.readdirSync(dir)).toEqual([])
})
