import type { Message } from "@amira/ai"
import type { ViewControl, ViewDefinition, ViewLine } from "@amira/api"
import type { FrontendExecuteOptions } from "@amira/core"
import type { ServerOperations } from "../server/operations.ts"
import type { RemoteAgentPort } from "./agent-port.ts"

interface ViewClient extends Pick<RemoteAgentPort, "subscribeWorkspace" | "snapshot"> {
  request<K extends keyof ServerOperations>(
    operation: K,
    params: ServerOperations[K]["params"],
    options?: FrontendExecuteOptions,
  ): Promise<ServerOperations[K]["result"]>
}
interface ViewData {
  id?: string
  sessionId?: string
  incarnation?: string
}
const id = (data: ViewData) => data.id ?? data.sessionId ?? ""
interface Page {
  text: string
  messages: readonly Message[]
  error?: string
  refresh(): void
  dispose(): void
}

/** Host-owned, builtin-only views. Data is read through scoped DTO operations, never executable handles. */
export function createRemoteViews(client: ViewClient) {
  const pages = new Map<ViewData, Page>()
  function mount(
    data: ViewData,
    view: Pick<ViewControl, "requestRender">,
    kind: "background-job" | "subagent",
  ) {
    const end = new AbortController()
    const sessionGeneration = client.snapshot.sessionGeneration
    const options = { signal: end.signal, sessionGeneration }
    let busy = false
    let again = false
    let from = 0
    const page: Page = {
      text: "",
      messages: [],
      refresh() {
        if (end.signal.aborted) return
        if (client.snapshot.sessionGeneration !== sessionGeneration) {
          page.dispose()
          return
        }
        if (busy) {
          again = true
          return
        }
        busy = true
        void (async () => {
          if (kind === "background-job") {
            const output = await client.request(
              "jobs.output",
              { id: id(data), from, maxChars: 32768 },
              options,
            )
            if (end.signal.aborted) return
            page.text =
              `${output.dropped ? "[Earlier output omitted]\n" : ""}${page.text}${output.text}`.slice(-65536)
            from = output.to
            again ||= output.truncated
          } else {
            const messages: Message[] = []
            let offset = 0
            let snapshot: string | undefined
            do {
              const result = await client.request(
                "conversations.history",
                {
                  conversationId: id(data),
                  incarnation: data.incarnation,
                  snapshot,
                  offset,
                  limit: 100,
                },
                options,
              )
              if (end.signal.aborted) return
              messages.push(...result.messages)
              snapshot = result.snapshot
              offset = result.nextOffset ?? -1
            } while (offset >= 0)
            page.messages = messages
          }
          page.error = undefined
        })()
          .catch(() => {
            if (!end.signal.aborted) page.error = "Remote view unavailable. Reconnect and reopen it."
          })
          .finally(() => {
            busy = false
            if (!end.signal.aborted) {
              view.requestRender()
              if (again) {
                again = false
                page.refresh()
              }
            }
          })
      },
      dispose() {
        end.abort()
        off()
        pages.delete(data)
      },
    }
    const off = client.subscribeWorkspace((update) => {
      if (
        "kind" in update
          ? update.kind === "jobs" || update.kind === "semantic"
          : ["message.end", "turn.end", "tool.execute.end"].includes(update.type)
      )
        page.refresh()
    })
    pages.set(data, page)
    page.refresh()
  }
  const job: ViewDefinition<ViewData> = {
    kind: "background-job",
    title: (data) => `Remote job ${id(data)}`,
    onOpen: (data, view) => mount(data, view, "background-job"),
    onClose: (data) => pages.get(data)?.dispose(),
    render: (data) => {
      const page = pages.get(data)
      return (page?.error ?? page?.text ?? "Loading remote output…")
        .split("\n")
        .map((text) => ({ kind: "code", text }))
    },
    keys: [
      {
        key: "s",
        label: "stop",
        run: (data, view) => {
          const sessionGeneration = client.snapshot.sessionGeneration
          void view
            .confirm("Stop this remote job?", { yes: "stops it", no: "keeps it running" })
            .then(async (yes) => {
              if (!yes) return
              await client.request("jobs.stop", { id: id(data) }, { sessionGeneration })
              pages.get(data)?.refresh()
            })
            .catch(() => view.print("Unable to stop the remote job. Reconnect and try again.", "error"))
        },
      },
    ],
  }
  const conversation: ViewDefinition<ViewData> = {
    kind: "subagent",
    title: (data) => `Remote conversation ${id(data)}`,
    onOpen: (data, view) => mount(data, view, "subagent"),
    onClose: (data) => pages.get(data)?.dispose(),
    render(data, options) {
      const page = pages.get(data)
      if (page?.error) return [{ kind: "error", text: page.error }]
      if (!page) return [{ kind: "muted", text: "Loading remote conversation…" }]
      const lines: ViewLine[] = []
      for (const message of page.messages) {
        if (message.role === "toolResult") continue
        const text = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
        if (message.role === "user") lines.push({ kind: "user-message", text: message.display?.text ?? text })
        else {
          lines.push(...(options.renderReply?.(text) ?? [{ kind: "text" as const, text }]))
          for (const call of message.content) {
            if (call.type !== "toolCall") continue
            const result = page.messages.find(
              (item) => item.role === "toolResult" && item.toolCallId === call.id,
            )
            if (result?.role === "toolResult")
              lines.push(
                ...(options.renderTool?.(
                  call.name,
                  {
                    args: call.args,
                    text: result.content
                      .filter((block) => block.type === "text")
                      .map((block) => block.text)
                      .join("\n"),
                    result: { content: result.content, isError: result.isError, details: result.details },
                  },
                  options.toolDetail ?? "summary",
                ) ?? [{ kind: "text" as const, text: call.name }]),
              )
          }
        }
      }
      return lines
    },
    follow: true,
  }
  return {
    get(kind: string) {
      return kind === job.kind ? job : kind === conversation.kind ? conversation : undefined
    },
    dispose() {
      for (const page of pages.values()) page.dispose()
    },
  }
}
