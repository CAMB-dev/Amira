import {
  type AnyEvent,
  clip,
  type ExtensionAPI,
  type Message,
  plural,
  type SubagentInfo,
  serverToolView,
  subagentStateText,
  DEFAULT_THEME_GLYPHS as symbols,
  type ToolCallView,
  type ToolResult,
  type ToolResultMessage,
  textCells,
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

function toolLines(name: string, call: ToolCallView, opts: ViewRenderOptions, last: boolean): ViewLine[] {
  if (opts.renderTool) return opts.renderTool(name, call, opts.toolDetail ?? "summary", { last })
  const summary = summarizeArgs(call.args)
  const rows = call.text.trim().split("\n")
  const mark = call.rejected
    ? symbols.toolInterrupted
    : call.result.isError
      ? symbols.toolFailed
      : symbols.toolDone
  const result = `${mark} ${rows[0] || "no output"}${rows.length > 1 ? ` (+${plural(rows.length - 1, "line")})` : ""}`
  const head = `  ${last ? symbols.treeLast : symbols.treeBranch} ${name}${summary ? ` ${summary}` : ""}`
  if (textCells(head) + 2 + textCells(result) <= opts.width)
    return [{ kind: "text", text: `${head}  ${result}` }]
  return [
    { kind: "text", text: head },
    { kind: "muted", text: `  ${last ? " " : symbols.treePipe}  ${result}` },
  ]
}

function replyLines(text: string, opts: ViewRenderOptions): ViewLine[] {
  return (
    opts.renderReply?.(text) ??
    text
      .trim()
      .split("\n")
      .map((row) => ({ kind: "text", text: row ? symbols.assistant + row : "" }))
  )
}

/** A child's own transcript, omitting the parent history copied into a fork. */
function transcriptLines(
  info: SubagentInfo,
  messages: readonly Message[],
  kids: SubagentInfo[],
  opts: ViewRenderOptions,
  started: ReadonlyMap<string, { startedAt: number; partial?: ToolResult }>,
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
  const blocks = own.flatMap((message) =>
    message.role === "assistant"
      ? message.content.filter(
          (block) =>
            block.type === "toolCall" ||
            block.type === "serverTool" ||
            (block.type === "text" && block.text.trim()),
        )
      : [],
  )
  let pending: { name: string; call: ToolCallView; last: boolean }[] = []
  const flush = () => {
    if (!pending.length) return
    out.push(
      ...(opts.renderTools?.(pending, opts.toolDetail ?? "summary", { last: pending.at(-1)!.last }) ??
        pending.flatMap(({ name, call, last }) => toolLines(name, call, opts, last))),
    )
    pending = []
  }
  const finished = (name: string, call: ToolCallView, last: boolean) => {
    pending.push({ name, call, last })
  }
  let previous: "tool" | "reply" | "user" = "user"
  for (const [index, block] of blocks.entries()) {
    const kind = block.type === "text" ? "reply" : "tool"
    if (kind === "reply") flush()
    if (kind !== "tool" || previous !== "tool") out.push({ kind: "text", text: "" })
    previous = kind
    const next = blocks[index + 1]
    const last = !next || next.type === "text"
    if (block.type === "text") {
      out.push(...replyLines(block.text, opts))
    } else if (block.type === "serverTool") {
      if (block.status === "running" && live(info)) {
        flush()
        out.push(
          ...(opts.renderRunningTool?.(
            block.name,
            { args: block.input, ...started.get(block.id) },
            { last },
          ) ?? [
            {
              kind: "text",
              text: `  ${last ? symbols.treeLast : symbols.treeBranch} ${block.name}  running`,
            },
          ]),
        )
      } else finished(block.name, serverToolView(block), last)
    } else if (block.type === "toolCall") {
      const result = results.get(block.id)
      if (result) {
        finished(
          block.name,
          {
            args: block.args,
            result: { content: result.content, isError: result.isError },
            text: toolResultText(result),
            ...(result.rejected ? { rejected: result.rejected } : {}),
          },
          last,
        )
      } else if (live(info)) {
        flush()
        out.push(
          ...(opts.renderRunningTool?.(
            block.name,
            { args: block.args, ...started.get(block.id) },
            { last },
          ) ?? [
            {
              kind: "text",
              text: `  ${last ? symbols.treeLast : symbols.treeBranch} ${block.name}${summarizeArgs(block.args) ? ` ${summarizeArgs(block.args)}` : ""}  running`,
            },
          ]),
        )
      } else {
        finished(
          block.name,
          {
            args: block.args,
            result: { content: [], isError: true },
            text: "no result",
            rejected: "aborted",
          },
          last,
        )
      }
      if (block.name === "agent") {
        flush()
        for (const kid of callKids(rest, block))
          out.push(kidLine(kid, `  ${last ? " " : symbols.treePipe}  `))
      }
    }
  }
  flush()
  const tail = out.at(-1)
  if (tail?.kind !== "text" || tail.text !== "") out.push({ kind: "text", text: "" })
  for (const kid of rest) out.push(kidLine(kid, ""))
  if (rest.length) out.push({ kind: "text", text: "" })
  return out
}

/** Live child state belongs to the extension; the frontend owns input, scrolling and dialogs. */
export function subagentView(api: ExtensionAPI): ViewDefinition<SubagentData> {
  const streams = new Map<string, Streaming>()
  const started = new Map<string, { startedAt: number; partial?: ToolResult }>()
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
        case "tool.execute.start":
          started.set(event.data.toolCallId, { startedAt: event.ts })
          if (started.size > 128) started.delete(started.keys().next().value!)
          break
        case "tool.execute.update":
          started.set(event.data.toolCallId, {
            ...started.get(event.data.toolCallId),
            startedAt: started.get(event.data.toolCallId)?.startedAt ?? event.ts,
            partial: event.data.partial,
          })
          if (started.size > 128) started.delete(started.keys().next().value!)
          break
        case "tool.execute.end":
          started.delete(event.data.toolCallId)
          break
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
    let changed = false
    if (
      (event.type === "session.start" || event.type === "session.end") &&
      event.parentSessionId === undefined
    ) {
      changed = streams.size > 0
      streams.clear()
      started.clear()
    }
    if (event.type === "subagent.end") streams.delete(event.data.childSessionId)
    if (
      event.parentSessionId !== undefined ||
      event.type === "subagent.start" ||
      event.type === "subagent.end" ||
      event.type === "subagent.state" ||
      changed
    )
      api.requestRender()
  }
  api.on("tool.execute.start", onEvent)
  api.on("tool.execute.update", onEvent)
  api.on("tool.execute.end", onEvent)
  api.on("message.start", onEvent)
  api.on("message.delta", onEvent)
  api.on("message.end", onEvent)
  api.on("turn.end", onEvent)
  api.on("subagent.start", onEvent)
  api.on("subagent.end", onEvent)
  api.on("subagent.state", onEvent)
  api.on("ui.request", onEvent)
  api.on("ui.resolved", onEvent)
  api.on("session.start", onEvent)
  api.on("session.end", onEvent)
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
        started,
      )
      const stream = streams.get(info.id)
      if (stream?.text.trim()) out.push(...replyLines(stream.text, opts), { kind: "text", text: "" })
      // The view's title already owns live state; do not duplicate it in the transcript.
      if (!live(info)) {
        if (info.error && info.status !== "done")
          out.push({ kind: "error", text: `${symbols.error} ${info.error}` })
        else if (info.note && info.status !== "done")
          out.push({
            kind: "muted",
            text: `${symbols.interrupted} ${subagentStateText(info.status)}: ${info.note}`,
          })
        else out.push({ kind: "muted", text: `── ${subagentStateText(info.status)} ──` })
      }
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
