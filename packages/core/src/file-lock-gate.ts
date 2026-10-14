import { randomUUID } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { leaseOwner, ownerState } from "./file-lock-owner.ts"

function readOwner(gate: string): string | undefined {
  try {
    if (!lstatSync(gate).isDirectory() || lstatSync(gate).isSymbolicLink()) return undefined
    const metadata = path.join(gate, "owner.json")
    if (!lstatSync(metadata).isFile() || lstatSync(metadata).isSymbolicLink()) return undefined
    return readFileSync(metadata, "utf8")
  } catch {
    return undefined
  }
}

/**
 * All participants publish initialized NONEMPTY directories and never edit their metadata.
 * A dead owner's nonce determines a permanent, nonempty retirement destination. A delayed
 * reclaimer cannot rename a replacement over that destination on Windows or POSIX, even
 * after the replacement releases and another writer arrives. Never remove these crash
 * tombstones online. Recovery alone grants nothing: only publication grants the gate.
 *
 * Unknown gates (including empty directories) fail closed. As with lease files, this is
 * a cooperating-process protocol, not protection against external pathname/metadata edits.
 * In particular an outsider creating an empty directory between the absence check and
 * publication is outside the protocol: POSIX rename can replace an empty directory.
 */
export function takeFilesystemGate(lockPath: string): (() => void) | undefined {
  return withFilesystemGateAttempt(() => takeGate(lockPath))
}

/** Share one exact-owned retirement attempt across nested cleanup and acquisition. */
export function withFilesystemGateAttempt<T>(operation: () => T): T {
  if (attempted) return operation()
  attempted = new Set<OwnedGate>()
  try {
    return operation()
  } finally {
    attempted = undefined
  }
}

