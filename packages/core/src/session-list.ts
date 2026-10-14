import { type BigIntStats, existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { type FileLock, isProcessAlive, SessionWriteGuardError, tryFileLock } from "./file-lock.ts"
import {
  sessionDeletionDirectory,
  stageSessionFiles,
  withSessionDeletionDirectory,
} from "./session-delete.ts"
import {
  SESSION_LOCK_HEARTBEAT_MS,
  SESSION_LOCK_STALE_MS,
  SessionStore,
  sessionLockFile,
  sessionLockPid,
  sessionsDir,
} from "./session-store.ts"

export { readTrace } from "./trace-reader.ts"

export interface SessionSummary {
  id: string
  file: string
  cwd: string
  createdAt: string
  /** Last write to the file, in ms since the epoch. */
  updatedAt: number
  /** The first thing the user said, on one line. */
  firstUserText: string
  /** Messages on the current branch. */
  messageCount: number
  title?: string
  searchText: string
}

/**
 * Summaries by file, reused while the file's size and mtime stay the same: /resume completes
 * on every keystroke, and parsing every session file each time would stall typing.
 */
const summaries = new Map<string, { mtimeMs: number; size: number; summary: SessionSummary }>()

/** Stored sessions for a working directory, most recently used first. Unreadable files are skipped. */
export function listSessions(cwd: string, dir = sessionsDir(cwd)): SessionSummary[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl") && !n.endsWith(".trace.jsonl"))
  } catch {
    return []
  }
  const out: SessionSummary[] = []
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const { mtimeMs, size } = statSync(file)
      const cached = summaries.get(file)
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        out.push(cached.summary)
        continue
      }
      const summary = summarize(file, mtimeMs)
      summaries.set(file, { mtimeMs, size, summary })
      out.push(summary)
    } catch {
      // Not a session file, or unreadable; leave it out.
      summaries.delete(file)
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

function summarize(file: string, updatedAt: number): SessionSummary {
  const store = SessionStore.open(file)
  const messages = store.branch().flatMap((e) => (e.type === "message" ? [e.message] : []))
  const first = messages.find((m) => m.role === "user")
  // A blank display names nothing; the message's own text does.
  const shown = first?.role === "user" ? first.display?.text.trim() : undefined
  const text = shown || (first?.content.find((b) => b.type === "text")?.text ?? "")
  return {
    id: store.id,
    file,
    cwd: store.header.cwd,
    createdAt: store.header.createdAt,
    updatedAt,
    firstUserText: text.replace(/\s+/g, " ").trim(),
    messageCount: messages.length,
    ...(store.title ? { title: store.title } : {}),
    searchText: messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" "))
      .join("\n"),
  }
}

/** Substring search also works for languages without word separators. */
export function sessionSnippet(
  text: string,
  query: string,
  radius = 45,
  lowerText = text.toLowerCase(),
): string | undefined {
  const at = lowerText.indexOf(query.toLowerCase())
  if (at < 0) return undefined
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + query.length + radius)
  return `${start ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`
}

/**
 * Deletes only owned files; a fork may still reference the same sub-agent history.
 * Returns the removed session paths so the host can retire their pending trace writes.
 */
