import {
  type AnyEvent,
  clip,
  type ExtensionAPI,
  type Message,
  type SubagentInfo,
  serverToolView,
  subagentStateText,
  type ToolCallView,
  type ToolResultMessage,
  toolResultText,
  type ViewDefinition,
  type ViewKey,
  type ViewLine,
  type ViewRenderOptions,
  type ViewSegment,
} from "@amira/api"
import { callKids, elapsed, transcriptText, usageText } from "./agents-command.ts"

interface SubagentData {
  sessionId: string
}

interface Streaming {
  text: string
  thinking: boolean
}

function live(info: SubagentInfo): boolean {
  return (
    info.status === "running" ||
    info.status === "queued" ||
    info.status === "idle" ||
    info.status === "paused"
  )
}

function stats(info: SubagentInfo, now: number): ViewSegment[] {
  const timed = info.durationMs !== undefined || info.startedAt !== undefined
  const when = info.status === "queued" || !timed ? "" : ` · ${elapsed(info, now)}`
  return [
    { kind: statusKind(info), text: subagentStateText(info.status) },
    { kind: "muted", text: `${when} · ${usageText(info)}` },
  ]
}

function statusKind(info: SubagentInfo): ViewSegment["kind"] {
  switch (info.status) {
    case "running":
      return "accent"
    case "done":
      return "success"
    case "error":
      return "error"
    case "aborted":
      return "warning"
    default:
      return "muted"
  }
}

function blockText(message: Message): string {
  return message.content
    .map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : ""))
    .join("\n")
}

/** The same argument priorities as the frontend's generic tool summary. */
function summarizeArgs(args: Record<string, unknown>): string {
  const primary = ["path", "file_path", "filePath", "command", "pattern", "url", "query", "prompt", "name"]
  const scalars = Object.entries(args).filter(
    ([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  )
  let lead = scalars.findIndex(([k]) => primary.includes(k))
  if (lead === -1) lead = scalars.findIndex(([, v]) => typeof v === "string")
  const oneLine = (v: unknown) => String(v).replace(/\s+/g, " ").trim()
  const parts = scalars.flatMap(([k, v], i) => (i === lead ? [] : [`${k}=${clip(oneLine(v), 24)}`]))
  if (lead !== -1) parts.unshift(oneLine(scalars[lead]![1]))
  return clip(parts.join(" · "), 80)
}

function toolLines(name: string, call: ToolCallView, opts: ViewRenderOptions): ViewLine[] {
  if (opts.renderTool) return opts.renderTool(name, call, "summary")
  const summary = summarizeArgs(call.args)
  const rows = call.text.split("\n")
  return [
    {
      kind: call.result.isError ? "error" : "accent",
      text: `${call.result.isError ? "✗" : "●"} ${name}${summary ? ` ${summary}` : ""}`,
    },
    {
      kind: "muted",
      text: `  └ ${clip(rows[0] || "no output", opts.width - 4)}${rows.length > 1 ? ` (+${rows.length - 1} lines)` : ""}`,
    },
  ]
}

/** A child's own transcript, omitting the parent history copied into a fork. */
function transcriptLines(
  info: SubagentInfo,
  messages: readonly Message[],
  kids: SubagentInfo[],
  opts: ViewRenderOptions,
): ViewLine[] {
  const own = messages.slice(
    Math.max(
      0,
      messages.findLastIndex((m) => m.role === "user"),
    ),
  )
  const first = own[0]
  const task = first?.role === "user" ? (first.display?.text || blockText(first)).trim() : info.task
  const out: ViewLine[] = [
    {
      kind: "user-message",
      text: task || "(no task)",
      ...(first?.role === "user" && first.display?.note ? { note: first.display.note } : {}),
    },
    { kind: "text", text: "" },
  ]
  const results = new Map<string, ToolResultMessage>()
  for (const message of own) if (message.role === "toolResult") results.set(message.toolCallId, message)
  const rest = [...kids]
  const kidLine = (kid: SubagentInfo, indent: string): ViewLine => ({
    kind: "segments",
    parts: [
      { kind: "text", text: indent },
      { kind: "accent", text: "◆" },
      { kind: "text", text: ` ${kid.title} ` },
      { kind: "muted", text: `· ${kid.role} · ${kid.id}` },
      { kind: "text", text: " " },
      ...stats(kid, opts.now),
      { kind: "text", text: " " },
      { kind: "muted", text: `· ${kid.task.replace(/\s+/g, " ").trim()}` },
    ],
  })
  for (const message of own) {
    if (message.role !== "assistant") continue
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) {
        out.push(
          ...block.text
            .trim()
            .split("\n")
            .map((text): ViewLine => ({ kind: "text", text })),
          { kind: "text", text: "" },
        )
      } else if (block.type === "serverTool") {
        out.push(...toolLines(block.name, serverToolView(block), opts), { kind: "text", text: "" })
      } else if (block.type === "toolCall") {
        const result = results.get(block.id)
        if (result) {
          const call: ToolCallView = {
            args: block.args,
            result: { content: result.content, isError: result.isError },
            text: toolResultText(result),
            ...(result.rejected ? { rejected: result.rejected } : {}),
          }
          out.push(...toolLines(block.name, call, opts))
        } else {
          const summary = summarizeArgs(block.args)
          out.push(
            { kind: "accent", text: clip(`● ${block.name}${summary ? ` ${summary}` : ""}`, opts.width) },
            { kind: "muted", text: `  └ ${live(info) ? "running" : "no result"}` },
          )
        }
        if (block.name === "agent") for (const kid of callKids(rest, block)) out.push(kidLine(kid, "  "))
        out.push({ kind: "text", text: "" })
      }
    }
  }
  for (const kid of rest) out.push(kidLine(kid, ""))
  if (rest.length) out.push({ kind: "text", text: "" })
  return out
}

