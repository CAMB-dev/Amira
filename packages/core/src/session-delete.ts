import {
  type BigIntStats,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { relocateReleasedGateCleanup } from "./file-lock-gate.ts"
import { fileHistoryDir } from "./file-rewind.ts"

interface DirectoryProof {
  directory: string
  ancestors: Map<string, BigIntStats>
}

interface Entry {
  file: string
  identity: BigIntStats
  children?: Entry[]
}

interface ExpectedEntry {
  identity: BigIntStats
  contents?: string
  /** A released deletion lease must never regain public-path authority during rollback. */
  discardOnRollback?: boolean
}

export type SessionDeletionStage = (file: string, expected?: ExpectedEntry) => void

function inspect(file: string): BigIntStats | undefined {
  try {
    return lstatSync(file, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function same(actual: BigIntStats | undefined, expected: BigIntStats): boolean {
  return actual?.dev === expected.dev && actual.ino === expected.ino && actual.mode === expected.mode
}

function requireIdentity(file: string, expected: BigIntStats): void {
  if (!same(inspect(file), expected)) throw new Error(`unsafe session path replaced: ${file}`)
}

function within(directory: string, file: string): boolean {
  const relative = path.relative(directory, file)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function rebase(file: string, from: string, to: string): string {
  return within(from, file) ? path.join(to, path.relative(from, file)) : file
}

/** Inspect the requested directory before resolving public parent aliases; private walks stay strict. */
export function sessionDeletionDirectory(dir: string, resolveParentAliases = false): DirectoryProof {
  let directory = path.resolve(dir)
  if (resolveParentAliases) {
    const requested = inspect(directory)
    if (!requested?.isDirectory() || requested.isSymbolicLink())
      throw new Error(`unsafe session directory symlink or missing directory: ${directory}`)
    const physical = realpathSync.native(directory)
    requireIdentity(physical, requested)
    directory = physical
  }
  const ancestors = new Map<string, BigIntStats>()
  for (let part = directory; ; part = path.dirname(part)) {
    const identity = inspect(part)
    if (!identity?.isDirectory() || identity.isSymbolicLink())
      throw new Error(`unsafe session directory symlink or missing directory: ${part}`)
    ancestors.set(part, identity)
    if (path.dirname(part) === part) break
  }
  return { directory, ancestors }
}

function checkParents(proof: DirectoryProof): void {
  for (const [file, identity] of proof.ancestors)
    if (file !== proof.directory) requireIdentity(file, identity)
}

/** Remember delayed trace cleanup's descendants as well as the original root. */
export function sessionTraceCleanupProof(
  proof: DirectoryProof,
  files: readonly string[],
): {
  check(): void
  checkMoved(directory: string): void
} {
  const identities = new Map(proof.ancestors)
  for (const file of files) {
    const parent = path.dirname(path.resolve(file))
    if (!within(proof.directory, parent)) throw new Error("unsafe session trace path")
    for (const [part, identity] of sessionDeletionDirectory(parent).ancestors)
      if (!identities.has(part)) identities.set(part, identity)
  }
  return {
    check() {
      for (const [file, identity] of identities) requireIdentity(file, identity)
    },
    checkMoved(directory) {
      for (const [file, identity] of identities)
        if (within(proof.directory, file)) requireIdentity(rebase(file, proof.directory, directory), identity)
    },
  }
}

function snapshot(file: string): Entry | undefined {
  const identity = inspect(file)
  if (!identity) return undefined
  return {
    file,
    identity,
    ...(identity.isDirectory() && !identity.isSymbolicLink()
      ? {
          children: readdirSync(file).map((name) => {
            const child = snapshot(path.join(file, name))
            if (!child) throw new Error(`unsafe session asset disappeared: ${name}`)
            return child
          }),
        }
      : {}),
  }
}

/** Stage only these sessions' assets, traces and recordings, never unrelated directories. */
export function stageSessionFiles(files: Set<string>, stage: SessionDeletionStage): void {
  for (const file of [...files].reverse()) {
    const assets = path.dirname(fileHistoryDir(file))
    for (const part of [assets, path.join(assets, "files"), path.join(assets, "outputs")])
      if (inspect(part)?.isSymbolicLink()) throw new Error("unsafe session asset symlink")
    stage(assets)
    stage(`${file}.trace.jsonl`)
    if (!inspect(file)) throw new Error(`unsafe session recording disappeared: ${file}`)
    stage(file)
  }
}

/**
 * Core deliberately uses no FFI. On every platform, relocate the whole session directory
 * into a random private tombstone and verify the moved inode BEFORE reading sessions,
 * acquiring deletion leases or staging anything for removal. Original-name junction swaps
 * cannot redirect operations in this verified private namespace. Relocate descendant
 * directories too, verifying each move before traversing; unlink links, never their targets.
 * Restore unrelated sessions and their unchanged directory/lease identities before deleting
 * the flat staged entries. Cross-device moves and verification/restoration failures fail
 * closed, preserving data and reporting its recovery path rather than copying or following.
 *
 * Residual same-user race: portable fs APIs are pathname-based, not handle-relative. A user
 * who discovers and mutates the private tombstone between an identity check and an operation
 * can still race it (0700 on POSIX; inherited ACLs on Windows). Amira is a single-user tool;
 * this limitation is accepted. It is not a guarantee against hostile same-user processes.
 */
export function withSessionDeletionDirectory<T>(
  proof: DirectoryProof,
  operation: (directory: string, stage: SessionDeletionStage) => T,
): T {
  const { directory } = proof
  const rootIdentity = proof.ancestors.get(directory)!
  checkParents(proof)
  requireIdentity(directory, rootIdentity)
  const temporary = realpathSync.native(tmpdir())
  if (within(directory, temporary))
    throw new Error("unsafe session staging directory inside session directory")
  const privateProof = sessionDeletionDirectory(temporary)
  const tombstone = mkdtempSync(path.join(temporary, "amira-session-delete-"))
  const tombstoneIdentity = inspect(tombstone)!
  const root = path.join(tombstone, "root")
  const directories = new Map<string, BigIntStats>([
    [root, rootIdentity],
    [tombstone, tombstoneIdentity],
  ])
  const moves: { from: string; to: string; identity: BigIntStats; discardOnRollback?: boolean }[] = []
  const containers: { from: string; to: string; identity: BigIntStats; restored: boolean }[] = []
  const detached = new Map<string, string>([[root, root]])
  let movedRoot: BigIntStats | undefined
  let restored = false
  let result!: T
  const checkPrivate = () => {
    for (const [file, identity] of privateProof.ancestors) requireIdentity(file, identity)
    requireIdentity(tombstone, tombstoneIdentity)
  }
  const restoreRoot = () => {
    checkPrivate()
    checkParents(proof)
    if (!movedRoot) return
    requireIdentity(root, movedRoot)
    if (inspect(directory)) throw new Error(`unsafe session restoration conflict: ${directory}`)
    renameSync(root, directory)
    restored = true
    try {
      for (const move of [...moves, ...containers]) move.from = rebase(move.from, root, directory)
      for (const [file, identity] of [...directories]) {
        const rebased = rebase(file, root, directory)
        if (rebased !== file) {
          directories.delete(file)
          directories.set(rebased, identity)
        }
      }
      requireIdentity(directory, movedRoot)
      checkParents(proof)
    } finally {
      // Rename-back has already published the gates. Preserve their retryable rebinding
      // intent even if post-restore verification fails; the gate's own proofs still apply.
      relocateReleasedGateCleanup(root, directory)
    }
  }
  const container = (original: string): string => {
    const existing = detached.get(original)
    if (existing) return existing
    const identity = directories.get(original)
    if (!identity?.isDirectory() || identity.isSymbolicLink())
      throw new Error(`unsafe session ancestor: ${original}`)
    const from = path.join(container(path.dirname(original)), path.basename(original))
    checkPrivate()
    requireIdentity(path.dirname(from), directories.get(path.dirname(from))!)
    requireIdentity(from, identity)
    const to = path.join(tombstone, `container-${containers.length}`)
    renameSync(from, to)
    const moved = inspect(to)
    if (!moved) throw new Error(`unsafe session container disappeared: ${to}`)
    containers.push({ from, to, identity: moved, restored: false })
    requireIdentity(to, identity)
    directories.set(to, identity)
    detached.set(original, to)
    return to
  }
  const restoreContainers = () => {
    for (const item of [...containers].reverse()) {
      if (item.restored) continue
      requireIdentity(item.to, item.identity)
      requireIdentity(path.dirname(item.from), directories.get(path.dirname(item.from))!)
      if (inspect(item.from)) throw new Error(`unsafe session container restoration conflict: ${item.from}`)
      renameSync(item.to, item.from)
      requireIdentity(item.from, item.identity)
      item.restored = true
      for (const move of [...moves, ...containers]) move.from = rebase(move.from, item.to, item.from)
    }
    detached.clear()
    detached.set(root, root)
  }
  const stageTree = (entry: Entry, from: string) => {
    checkPrivate()
    requireIdentity(path.dirname(from), directories.get(path.dirname(from))!)
    requireIdentity(from, entry.identity)
    const to = path.join(tombstone, `entry-${moves.length}`)
    renameSync(from, to)
    const moved = inspect(to)
    if (!moved) throw new Error(`unsafe session staged entry disappeared: ${to}`)
    moves.push({ from, to, identity: moved })
    requireIdentity(to, entry.identity)
    if (entry.children) {
      directories.set(to, entry.identity)
      for (const child of entry.children) stageTree(child, path.join(to, path.basename(child.file)))
      if (readdirSync(to).length) throw new Error(`unsafe session directory changed: ${to}`)
    }
    return to
  }
  const stage: SessionDeletionStage = (file, expected) => {
    if (!within(root, path.resolve(file)) || path.resolve(file) === root)
      throw new Error("unsafe session deletion path")
    for (const [part, identity] of sessionDeletionDirectory(path.dirname(file)).ancestors) {
      if (!within(root, part)) continue
      if (directories.has(part)) requireIdentity(part, directories.get(part)!)
      else directories.set(part, identity)
    }
    const entry = snapshot(file)
    if (!entry) return
    if (expected) {
      requireIdentity(file, expected.identity)
      if (expected.contents !== undefined && readFileSync(file, "utf8") !== expected.contents)
        throw new Error(`unsafe session lease replaced: ${file}`)
    }
    const start = moves.length
    const to = stageTree(entry, path.join(container(path.dirname(file)), path.basename(file)))
    if (expected?.contents !== undefined && readFileSync(to, "utf8") !== expected.contents)
      throw new Error(`unsafe session lease changed: ${file}`)
    if (expected?.discardOnRollback) for (const move of moves.slice(start)) move.discardOnRollback = true
    restoreContainers()
  }
  try {
    checkPrivate()
    renameSync(directory, root)
    movedRoot = inspect(root)
    requireIdentity(root, rootIdentity)
    checkParents(proof)
    result = operation(root, stage)
    restoreContainers()
    requireIdentity(root, rootIdentity)
    restoreRoot()
  } catch (error) {
    try {
      checkPrivate()
      if (restored) requireIdentity(directory, rootIdentity)
      restoreContainers()
      for (const move of [...moves].reverse()) {
        if (move.discardOnRollback) continue
        requireIdentity(move.to, move.identity)
        requireIdentity(path.dirname(move.from), directories.get(path.dirname(move.from))!)
        if (inspect(move.from)) throw new Error(`unsafe session rollback conflict: ${move.from}`)
        renameSync(move.to, move.from)
      }
      if (!restored) restoreRoot()
      // Released leases stay private even when session data is restored after a failure.
      for (const move of moves.filter((item) => item.discardOnRollback)) {
        checkPrivate()
        requireIdentity(move.to, move.identity)
        unlinkSync(move.to)
      }
      rmdirSync(tombstone)
    } catch {
      throw new Error(`unsafe session deletion stopped; preserved data for recovery at ${tombstone}`, {
        cause: error,
      })
    }
    throw error
  }
  try {
    for (const move of [...moves].reverse()) {
      checkPrivate()
      requireIdentity(move.to, move.identity)
      if (move.identity.isDirectory() && !move.identity.isSymbolicLink()) rmdirSync(move.to)
      else unlinkSync(move.to)
    }
    checkPrivate()
    rmdirSync(tombstone)
  } catch (error) {
    throw new Error(`session deletion stopped; staged data remains at ${tombstone}`, { cause: error })
  }
  return result
}