export function deleteSession(cwd: string, id: string, currentId?: string, dir = sessionsDir(cwd)): string[] {
  if (id === currentId) throw new Error("the current session cannot be deleted")
  const directory = sessionDeletionDirectory(dir)
  let removed: string[]
  let blockedPath: string | undefined
  try {
    removed = withSessionDeletionDirectory(directory, (root, stage) => {
      // Leases and any deferred cleanup refer only to this verified private namespace.
      const deletionLocks: FileLock[] = []
      const leases: { file: string; identity: BigIntStats; contents: string }[] = []
      const take = (file: string, id: string) => {
        sessionDeletionDirectory(path.dirname(file))
        const recording = lstatSync(file)
        if (!recording.isFile() || recording.isSymbolicLink())
          throw new Error("unsafe session recording symlink or non-file")
        const lease = sessionLockFile(file)
        const relative = path.relative(root, lease)
        if (relative.startsWith("..") || path.isAbsolute(relative))
          throw new Error("unsafe session lease path")
        deletionLocks.push(
          takeDeletionLock(file, id, lease, (guard) => {
            blockedPath = path.join(dir, path.relative(root, guard))
          }),
        )
        leases.push({
          file: lease,
          identity: lstatSync(lease, { bigint: true }),
          contents: readFileSync(lease, "utf8"),
        })
      }
      try {
        const file = findSession(cwd, id, root)
        if (!file) throw new Error(`no session ${id}`)
        take(file, id)
        const owned = (recording: string, tolerateDamage = false): Set<string> => {
          const out = new Set<string>()
          const visit = (name: string) => {
            if (out.has(name)) return
            let entries: SessionStore["entries"]
            try {
              // Every component stays inside the relocated root and must not be a symlink.
              const rel = path.relative(root, path.resolve(name))
              if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("unsafe session path")
              let part = root
              for (const component of rel.split(path.sep)) {
                part = path.join(part, component)
                if (lstatSync(part).isSymbolicLink()) throw new Error("unsafe session symlink")
              }
              out.add(name)
              entries = SessionStore.open(name).entries
            } catch (error) {
              if (!tolerateDamage) throw error
              return
            }
            for (const e of entries) {
              if (e.type !== "subagent") continue
              if (!/^[\w-]+$/.test(e.childSessionId)) {
                if (!tolerateDamage) throw new Error("unsafe sub-agent id")
                continue
              }
              const child = path.join(path.dirname(name), "subagents", `${e.childSessionId}.jsonl`)
              if (existsSync(child)) visit(child)
            }
          }
          visit(recording)
          return out
        }
        const files = owned(file)
        for (const name of readdirSync(root).filter(
          (n) => n.endsWith(".jsonl") && !n.endsWith(".trace.jsonl"),
        )) {
          const other = path.join(root, name)
          if (other === file) continue
          // Damage must not discard valid sharing references discovered elsewhere in this graph.
          for (const name of owned(other, true)) files.delete(name)
        }
        for (const name of files) {
          if (name !== file) take(name, path.basename(name, ".jsonl"))
        }
        stageSessionFiles(files, stage)
        return [...files].map((name) => path.join(dir, path.relative(root, name)))
      } finally {
        for (const lock of deletionLocks.reverse()) lock.release()
        // Sharing failures may defer lease cleanup. Detach only our exact lease image before
        // restoring the public root; retries retain private names, not public deletion authority.
        for (const lease of leases) stage(lease.file, { ...lease, discardOnRollback: true })
      }
    })
  } catch (error) {
    // Classify the public guard only after rollback restored that namespace for inspection.
    if (error instanceof SessionWriteGuardError && blockedPath) throw new SessionWriteGuardError(blockedPath)
    // Windows can refuse relocation while a transient writer still holds its recording fd.
    // Preserve the ownership protocol's busy-gate error without acquiring a public lease.
    const failure = error as NodeJS.ErrnoException
    const gate = `${path.join(directory.directory, `${id}.jsonl`)}.lock.lease-gate`
    if (
      ["EPERM", "EBUSY", "EACCES"].includes(failure.code ?? "") &&
      failure.path === directory.directory &&
      /^[\w-]+$/.test(id) &&
      existsSync(gate)
    )
      throw new SessionWriteGuardError(gate)
    throw error
  }
  for (const name of removed) summaries.delete(name)
  return removed
}

/** The file of a stored session of this working directory, if it exists. */
export function findSession(cwd: string, id: string, dir = sessionsDir(cwd)): string | undefined {
  if (!/^[\w-]+$/.test(id)) return undefined
  const file = path.join(dir, `${id}.jsonl`)
  return existsSync(file) ? file : undefined
}

function takeDeletionLock(
  file: string,
  id: string,
  lease: string,
  remember: (guard: string) => void,
): FileLock {
  const deletionLock = tryFileLock(
    lease,
    SESSION_LOCK_STALE_MS,
    SESSION_LOCK_HEARTBEAT_MS,
    true,
    (ownerPath) => {
      remember(ownerPath)
      throw new SessionWriteGuardError(ownerPath)
    },
  )
  if (!deletionLock) {
    const pid = sessionLockPid(file)
    if (pid !== undefined && pid !== process.pid && isProcessAlive(pid)) {
      throw new Error(
        `cannot delete session ${id}: it is open in another Amira process (pid ${pid}); close that process first`,
      )
    }
    if (pid === process.pid) {
      throw new Error(`cannot delete session ${id}: it is still open in this Amira process`)
    } else {
      // A fresh lock without a readable pid is not safe to interpret as stale. A dead pid should
      // have been taken over by tryFileLock, so reaching this branch means the lease is changing.
      throw new Error(`cannot delete session ${id}: it is currently open; try again after it closes`)
    }
  }
  return deletionLock
}
