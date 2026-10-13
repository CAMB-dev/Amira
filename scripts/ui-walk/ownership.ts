import { randomUUID } from "node:crypto"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export interface SessionOwner {
  root: string
  generation: string
}

export interface CleanupRecord extends SessionOwner {
  error?: string
}

export function cleanupFile(root: string): string {
  return `${root}.cleanup.json`
}

async function ownsConfig(owner: SessionOwner): Promise<boolean> {
  try {
    const config = JSON.parse(await readFile(path.join(owner.root, "config.json"), "utf8"))
    return config.root === owner.root && config.generation === owner.generation
  } catch {
    return false
  }
}

export async function readCleanupRecord(root: string): Promise<CleanupRecord | undefined> {
  try {
    const record: CleanupRecord = JSON.parse(await readFile(cleanupFile(root), "utf8"))
    if (record.root === root && typeof record.generation === "string") return record
  } catch {}
  return undefined
}

export async function ownsRoot(owner: SessionOwner): Promise<boolean> {
  if (await ownsConfig(owner)) return true
  return (await readCleanupRecord(owner.root))?.generation === owner.generation
}

async function saveCleanupRecord(record: CleanupRecord): Promise<void> {
  const file = cleanupFile(record.root)
  const existing = await readCleanupRecord(record.root)
  if (existing) {
    if (existing.generation !== record.generation)
      throw new Error(`Cleanup ownership mismatch: ${record.root}`)
    return // Reuse the proof; a late failed attempt must not recreate a record after another cleaner succeeds.
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Call only after the generation's resources stop. The sibling proof survives a partial rm. */
export async function removeOwnedRoot(owner: SessionOwner): Promise<void> {
  if (!(await ownsRoot(owner))) return
  await saveCleanupRecord(owner)
  try {
    await rm(owner.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    await rm(cleanupFile(owner.root), { force: true })
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Cleanup failed for ${owner.root}: ${diagnostic}; retry stop or list after releasing the lock`,
      { cause: error },
    )
  }
}

export async function writeOwnedError(owner: SessionOwner, error: unknown): Promise<void> {
  if (await ownsConfig(owner)) {
    await writeFile(path.join(owner.root, "error.txt"), error instanceof Error ? error.stack! : String(error))
  }
}