/** Live child state belongs to the extension; the frontend owns input, scrolling and dialogs. */
export function subagentView(api: ExtensionAPI): ViewDefinition<SubagentData> {
  const streams = new Map<string, Streaming>()
  let shown: SubagentData | undefined
  const infoFor = (data: SubagentData) =>
    api
      .session()
      ?.subagents()
      .find((s) => s.id === data.sessionId)
  const remember = (id: string, stream: Streaming) => {
    streams.set(id, stream)
    // Keep transient state bounded, even if a child never delivers its final event.
    if (streams.size > 128) streams.delete(streams.keys().next().value!)
  }
  const onEvent = (event: AnyEvent) => {
    if (event.parentSessionId !== undefined) {
      switch (event.type) {
        case "message.start":
          remember(event.sessionId, { text: "", thinking: false })
          break
        case "message.delta": {
          const stream = streams.get(event.sessionId) ?? { text: "", thinking: false }
          if (event.data.kind === "text") {
            stream.text += event.data.text
            stream.thinking = false
          } else if (event.data.kind === "thinking") stream.thinking = true
          remember(event.sessionId, stream)
          break
        }
        case "message.end":
        case "turn.end":
          streams.delete(event.sessionId)
          break
      }
    }
    if (event.type === "subagent.end") streams.delete(event.data.childSessionId)
    api.requestRender()
  }
  api.on("message.start", onEvent)
  api.on("message.delta", onEvent)
  api.on("message.end", onEvent)
  api.on("turn.end", onEvent)
  api.on("subagent.start", onEvent)
  api.on("subagent.end", onEvent)
  api.on("subagent.state", onEvent)
  api.on("ui.request", onEvent)
  api.on("ui.resolved", onEvent)
  api.on("session.start", (event) => {
    if (event.parentSessionId === undefined) streams.clear()
  })
  api.on("session.end", (event) => {
    if (event.parentSessionId === undefined) streams.clear()
  })
  const switchTo = (data: SubagentData, step: number) => {
    const list = api.session()?.subagents() ?? []
    if (!list.length) return
    const index = list.findIndex((s) => s.id === data.sessionId)
    data.sessionId = list[(index + step + list.length) % list.length]!.id
  }
  const navigation: ViewKey<SubagentData>[] = [
    { key: "left", label: "switch", run: (data) => switchTo(data, -1) },
    { key: "right", label: "switch", run: (data) => switchTo(data, 1) },
    // Tab and Shift+Tab switch too, without a footer item of their own.
    { key: "tab", label: "", run: (data) => switchTo(data, 1) },
    { key: "shift-tab", label: "", run: (data) => switchTo(data, -1) },
  ]
  return {
    kind: "subagent",
    scrollKey: (data) => data.sessionId,
    title(data, opts) {
      shown = data
      const info = infoFor(data)
      // What it is and how it goes first; its role and id are cut first on a narrow screen.
      return info
        ? {
            kind: "segments",
            parts: [
              { kind: "accent", text: "◆" },
              { kind: "text", text: ` ${info.title} ` },
              { kind: "muted", text: "·" },
              { kind: "text", text: " " },
              ...stats(info, opts.now),
              { kind: "muted", text: ` · ${info.role} · ${info.id}` },
            ],
          }
        : { kind: "warning", text: `No sub-agent ${data.sessionId} in this session.` }
    },
    titleAside(data) {
      const list = api.session()?.subagents() ?? []
      const index = list.findIndex((s) => s.id === data.sessionId)
      return index < 0 ? "" : `${index + 1} of ${list.length}`
    },
    header(data, opts) {
      const info = infoFor(data)
      return info
        ? [{ kind: "muted", text: clip(`task: ${info.task.replace(/\s+/g, " ").trim()}`, opts.width) }]
        : []
    },
    render(data, opts) {
      const session = api.session()
      const list = session?.subagents() ?? []
      const info = list.find((s) => s.id === data.sessionId)
      if (!info) return []
      const out = transcriptLines(
        info,
        session?.subagentMessages(info.id) ?? [],
        list.filter((s) => s.parentSessionId === info.id),
        opts,
      )
      const stream = streams.get(info.id)
      if (stream?.text.trim())
        out.push(
          ...stream.text
            .trim()
            .split("\n")
            .map((text): ViewLine => ({ kind: "text", text })),
          { kind: "text", text: "" },
        )
      if (live(info)) {
        const what =
          info.status === "queued"
            ? "waiting for a free slot"
            : info.status === "idle"
              ? "idle, waiting for a message"
              : info.status === "paused"
                ? "paused"
                : stream?.thinking
                  ? "thinking"
                  : "working"
        out.push({ kind: "muted", text: `… ${what}` })
      } else if (info.error && info.status !== "done") out.push({ kind: "error", text: `✗ ${info.error}` })
      else if (info.note && info.status !== "done")
        out.push({ kind: "muted", text: `⊘ ${subagentStateText(info.status)}: ${info.note}` })
      else out.push({ kind: "muted", text: `── ${subagentStateText(info.status)} ──` })
      return out
    },
    get keys() {
      const info = shown && infoFor(shown)
      return [
        ...navigation,
        ...(info && live(info)
          ? [
              {
                key: "x",
                label: "stop",
                run: (data: SubagentData, view) => {
                  const target = infoFor(data)
                  if (!target || !live(target)) return
                  void view
                    .confirm(`Stop ${target.title} (${target.role} ${target.id})?`, {
                      yes: "stops it",
                      no: "keeps it running",
                    })
                    .then((yes) => {
                      if (yes) api.session()?.stopSubagent(target.id)
                      view.requestRender()
                    })
                },
              } satisfies ViewKey<SubagentData>,
            ]
          : []),
        {
          key: "p",
          label: "print",
          run: (data: SubagentData, view) => {
            const session = api.session()
            const list = session?.subagents() ?? []
            const info = list.find((s) => s.id === data.sessionId)
            if (!info) return
            const text = transcriptText(info, session?.subagentMessages(info.id) ?? [], list)
            view.close()
            view.print(text)
          },
        } satisfies ViewKey<SubagentData>,
      ]
    },
  }
}
