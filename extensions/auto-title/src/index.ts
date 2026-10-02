import { defineExtension, type ExtensionAPI, type Message } from "@amira/api"

const TITLE_MAX_CHARS = 60
const TITLE_SYSTEM =
  "Give this conversation a short title, at most six words, in the user's language. Return only the title, without quotes or punctuation around it."

export default defineExtension((api: ExtensionAPI) => {
  /**
   * Per session: whether it may still be titled. Decided once per agent, when its session
   * starts (or, without a session.start, at its first turn): one that already has replies
   * (resumed, forked) never asks; the first successful turn of a new one asks once.
   */
  const pending = new Map<string, boolean>()
  let inFlight:
    | {
        sessionId: string
        abort: AbortController
        timer: ReturnType<typeof setTimeout>
      }
    | undefined
  const isCurrent = (event: { sessionId: string; parentSessionId?: string }) =>
    !event.parentSessionId && event.sessionId === api.session()?.info().id

  api.on("session.start", (event) => {
    if (!isCurrent(event)) return
    pending.set(event.sessionId, !api.session()?.replies().length)
  })

  api.on("turn.start", (event) => {
    if (!isCurrent(event) || pending.has(event.sessionId)) return
    pending.set(event.sessionId, !api.session()?.replies().length)
  })

  api.on("session.end", (event) => {
    if (inFlight?.sessionId !== event.sessionId) return
    inFlight.abort.abort()
  })

  api.on("turn.end", (event) => {
    if (event.data.reason !== "done" || !isCurrent(event)) return
    const session = api.session()
    if (!session) return
    const sessionId = event.sessionId
    if (!pending.get(sessionId)) return
    // Not marked as asked: a session titled by hand and cleared again may still be titled.
    if (!session.info().file || session.info().title || api.settings.sessions?.autoTitle === false) return
    pending.set(sessionId, false)
    const transcript = session
      .messages()
      .filter(
        (message): message is Extract<Message, { role: "user" | "assistant" }> =>
          message.role === "user" || message.role === "assistant",
      )
      .map(
        (message) =>
          `${message.role}: ${message.content
            .flatMap((block) =>
              block.type === "text"
                ? [block.text]
                : block.type === "image"
                  ? [`[image${block.name ? `: ${block.name}` : ""}]`]
                  : [],
            )
            .join("")}`,
      )
      .join("\n")
      .slice(0, 8000)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 30_000)
    ;(timer as { unref?: () => void }).unref?.()
    const request = { sessionId, abort, timer }
    inFlight = request
    void (async () => {
      try {
        const result = await api.complete({
          ...(api.settings.compact?.model ? { model: api.settings.compact.model } : {}),
          system: TITLE_SYSTEM,
          messages: [{ role: "user", content: [{ type: "text", text: transcript }] }],
          maxTokens: 64,
          signal: abort.signal,
          label: "session title",
        })
        const title = result.text
          .trim()
          .replace(/^["'`]+|["'`]+$/g, "")
          .split(/\s+/)
          .slice(0, 6)
          .join(" ")
        const short = [...title].slice(0, TITLE_MAX_CHARS).join("")
        if (short) api.session()?.rename?.(short, { source: "auto", sessionId })
      } catch {
        // Naming is optional; a failed side request never interrupts conversation.
      } finally {
        clearTimeout(timer)
        if (inFlight === request) inFlight = undefined
      }
    })()
  })
})
