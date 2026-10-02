import { existsSync, lstatSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs"
import path from "node:path"
import { type FileLock, isProcessAlive, tryFileLock } from "./file-lock.ts"
import { fileHistoryDir } from "./file-rewind.ts"
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
  const file = findSession(cwd, id, dir)
  if (!file) throw new Error(`no session ${id}`)
  const deletionLock: FileLock | undefined = tryFileLock(
    sessionLockFile(file),
    SESSION_LOCK_STALE_MS,
    SESSION_LOCK_HEARTBEAT_MS,
  )
  if (!deletionLock) {
    const pid = sessionLockPid(file)
    if (pid !== undefined && pid !== process.pid && isProcessAlive(pid)) {
      throw new Error(
        `cannot delete session ${id}: it is open in another Amira process (pid ${pid}); close that process first`,
      )
    }
    if (pid === process.pid) {
      // This process may still hold a lease for a session it switched away from. The public
      // currentId check above still protects the active one; no other process can be racing it.
    } else {
      // A fresh lock without a readable pid is not safe to interpret as stale. A dead pid should
      // have been taken over by tryFileLock, so reaching this branch means the lease is changing.
      throw new Error(`cannot delete session ${id}: it is currently open; try again after it closes`)
    }
  }
  try {
    const owned = (root: string): Set<string> => {
      const out = new Set<string>()
      const visit = (name: string) => {
        if (out.has(name)) return
        // Every path component stays within the session directory and must not be a symlink.
        const rel = path.relative(path.resolve(dir), path.resolve(name))
        if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("unsafe session path")
        let part = path.resolve(dir)
        if (lstatSync(part).isSymbolicLink()) throw new Error("unsafe session directory")
        for (const component of rel.split(path.sep)) {
          part = path.join(part, component)
          if (lstatSync(part).isSymbolicLink()) throw new Error("unsafe session symlink")
        }
        out.add(name)
        for (const e of SessionStore.open(name).entries) {
          if (e.type !== "subagent") continue
          if (!/^[\w-]+$/.test(e.childSessionId)) throw new Error("unsafe sub-agent id")
          const child = path.join(path.dirname(name), "subagents", `${e.childSessionId}.jsonl`)
          if (existsSync(child)) visit(child)
        }
      }
      visit(root)
      return out
    }
    const files = owned(file)
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl") && !n.endsWith(".trace.jsonl"))) {
      const other = path.join(dir, name)
      if (other === file) continue
      let shared: Set<string>
      try {
        shared = owned(other)
      } catch {
        // A damaged or foreign file elsewhere is no reason to refuse; it shares nothing readable.
        continue
      }
      for (const name of shared) files.delete(name)
    }
    // Attachments are inline in message entries; there are no separate attachment files.
    for (const name of [...files].reverse()) {
      // Its assets (captured file bytes, saved artifacts) first: a failure leaves the recording,
      // so deleting again finishes.
      const assets = path.dirname(fileHistoryDir(name))
      for (const part of [assets, ...["files", "outputs"].map((n) => path.join(assets, n))]) {
        if (lstatOrUndefined(part)?.isSymbolicLink()) throw new Error("unsafe session asset symlink")
      }
      rmSync(assets, { recursive: true, force: true, maxRetries: 3 })
      rmSync(`${name}.trace.jsonl`, { force: true })
      unlinkSync(name)
      summaries.delete(name)
    }
    return [...files]
  } finally {
    deletionLock?.release()
  }
}

/** The file of a stored session of this working directory, if it exists. */
export function findSession(cwd: string, id: string, dir = sessionsDir(cwd)): string | undefined {
  if (!/^[\w-]+$/.test(id)) return undefined
  const file = path.join(dir, `${id}.jsonl`)
  return existsSync(file) ? file : undefined
}

function lstatOrUndefined(file: string) {
  try {
    return lstatSync(file)
  } catch {
    return undefined
  }
}
