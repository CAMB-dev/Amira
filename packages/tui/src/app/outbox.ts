// Owns queued and steering messages, interrupt flushing and the pending-notice strip.
import type { UserMessage } from "@amira/api"
import { type Agent, AgentBusyError } from "@amira/core"
import {
  type Editor,
  type EditorPart,
  type Spinner,
  type Theme,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { userLines, userText } from "../format.ts"
import { glyphs } from "../glyphs.ts"
import { imageBytes, MAX_IMAGE_BYTES } from "../image-input.ts"
import type { TranscriptView } from "../view.ts"
import type { TurnActivity } from "./activity.ts"
import { DOUBLE_ESC_MS } from "./startup.ts"

/** A message on its way: the text the model gets, and what the transcript shows when that differs. */
export interface Outgoing {
  text: string
  /** The text with folded pastes as their placeholders. */
  display?: string
  /** When it was typed, among the messages of this run: steering and queued ones merge in this order. */
  seq?: number
  content?: UserMessage["content"]
  parts?: EditorPart[]
}

export function outgoing(text: string, display: string | undefined): Outgoing {
  const shown = display?.trim()
  return shown && shown !== text ? { text, display: shown } : { text }
}

/** What to hand the agent: the text, or a message that shows its placeholders (MessageDisplay). */
export function toPrompt(o: Outgoing): string | UserMessage {
  if (o.content) return { role: "user", content: o.content, display: { text: o.display ?? o.text } }
  if (!o.display) return o.text
  return { role: "user", content: [{ type: "text", text: o.text }], display: { text: o.display } }
}

export function messageParts(m: UserMessage): EditorPart[] {
  return m.content.map((b) =>
    b.type === "text"
      ? b.text
      : {
          image: {
            name: b.name ?? `image.${b.mimeType.split("/")[1] ?? "png"}`,
            mimeType: b.mimeType,
            data: b.data,
          },
        },
  )
}

export function draftMessage(text: string, display: string | undefined, parts: EditorPart[]): Outgoing {
  if (!parts.some((p) => typeof p !== "string" && "image" in p)) return outgoing(text, display)
  const content = parts.flatMap<UserMessage["content"][number]>((p) =>
    typeof p === "string"
      ? [{ type: "text" as const, text: p }]
      : "paste" in p
        ? [{ type: "text" as const, text: p.paste }]
        : [{ type: "image" as const, ...p.image }],
  )
  return { text: userText({ role: "user", content }), display, content, parts }
}

/** What a message sent while a turn runs does: joins that turn, or waits for the next. */
export type WhileWorking = "steer" | "queue"

export const otherWay = (w: WhileWorking): WhileWorking => (w === "steer" ? "queue" : "steer")

export interface Outbox {
  readonly queued: readonly Outgoing[]
  readonly steering: readonly string[]
  readonly sentParts: ReadonlyMap<string, EditorPart[]>
  /** Records an accepted submission and releases any older batch waiting out a double press. */
  prepare(text: string, parts: EditorPart[], display?: string): Outgoing
  dispatch(message: Outgoing, parts: EditorPart[], how: WhileWorking): void
  turnStarted(prompt: UserMessage): UserMessage[]
  /** Clears pending steering before the turn's retry state and notices are updated. */
  clearSteering(): void
  /** Releases waiting messages after the turn's notices have been shown. */
  turnEnded(): void
  /** Handles user steering after NoticeStrip; true means the restored editor needs a redraw. */
  steer(message: UserMessage, state: NoticeSteerState): boolean
  /** Returns waiting messages to the editor when following another session. */
  reset(): void
  interrupt(): void
  pressInterrupt(): void
  dispose(): void
}

export interface OutboxDeps {
  agent: () => Agent
  editor: Pick<Editor, "getParts" | "setParts" | "isEmpty">
  activity: Pick<TurnActivity, "working" | "compacting" | "beginSend" | "sendFailed">
  spinner: Pick<Spinner, "stop">
  view: Pick<TranscriptView, "notice" | "requestRender" | "user">
  takeEcho: (message: UserMessage) => boolean
  echoedNote: (message: UserMessage) => void
  noModelYet: (parts: EditorPart[]) => boolean
  canRewind: () => boolean
  openRewind: () => boolean
  onInterrupt: () => void
}

/** Messages waiting for a turn, including steering released by an interrupt. */
export function createOutbox(deps: OutboxDeps): Outbox {
  const { editor, activity, spinner, view } = deps
  const queued: Outgoing[] = []
  /** Content of recent messages with folded pastes, by their text, so a dropped steer comes back folded. */
  const sentParts = new Map<string, EditorPart[]>()
  /**
   * Queued messages sent together as the next prompt, as the transcript shows each (its display
   * text, else its text), so it can show them one by one.
   */
  let mergedQueue: string[] | undefined
  /** Messages steering the running turn that have not reached the model yet. */
  const steering: string[] = []
  /** Counts the messages typed, so that steering and queued ones merge in the order they were. */
  let typed = 0
  /** Pending steering's typing order and folded parts, by its text. */
  const steered = new Map<string, Outgoing>()
  /**
   * Set when the user stopped a turn while messages waited: the steering it drops is collected
   * here, to go out with the queued messages at turn.end (or back into the editor to rewind).
   */
  let flush: { dropped: Outgoing[]; rewind: boolean } | undefined
  /** The merged messages about to go, while a second Esc may still turn the stop into a rewind. */
  let flushTimer: { next: Outgoing[]; timer: ReturnType<typeof setTimeout> } | undefined
  /** A normal turn's queue also waits a microtask before sending. */
  let pending: Outgoing[] | undefined
  let generation = 0
  /** When the interrupt key was last pressed, to tell a double press. */
  let lastInterruptAt = 0

  /** The user's message shows up in the transcript on turn.start. */
  function send(message: Outgoing) {
    if (message.content?.some((b) => b.type === "image") && !deps.agent().model.caps.images) {
      putBack([message])
      view.notice(
        "warning",
        "This model does not support images. Pick an image-capable model with /model or remove the attachments. Your message is still in the input.",
      )
      view.requestRender()
      return
    }
    const clock = activity.beginSend()
    const sentIn = generation
    view.requestRender()
    deps
      .agent()
      .prompt(toPrompt(message))
      .catch((err) => {
        if (sentIn !== generation) {
          putBack([message])
          view.requestRender()
          return
        }
        const busy = err instanceof AgentBusyError
        activity.sendFailed(clock, busy)
        if (busy) {
          // A turn we did not know about is running; send this one after it, and keep its clock.
          queued.unshift(message)
        } else {
          spinner.stop()
          view.notice("error", err instanceof Error ? err.message : String(err))
        }
        view.requestRender()
      })
  }

  /** Keeps the folded pastes of the last few messages sent, for a steer the turn drops. */
  function remember(message: Outgoing, parts: EditorPart[]) {
    if (!message.display) return
    sentParts.set(message.text, parts)
    for (const k of sentParts.keys()) {
      if (sentParts.size <= 8) break
      sentParts.delete(k)
    }
  }

  /** Sends messages as one prompt that the transcript still shows one by one. */
  function sendMerged(next: Outgoing[]) {
    if (flushTimer?.next === next) flushTimer = undefined
    if (!next.length) return
    const text = next.map((q) => q.text).join("\n\n")
    const shown = next.map((q) => q.display ?? q.text)
    const display = next.some((q) => q.display) ? shown.join("\n\n") : undefined
    mergedQueue = next.length > 1 ? shown : undefined
    const message = outgoing(text, display)
    message.parts = next.flatMap((q, i) => [
      ...(i ? ["\n\n"] : []),
      ...(q.parts ?? sentParts.get(q.text) ?? [q.text]),
    ])
    if (next.some((q) => q.content)) {
      message.content = next.flatMap((q, i) => [
        ...(i ? [{ type: "text" as const, text: "\n\n" }] : []),
        ...(q.content ?? [{ type: "text" as const, text: q.text }]),
      ])
      if (imageBytes(message.parts) > MAX_IMAGE_BYTES) {
        putBack(next)
        view.notice("warning", "Images in the combined message exceed 5 MB. Send the attachments separately.")
        return
      }
    }
    send(message)
  }

  /** Puts messages that were about to go back into the editor, before what it holds. */
  function putBack(next: Outgoing[]) {
    if (!next.length) return
    const parts: EditorPart[] = []
    for (const q of next) {
      if (parts.length) parts.push("\n\n")
      parts.push(...(q.parts ?? sentParts.get(q.text) ?? [q.text]))
    }
    if (!editor.isEmpty) parts.push("\n\n", ...editor.getParts())
    editor.setParts(parts)
  }

  /**
   * Esc or Ctrl+C while working. With steering or queued messages waiting, the turn stops and
   * they go out at once, merged in the order they were typed (on turn.end).
   */
  function interrupt() {
    deps.onInterrupt()
    if (activity.working && !flush && (queued.length || steering.length))
      flush = { dropped: [], rewind: false }
    deps.agent().abort()
  }

  return {
    queued,
    steering,
    sentParts,
    prepare(text, parts, display) {
      const message: Outgoing = { ...draftMessage(text, display, parts), parts, seq: ++typed }
      remember(message, parts)
      // Messages an Esc released still wait out a double press: they were typed first, so they go
      // first, and this one joins the turn they start (or is queued after it).
      if (flushTimer) {
        clearTimeout(flushTimer.timer)
        sendMerged(flushTimer.next)
      }
      return message
    },
    dispatch(message, parts, how) {
      if (activity.working && how === "steer") {
        steered.set(message.text, message)
        deps.agent().steer(toPrompt(message))
      } else if (activity.working) queued.push(message)
      else if (!deps.noModelYet(parts)) send(message)
    },
    turnStarted(prompt) {
      // Messages queued together go as one prompt but read as what they were: one each.
      const merged = mergedQueue && messageText(prompt) === mergedQueue.join("\n\n") ? mergedQueue : undefined
      mergedQueue = undefined
      return merged ? merged.map((text) => ({ ...prompt, display: { text } })) : [prompt]
    },
    clearSteering() {
      // Steering the turn never reached becomes the next turn, which shows it again.
      steering.length = 0
      steered.clear()
    },
    turnEnded() {
      if (flush) {
        // Stopped with Esc: the steering the turn dropped and the queued messages go out as
        // one, in the order they were typed; unless a second Esc asked to rewind instead.
        const next = [...flush.dropped, ...queued.splice(0)].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        const rewind = flush.rewind
        flush = undefined
        if (rewind) {
          putBack(next)
          queueMicrotask(() => void deps.openRewind())
        } else if (next.length) {
          // Wait out the rest of a double press: a second Esc still means rewind.
          const wait = Math.max(0, DOUBLE_ESC_MS - (Date.now() - lastInterruptAt))
          flushTimer = { next, timer: setTimeout(() => sendMerged(next), wait) }
        }
      } else if (queued.length) {
        const next = queued.splice(0, queued.length)
        pending = next
        queueMicrotask(() => {
          if (pending !== next) return
          pending = undefined
          sendMerged(next)
        })
      }
    },
    steer(message, state) {
      const text = messageText(message)
      if (state === "queued") {
        steering.push(text)
        return false
      }
      const pendingSteer = steered.get(userText(message))
      steered.delete(userText(message))
      const i = steering.indexOf(text)
      if (i !== -1) steering.splice(i, 1)
      const echoed = state !== "promoted" && deps.takeEcho(message)
      if (state === "injected") {
        if (echoed) deps.echoedNote(message)
        else view.user(message)
      }
      // Stopped with Esc while messages waited: it goes out again at once, with the queued ones.
      else if (state === "dropped" && flush) {
        const m = message
        flush.dropped.push({
          ...draftMessage(userText(m), m.display?.text, messageParts(m)),
          parts: pendingSteer?.parts ?? sentParts.get(userText(m)) ?? messageParts(m),
          seq: pendingSteer?.seq ?? 0,
        })
      }
      // Put a message the turn dropped back into the editor rather than losing it.
      else if (state === "dropped") {
        // A message with folded pastes comes back folded.
        const back = message.content.some((b) => b.type === "image")
          ? messageParts(message)
          : (pendingSteer?.parts ?? sentParts.get(userText(message)) ?? [text])
        editor.setParts(editor.isEmpty ? back : [...editor.getParts(), "\n", ...back])
        return true
      }
      // A promoted one shows up again as the next turn's prompt.
      return false
    },
    reset() {
      generation++
      if (flushTimer) clearTimeout(flushTimer.timer)
      putBack(
        [
          ...queued.splice(0),
          ...(flush?.dropped ?? []),
          ...(flushTimer?.next ?? []),
          ...(pending ?? []),
        ].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
      )
      flush = undefined
      flushTimer = undefined
      pending = undefined
      mergedQueue = undefined
      steering.length = 0
      steered.clear()
      sentParts.clear()
      typed = 0
      lastInterruptAt = 0
    },
    interrupt,
    /**
     * The interrupt key (Esc). Once: stops the turn (sending what waits, see interrupt). Twice in
     * a row: stops it and opens the rewind picker, the waiting messages back in the editor.
     */
    pressInterrupt() {
      const now = Date.now()
      const double = now - lastInterruptAt < DOUBLE_ESC_MS
      lastInterruptAt = double ? 0 : now
      if (!double) {
        if (activity.working || activity.compacting) interrupt()
        return
      }
      if (!deps.canRewind()) {
        if (activity.working || activity.compacting) interrupt()
        return
      }
      // The merged send was waiting out the double press: hold it in the editor instead.
      if (flushTimer) {
        clearTimeout(flushTimer.timer)
        putBack(flushTimer.next)
        flushTimer = undefined
      }
      if (activity.working) {
        if (!flush) flush = { dropped: [], rewind: true }
        else flush.rewind = true
        interrupt()
      } else if (!activity.compacting) deps.openRewind()
    },
    dispose() {
      if (flushTimer) clearTimeout(flushTimer.timer)
    },
  }
}

/** Messages waiting above the input box (steering, queued) shown at most; the rest are counted. */
const PENDING_SHOWN = 3
/** Rows each of them takes at most. */
const PENDING_ROWS = 2

/**
 * The rows of messages waiting above the input box: "steering › …" and "queued › …", each on
 * at most two rows (the second under the text, cut with "…"), at most three of them, then how
 * many more wait. They stay a few rows, however long the messages, so the input box keeps its
 * place on the screen.
 */
export function pendingMessageRows(
  items: readonly { label: string; text: string }[],
  width: number,
  theme: Theme,
): string[] {
  const out: string[] = []
  for (const { label, text } of items.slice(0, PENDING_SHOWN)) {
    const head = `${label} ${glyphs.user} `
    const indent = visibleWidth(head)
    const flat = text.replace(/\s+/g, " ").trim()
    const rows = wrapText(flat, Math.max(8, width - indent))
    const shown = rows.slice(0, PENDING_ROWS)
    if (rows.length > PENDING_ROWS) {
      const last = shown.length - 1
      shown[last] = truncateToWidth(
        `${shown[last]} ${rows.slice(PENDING_ROWS).join(" ")}`,
        Math.max(8, width - indent),
        glyphs.more,
      )
    }
    shown.forEach((r, i) => {
      out.push(truncateToWidth(theme.muted(`${i === 0 ? head : " ".repeat(indent)}${r}`), width, glyphs.more))
    })
  }
  const more = items.length - PENDING_SHOWN
  if (more > 0) out.push(theme.muted(`+${more} more waiting`))
  return out
}

/**
 * How a user message reads while queued, or back in the editor once dropped: its display text,
 * if any. That is what the user typed (e.g. "/review-pr 123"), so sending it again re-runs it.
 */
export function messageText(m: UserMessage): string {
  return m.display?.text.trim() || userText(m)
}

/** A message on one line, cut for a list of them. */
export const oneLine = (s: string, max = 100) => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${[...flat].slice(0, max - 1).join("")}…` : flat
}

export type NoticeSteerState = "queued" | "injected" | "dropped" | "promoted"

export interface NoticeStrip {
  /** Clears notices carried by a new turn and cancels any retry timer. */
  turnStarted(prompt: UserMessage): void
  /** Handles an origin message; returns false for ordinary steering. */
  steer(message: UserMessage, state: NoticeSteerState): boolean
  /** Sets or clears the time at which held notices will be resent. */
  setRetry(at: number | undefined): void
  /** Clears notices and any retry timer when the active session changes. */
  reset(): void
  /** Pending notice lines, with the time to the next resend when one is due. */
  render(theme: Theme): string[]
  /** Releases the retry timer when the controller quits. */
  dispose(): void
}

export function createNoticeStrip(options: { theme: Theme; requestRender: () => void }): NoticeStrip {
  /** Lines of notices (background results) waiting to reach the model. */
  const pendingNotices: string[] = []
  /** When held notices are sent again after a failed turn (notice.retry); redrawn each second. */
  let noticeRetryAt: number | undefined
  let retryTimer: ReturnType<typeof setInterval> | undefined

  const setRetry = (at: number | undefined) => {
    noticeRetryAt = at
    if (at !== undefined && !retryTimer) retryTimer = setInterval(options.requestRender, 1000)
    else if (at === undefined && retryTimer) {
      clearInterval(retryTimer)
      retryTimer = undefined
    }
  }

  return {
    turnStarted(prompt) {
      // A turn woken by notices carries every one that was waiting.
      if (prompt.display?.origin) pendingNotices.length = 0
      // A turn takes held notices along, so no resend is due any more.
      setRetry(undefined)
    },
    steer(message, state) {
      if (!message.display?.origin) return false
      if (state === "queued") pendingNotices.push(...userLines(options.theme, message))
      else pendingNotices.length = 0
      return true
    },
    setRetry,
    reset() {
      pendingNotices.length = 0
      setRetry(undefined)
    },
    render(theme) {
      const retry =
        noticeRetryAt === undefined
          ? ""
          : ` · retry in ${Math.max(0, Math.ceil((noticeRetryAt - Date.now()) / 1000))}s`
      const lines = pendingNotices.length
        ? pendingNotices
        : noticeRetryAt !== undefined
          ? [`${theme.accent("◆")}${theme.muted(" sub-agents' results")}`]
          : []
      return lines.map((line) => `${line}${theme.muted(` · pending${retry}`)}`)
    },
    dispose() {
      setRetry(undefined)
    },
  }
}
