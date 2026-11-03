import type { Message } from "@amira/ai"
import type { StoredSessionInfo, UiControl, UiNode, ViewDefinition } from "@amira/api"
import { messageLines } from "./message-lines.ts"
import type { ViewClient } from "./views.ts"

/** The view kind /sessions opens. */
export const REMOTE_SESSIONS_VIEW = "remote-sessions"
/** Enough for a picker; the daemon pages at most 100 per read. */
const MAX_SESSIONS = 500

interface BrowserData {
  id?: string
  title?: string
}
interface Stored {
  messages?: readonly Message[]
  error?: string
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/**
 * The workspace's stored sessions, opened read-only: only sessions.list and sessions.read, which
 * a viewer may call, so it works in either role and never switches the workspace's session.
 */
export function remoteSessionBrowser(client: Pick<ViewClient, "request">) {
  const reads = new Set<AbortController>()
  let sessions: StoredSessionInfo[] | undefined
  let listError: string | undefined
  const stored = new Map<string, Stored>()
  const read = async <T>(
    view: UiControl,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> => {
    const controller = new AbortController()
    reads.add(controller)
    try {
      return await run(controller.signal)
    } finally {
      reads.delete(controller)
      if (!controller.signal.aborted) view.requestRender()
    }
  }
  const list = (view: UiControl) =>
    read(view, async (signal) => {
      const all: StoredSessionInfo[] = []
      let offset: number | undefined = 0
      while (offset !== undefined && all.length < MAX_SESSIONS) {
        const page: { sessions: StoredSessionInfo[]; nextOffset?: number } = await client.request(
          "sessions.list",
          { offset, limit: 100 },
          { signal },
        )
        all.push(...page.sessions)
        // A page that adds nothing or does not move forward would repeat forever: stop there.
        const next: number | undefined = page.nextOffset
        offset = page.sessions.length && next !== undefined && next > offset ? next : undefined
      }
      sessions = all
      listError = undefined
    }).catch(() => {
      listError = "Stored sessions are unavailable. Reconnect and open /sessions again."
    })
  const open = (id: string, view: UiControl) => {
    if (stored.get(id)?.messages) return
    stored.set(id, {})
    void read(view, async (signal) => {
      const history = await client.request("sessions.read", { id }, { signal })
      stored.set(id, history ? { messages: history.messages } : { error: "That session no longer exists." })
    }).catch(() => stored.set(id, { error: "That session is unavailable. Reconnect and try again." }))
  }
  const view: ViewDefinition<BrowserData> = {
    kind: REMOTE_SESSIONS_VIEW,
    title: () => "Stored sessions (read-only)",
    onOpen: (_data, control) => void list(control),
    onClose() {
      for (const controller of reads) controller.abort()
      reads.clear()
      stored.clear()
      sessions = undefined
    },
    ui(_data, ctx): UiNode {
      const id = (ctx.page?.data as BrowserData | undefined)?.id
      if (id) {
        const entry = stored.get(id)
        const lines = entry?.error
          ? [{ kind: "error" as const, text: entry.error }]
          : entry?.messages
            ? messageLines(entry.messages, ctx)
            : [{ kind: "muted" as const, text: "Loading the stored session…" }]
        const title = (ctx.page?.data as BrowserData | undefined)?.title ?? `Session ${id}`
        return {
          type: "box",
          title: `${title} (read-only)`,
          tone: "accent",
          child: { type: "text", id: `session-${id}`, lines },
        }
      }
      const text = (kind: "error" | "muted", line: string): UiNode => ({
        type: "text",
        lines: [{ kind, text: line }],
      })
      const content: UiNode = listError
        ? text("error", listError)
        : !sessions
          ? text("muted", "Loading stored sessions…")
          : !sessions.length
            ? text("muted", "No stored sessions in this workspace.")
            : {
                type: "tree",
                id: "sessions",
                items: sessions.map((session) => ({
                  key: session.id,
                  row: [{ kind: "text", text: session.title || session.firstUserText || "(empty)" }],
                  aside: [
                    {
                      kind: "muted",
                      text: `${ago(session.updatedAt, ctx.now)} ${ctx.glyphs?.separator ?? "·"} ${session.messageCount} msgs`,
                    },
                  ],
                })),
              }
      // Read-only on purpose: opening one never switches the workspace's session.
      return { type: "box", title: "Stored sessions (read-only)", tone: "accent", child: content }
    },
    onEvent(event, _data, control) {
      if (event.type !== "activate" || event.id !== "sessions") return
      const session = sessions?.find((item) => item.id === event.key)
      control.pushPage({ data: { id: event.key, title: session?.title || `Session ${event.key}` } })
      open(event.key, control)
    },
    follow: false,
  }
  return Object.assign(view, {
    dispose() {
      view.onClose?.({})
    },
  })
}
