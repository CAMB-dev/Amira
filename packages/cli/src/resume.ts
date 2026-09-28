import { createInterface } from "node:readline/promises"
import { findSession, listSessions, SessionStore, type SessionSummary } from "@amira/core"
import { UsageError } from "./args.ts"

export interface StoreChoice {
  store: SessionStore
  resumed: boolean
}

/** Picks the session store for --continue, --resume <id>, or a fresh session. */
export function chooseStore(opts: { cwd: string; continue: boolean; resume?: string }): StoreChoice {
  if (opts.continue) {
    const latest = listSessions(opts.cwd)[0]
    if (!latest) throw new UsageError(`no session to continue in ${opts.cwd}`)
    return { store: SessionStore.open(latest.file), resumed: true }
  }
  if (opts.resume) {
    const file = findSession(opts.cwd, opts.resume)
    if (!file) throw new UsageError(`no session ${opts.resume} in ${opts.cwd}; run amira -r to list them`)
    return { store: SessionStore.open(file), resumed: true }
  }
  return { store: SessionStore.create({ cwd: opts.cwd }), resumed: false }
}

/** One numbered line per session: when, how long, id and the first thing the user said. */
export function formatSessionList(sessions: SessionSummary[], width = 100): string {
  return sessions
    .map((s, i) => {
      const when = new Date(s.updatedAt).toLocaleString("sv").slice(0, 16)
      const head = `${String(i + 1).padStart(3)}. ${when}  ${String(s.messageCount).padStart(4)} msgs  ${s.id}  `
      const room = Math.max(10, width - head.length)
      const text = s.firstUserText.length > room ? `${s.firstUserText.slice(0, room - 1)}…` : s.firstUserText
      return `${head}${text}`
    })
    .join("\n")
}

/** Shows the list and reads a number from the terminal. Undefined when the user picks nothing. */
export async function pickSession(sessions: SessionSummary[]): Promise<SessionSummary | undefined> {
  process.stdout.write(`${formatSessionList(sessions, process.stdout.columns || 100)}\n\n`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question("Resume which session? (number, Enter to cancel) ")).trim()
    const n = Number(answer)
    return Number.isInteger(n) && n >= 1 ? sessions[n - 1] : undefined
  } finally {
    rl.close()
  }
}
