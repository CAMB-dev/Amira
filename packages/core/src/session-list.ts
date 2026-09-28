import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { SessionStore, sessionsDir } from "./session-store.ts"

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
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"))
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
  }
}

/** The file of a stored session of this working directory, if it exists. */
export function findSession(cwd: string, id: string, dir = sessionsDir(cwd)): string | undefined {
  if (!/^[\w-]+$/.test(id)) return undefined
  const file = path.join(dir, `${id}.jsonl`)
  return existsSync(file) ? file : undefined
}
