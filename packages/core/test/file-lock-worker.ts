import { spyOn } from "bun:test"
import * as fs from "node:fs"
import path from "node:path"
import { type FileLock, tryFileLock } from "../src/file-lock.ts"
import { filesystemGatePath } from "./file-lock-fixtures.ts"

const [file, dir, mode] = process.argv.slice(2)
if (!file || !dir || !mode) throw new Error("missing file-lock worker arguments")
const mark = (name: string) => fs.writeFileSync(path.join(dir, name), "ready")
const wait = (name: string) => {
  const deadline = Date.now() + 5000
  const pause = new Int32Array(new SharedArrayBuffer(4))
  while (!fs.existsSync(path.join(dir, name))) {
    if (Date.now() > deadline) throw new Error(`file-lock worker timed out: ${name}`)
    Atomics.wait(pause, 0, 0, 10)
  }
}

const publishResult = (result: { held: boolean; error?: string }) => {
  const target = path.join(dir, `result-${process.pid}`)
  const pending = `${target}.pending`
  fs.writeFileSync(pending, JSON.stringify(result))
  fs.renameSync(pending, target)
}

const sessionMode = mode.startsWith("session-")
const { SessionStore } = await import("../src/session-store.ts")
const store = sessionMode ? SessionStore.open(file.slice(0, -5)) : undefined
const rename = fs.renameSync
const open = fs.openSync
const rm = fs.rmSync
const write = fs.writeFileSync
const gate = filesystemGatePath(file)
let releaseStarted = false
const contender = mode.startsWith("session-contend")
const sharingCode = mode.slice("session-contend-".length)
const sharingHook =
  contender && ["EPERM", "EBUSY", "EACCES"].includes(sharingCode)
    ? spyOn(fs, "renameSync").mockImplementation((...args) => {
        if (args[0] === gate && String(args[1]).startsWith(`${gate}.dead-`)) {
          sharingHook!.mockRestore()
          mark(`sharing-${process.pid}`)
          throw Object.assign(new Error(`${sharingCode}: retire dead gate`), { code: sharingCode })
        }
        return rename(...args)
      })
    : undefined
const initHook =
  mode === "session-pause-gate-init"
    ? spyOn(fs, "writeFileSync").mockImplementation((...args) => {
        if (String(args[0]).endsWith(`${path.sep}owner.json`)) {
          mark("paused")
          wait("continue")
        }
        return write(...args)
      })
    : undefined
const delayedRecovery = mode === "session-pause-gate-proof" || mode === "session-pause-gate-recheck"
const probe = process.kill
const proofHook =
  mode === "session-pause-gate-proof"
    ? spyOn(process, "kill").mockImplementation(((...args: Parameters<typeof probe>) => {
        try {
          return probe(...args)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            // The real OS has proved death, not just supplied a dead-looking record.
            mark("paused-proof")
            wait("continue-proof")
          }
          throw error
        }
      }) as typeof probe)
    : undefined
const recheckHook =
  mode === "session-pause-gate-recheck"
    ? spyOn(fs, "renameSync").mockImplementation((...args) => {
        if (args[0] === gate && String(args[1]).startsWith(`${gate}.dead-`)) {
          // Both authoritative reads AND proof completed; pause before the rename itself.
          mark("paused-proof")
          wait("continue-proof")
        }
        return rename(...args)
      })
    : undefined
const recoveryRetireHook =
  mode === "session-pause-gate-recovery-retire"
    ? spyOn(fs, "renameSync").mockImplementation((...args) => {
        rename(...args)
        if (args[0] === gate && String(args[1]).startsWith(`${gate}.dead-`)) {
          mark("paused-recovery")
          wait("continue-recovery")
        }
      })
    : undefined
const retireHook =
  mode === "session-pause-gate-retire"
    ? spyOn(fs, "renameSync").mockImplementation((...args) => {
        rename(...args)
        if (releaseStarted && args[0] === gate) {
          mark("paused")
          wait("continue")
        }
      })
    : undefined
const gateHook =
  mode === "session-pause-gate-create" || mode === "crash-gate"
    ? spyOn(fs, "renameSync").mockImplementation((...args) => {
        rename(...args)
        if (args[1] === gate) {
          if (mode === "crash-gate") process.exit(0)
          mark("paused")
          wait("continue")
        }
      })
    : undefined
const rmHook =
  mode === "session-pause-gate-release"
    ? spyOn(fs, "rmSync").mockImplementation((...args) => {
        if (args[0] === file) {
          mark("paused")
          wait("continue")
        }
        return rm(...args)
      })
    : undefined
const pauseRecovery = mode === "pause-recovery" || mode === "crash-recovery"
const renameHook = pauseRecovery
  ? spyOn(fs, "renameSync").mockImplementation((...args) => {
      rename(...args)
      if (args[0] !== file) return
      if (mode === "crash-recovery") process.exit(0)
      mark("paused")
      wait("continue")
    })
  : undefined
const openHook =
  mode === "pause-create"
    ? spyOn(fs, "openSync").mockImplementation((...args) => {
        const fd = open(...args)
        if (String(args[0]).startsWith(`${file}.pending-`) && args[1] === "wx") {
          mark("paused")
          wait("continue")
        }
        return fd
      })
    : undefined

if (contender) {
  mark(`ready-${process.pid}`)
  wait("contend")
}
let held: FileLock | undefined
try {
  if (store) {
    if (contender) {
      await store.withClaim(() => {
        // Retain the worker's lease beyond the temporary awaited-acquisition ref.
        store.claim()
      })
    } else store.claim()
    held = { release: () => store.release() }
  } else {
    held = tryFileLock(file, 1, undefined, true)
  }
} catch (error) {
  if (!contender && !delayedRecovery) throw error
  publishResult({
    held: false,
    error: error instanceof Error ? error.message : String(error),
  })
  process.exit(0)
}
renameHook?.mockRestore()
openHook?.mockRestore()
gateHook?.mockRestore()
initHook?.mockRestore()
proofHook?.mockRestore()
recheckHook?.mockRestore()
recoveryRetireHook?.mockRestore()
sharingHook?.mockRestore()
if (!held) throw new Error("file-lock worker was not granted authority")
if (mode === "crash-lease") process.exit(0)
if (contender || delayedRecovery) {
  publishResult({ held: true })
  wait("release")
} else {
  mark("acquired")
  wait("release")
}
releaseStarted = true
held.release()
rmHook?.mockRestore()
retireHook?.mockRestore()