function takeGate(lockPath: string): (() => void) | undefined {
  // Parent realpath unifies relative paths, junctions and directory symlinks. The
  // physical parent identity below is still checked before EVERY deferred write.
  const parent = realpathSync(path.dirname(path.resolve(lockPath)))
  const gate = path.join(parent, `${path.basename(lockPath)}.lease-gate`)
  const key = process.platform === "win32" ? gate.toLowerCase() : gate
  for (const owned of pending.get(key) ?? []) {
    if (owned.working) return undefined
    if (!owned.requested) {
      // A displaced active gate no longer controls this pathname. Discard its registry
      // entry without retiring it; an exact active owner still blocks nested acquisition.
      owned.working = true
      try {
        if (
          sameIdentity(statSync(parent), owned.parentIdentity) &&
          sameIdentity(lstatSync(gate), owned.identity)
        )
          return undefined
        forget(owned)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined
        forget(owned)
      } finally {
        owned.working = false
      }
      continue
    }
    // Nested release cleanup and acquisition share this exact-owned attempt. Private
    // debris never restarts a backoff budget or gains authority over a replacement.
    retire(owned, exiting)
    if (!owned.retired && pending.get(key)?.has(owned)) return undefined
  }
  const parentIdentity = statSync(parent)
  try {
    lstatSync(gate)
    const contents = readOwner(gate)
    if (contents === undefined) return undefined
    let owner: ReturnType<typeof leaseOwner>
    try {
      owner = JSON.parse(contents)
    } catch {
      return undefined
    }
    if (ownerState(owner) !== "dead") return undefined
    // Recheck identity at the authoritative pathname AFTER proof. The rename destination
    // also fences a pause AFTER this check: another recoverer retains the old nonce there.
    if (readOwner(gate) !== contents) return undefined
    const tombstone = `${gate}.dead-${owner.nonce}`
    try {
      renameSync(gate, tombstone)
    } catch (error) {
      // Only this retirement follows fresh death proof and an authoritative owner recheck.
      // Preserve sharing errors for awaited acquisition; every retry must prove again.
      const code = (error as NodeJS.ErrnoException).code
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        // Windows also uses sharing codes for a losing recoverer's tombstone collision.
        // An occupied fence remains contention, never a hint to wait on its replacement.
        if (existsSync(tombstone)) return undefined
        throw error
      }
      if (contended(error)) return undefined
      throw error
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const owner = leaseOwner()
  const contents = JSON.stringify(owner)
  const staging = mkdtempSync(`${gate}.pending-${process.pid}-`)
  let published = false
  try {
    writeFileSync(path.join(staging, "owner.json"), contents)
    // Do not let POSIX rename replace a preexisting unknown EMPTY canonical directory.
    try {
      lstatSync(gate)
      return undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    try {
      renameSync(staging, gate)
      published = true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        // Sharing errors also describe publication collisions on Windows. Only a fresh
        // absence check preserves the error for bounded awaited acquisition; an occupied
        // or unverifiable canonical path remains contention. A retry starts proof anew.
        try {
          lstatSync(gate)
        } catch (check) {
          if ((check as NodeJS.ErrnoException).code === "ENOENT") throw error
        }
        return undefined
      }
      if (contended(error)) return undefined
      throw error
    }
  } finally {
    // Private staging is never authority. A crash here leaves only offline-cleanable debris.
    // Successful rename moved the whole directory; its old pathname is no longer ours.
    if (!published) rmSync(staging, { recursive: true, force: true })
  }
  const owned: OwnedGate = {
    gate,
    key,
    parent,
    parentIdentity,
    contents,
    identity: lstatSync(gate),
    cleanup: `${gate}.retired-${process.pid}-${randomUUID()}`,
    requested: false,
    retired: false,
    working: false,
    automatic: 0,
    warned: false,
  }
  const records = pending.get(key) ?? new Set<OwnedGate>()
  records.add(owned)
  pending.set(key, records)
  return () => {
    if (!pending.get(key)?.has(owned)) return
    owned.requested = true
    // Nonthrowing finalization preserves a newly returned FileLock even when Windows
    // temporarily prevents moving its gate. An active critical section is never retried.
    retire(owned, exiting)
  }
}

interface OwnedGate {
  gate: string
  key: string
  parent: string
  parentIdentity: Stats
  identity: Stats
  contents: string
  cleanup: string
  requested: boolean
  retired: boolean
  working: boolean
  automatic: number
  warned: boolean
  error?: unknown
  timer?: ReturnType<typeof setTimeout>
}

// One inline attempt, then five unref'ed automatic attempts over 775ms. No cleanup
// sleeps on the calling thread. Exhaustion keeps exact ownership retryable, but never
// starts another timer budget. Private removal and retirement have distinct authority.
const delays = [25, 50, 100, 200, 400]
const pending = new Map<string, Set<OwnedGate>>()
let attempted: Set<OwnedGate> | undefined
let exiting = false

/** Read-only proof: only this exact canonical, release-requested gate may be waited on. */
export function pendingOwnedGate(gate: string): boolean {
  try {
    const parent = realpathSync(path.dirname(path.resolve(gate)))
    const canonical = path.join(parent, path.basename(gate))
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical
    for (const owned of pending.get(key) ?? []) {
      if (
        owned.requested &&
        !owned.retired &&
        sameIdentity(statSync(parent), owned.parentIdentity) &&
        sameIdentity(lstatSync(canonical), owned.identity) &&
        readOwner(canonical) === owned.contents
      )
        return true
    }
  } catch {}
  return false
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

function forget(owned: OwnedGate): void {
  clearTimeout(owned.timer)
  const records = pending.get(owned.key)
  records?.delete(owned)
  if (!records?.size) pending.delete(owned.key)
}

function attempt(owned: OwnedGate): boolean {
  try {
    if (!sameIdentity(statSync(owned.parent), owned.parentIdentity)) {
      forget(owned)
      return true
    }
    const target = owned.retired ? owned.cleanup : owned.gate
    const current = lstatSync(target)
    if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, owned.identity)) {
      forget(owned)
      return true
    }
    if (!owned.retired) {
      const metadata = path.join(owned.gate, "owner.json")
      const stat = lstatSync(metadata)
      if (!stat.isFile() || stat.isSymbolicLink() || readFileSync(metadata, "utf8") !== owned.contents) {
        forget(owned)
        return true
      }
      // Only a successful canonical rename completes retirement. Never delete metadata
      // in authority, and never retry a canonical pathname once this move succeeded.
      renameSync(owned.gate, owned.cleanup)
      owned.retired = true
    }
    rmSync(owned.cleanup, { recursive: true, force: true })
    forget(owned)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      forget(owned)
      return true
    }
    owned.error = error
    return false
  }
}

function warn(owned: OwnedGate): void {
  if (owned.warned) return
  owned.warned = true
  const error = owned.error as NodeJS.ErrnoException | undefined
  try {
    process.emitWarning(
      `Filesystem gate cleanup failed: ${owned.retired ? owned.cleanup : owned.gate}: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(owned.error)}; exact owned cleanup remains pending`,
    )
  } catch {}
}

function retire(owned: OwnedGate, final = false): void {
  if (owned.working || !owned.requested || attempted?.has(owned)) return
  attempted?.add(owned)
  owned.working = true
  try {
    if (attempt(owned)) return
    if (final || owned.automatic === delays.length) {
      warn(owned)
    } else if (!owned.timer) {
      owned.timer = setTimeout(() => {
        owned.timer = undefined
        owned.automatic++
        retire(owned)
      }, delays[owned.automatic])
      owned.timer.unref()
    }
  } finally {
    owned.working = false
  }
}

process.on("exit", () => {
  // Later exit listeners (including SessionStore disposal) also finalize immediately.
  exiting = true
  for (const records of pending.values()) {
    for (const owned of records) if (owned.requested) retire(owned, true)
  }
})

function contended(error: unknown): boolean {
  // Windows reports EACCES/EPERM for some directory-rename collisions. Fail closed;
  // neither a collision nor a missing source is evidence that we acquired authority.
  return ["EEXIST", "ENOTEMPTY", "ENOENT", "EACCES", "EPERM", "EBUSY", "ENOTDIR", "EISDIR"].includes(
    (error as NodeJS.ErrnoException).code ?? "",
  )
}
