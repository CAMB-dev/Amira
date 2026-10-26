// Owns queued and steering messages, interrupt flushing and the pending-notice strip.
import type { SendOptions, UserMessage } from "@amira/api"
import { type AgentPort, frontendIdentity, isFrontendError, newTurnId } from "@amira/core"
import {
  type Editor,
  type EditorPart,
  type Spinner,
  type Theme,
  truncateToWidth,
  wrapText,
} from "@amira/tui-kit"
import { userLines, userText } from "../format.ts"
import { glyphs, viewEllipsis } from "../glyphs.ts"
import { CONTENT_INSET, contentRoom } from "../grid.ts"
import { imageBytes, MAX_IMAGE_BYTES } from "../image-input.ts"
import type { TranscriptView } from "../view.ts"
import type { TurnActivity } from "./activity.ts"
import type { DisplayModel } from "./frontend-display.ts"
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
  /** Includes invisible admissions, released batches and the double-Esc timer. */
  readonly suggestionBlocked: boolean
  /** Records an accepted submission and releases any older batch waiting out a double press. */
  prepare(text: string, parts: EditorPart[], display?: string): Outgoing
  dispatch(message: Outgoing, parts: EditorPart[], how: WhileWorking): void
  /** Tracks a command/skill send at its original input position, independently of echo text. */
  commandSend(text: string, options?: SendOptions, sequence?: number): () => void
  turnStarted(prompt: UserMessage, turnId?: string): UserMessage[]
  /** Clears pending steering before the turn's retry state and notices are updated. */
  clearSteering(): void
  /** Releases waiting messages after the turn's notices have been shown. */
  turnEnded(): void
  /** Handles user steering after NoticeStrip; true means the restored editor needs a redraw. */
  steer(message: UserMessage, state: NoticeSteerState, duringTurn?: boolean, display?: boolean): boolean
  /** Returns waiting messages to the editor when following another session. */
  reset(): void
  interrupt(turnId?: string): void
  pressInterrupt(): void
  dispose(): void
}

export interface OutboxDeps {
  agent: () => { model: DisplayModel; turnId?: string; holdId?: string }
  frontend: AgentPort
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
  changed?: () => void
}

function sameOutgoing(outgoing: Outgoing, message: UserMessage): boolean {
  const input = toPrompt(outgoing)
  const own =
    typeof input === "string"
      ? { role: "user" as const, content: [{ type: "text" as const, text: input }] }
      : input
  const key = (value: UserMessage) =>
    JSON.stringify([
      value.content.map((block) =>
        block.type === "text"
          ? ["text", block.text]
          : [
              "image",
              block.name ?? `image.${block.mimeType.split("/")[1] ?? "png"}`,
              block.mimeType,
              block.data,
            ],
      ),
      value.display?.text ?? null,
    ])
  return key(own) === key(message)
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
  const steered: Outgoing[] = []
  const announced = new WeakSet<Outgoing>()
  let pendingPrompt: Outgoing | undefined
  let pendingPromptId: string | undefined
  let heldRecovery: { waiting: Set<Outgoing>; dropped: Outgoing[] } | undefined
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
  let disposed = false
  let endedTurns = 0
  const admissions = new Set<{ message: Outgoing; reconciled: boolean; turnId?: string }>()
  /** When the interrupt key was last pressed, to tell a double press. */
  let lastInterruptAt = 0

  /** The user's message shows up in the transcript on turn.start. */
  function send(message: Outgoing) {
    if (disposed) return
    if (message.content?.some((b) => b.type === "image") && !deps.agent().model.caps?.images) {
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
    const endedBeforeSend = endedTurns
    const admission = { message, reconciled: false, turnId: newTurnId() }
    admissions.add(admission)
    pendingPrompt = message
    pendingPromptId = admission.turnId
    deps.changed?.()
    view.requestRender()
    deps.frontend
      .execute(
        "turn.prompt",
        {
          message: toPrompt(message),
          turnId: admission.turnId,
          ...(deps.agent().holdId ? { expectedHoldId: deps.agent().holdId } : {}),
        },
        {
          sessionGeneration: frontendIdentity(deps.frontend).sessionGeneration,
        },
      )
      .catch((err) => {
        if (disposed || admission.reconciled) return
        if (pendingPromptId === admission.turnId) {
          pendingPrompt = undefined
          pendingPromptId = undefined
        }
        if (recoverRejected(message)) {
          view.requestRender()
          return
        }
        if (sentIn !== generation) {
          putBack([message])
          view.requestRender()
          return
        }
        const busy = isFrontendError(err, "agent_busy")
        activity.sendFailed(clock, busy)
        if (busy) {
          // A turn we did not know about is running; send this one after it, and keep its clock.
          queued.unshift(message)
          if (endedTurns !== endedBeforeSend && !activity.working && !activity.compacting) releaseQueued()
        } else {
          spinner.stop()
          putBack([message])
          view.notice("error", err instanceof Error ? err.message : String(err))
        }
        view.requestRender()
      })
      .finally(() => {
        admissions.delete(admission)
        deps.changed?.()
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
    if (flushTimer?.next === next) {
      flushTimer = undefined
      deps.changed?.()
    }
    if (!next.length) return
    const text = next.map((q) => q.text).join("\n\n")
    const shown = next.map((q) => q.display ?? q.text)
    const display = next.some((q) => q.display) ? shown.join("\n\n") : undefined
    mergedQueue = next.length > 1 ? shown : undefined
    const message: Outgoing = { ...outgoing(text, display), seq: next[0]?.seq }
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

  function releaseQueued() {
    if (!queued.length) return
    const next = queued.splice(0, queued.length)
    pending = next
    deps.changed?.()
    queueMicrotask(() => {
      if (pending !== next) return
      pending = undefined
      deps.changed?.()
      sendMerged(next)
    })
  }

  function reconcileAdmission(message: Outgoing | undefined) {
    if (!message) return
    for (const admission of admissions) if (admission.message === message) admission.reconciled = true
  }

  function restoreHeld(): boolean {
    if (!heldRecovery || heldRecovery.waiting.size) return false
    const next = heldRecovery.dropped.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    heldRecovery = undefined
    putBack(next)
    return true
  }

  function recoverRejected(message: Outgoing): boolean {
    if (!heldRecovery?.waiting.delete(message)) return false
    heldRecovery.dropped.push(message)
    restoreHeld()
    return true
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
  function interrupt(expectedTurnId?: string) {
    const agent = deps.agent()
    if (expectedTurnId !== undefined && agent.turnId !== expectedTurnId) return
    const turnId = expectedTurnId ?? agent.turnId
    const holdId = turnId === undefined ? agent.holdId : undefined
    if (turnId === undefined && holdId === undefined) return
    const target = turnId !== undefined ? { turnId } : { holdId }
    const sessionGeneration = frontendIdentity(deps.frontend).sessionGeneration
    deps.onInterrupt()
    if (activity.working && !flush && (queued.length || steering.length))
      flush = { dropped: [], rewind: false }
    void deps.frontend.execute("turn.abort", target, { sessionGeneration }).catch((error) => {
      const current = deps.agent()
      if (
        disposed ||
        frontendIdentity(deps.frontend).sessionGeneration !== sessionGeneration ||
        (turnId !== undefined ? current.turnId !== turnId : current.holdId !== holdId)
      )
        return
      view.notice("error", error instanceof Error ? error.message : String(error))
      view.requestRender()
    })
  }

  return {
    queued,
    steering,
    sentParts,
    get suggestionBlocked() {
      return !!(
        queued.length ||
        steering.length ||
        steered.length ||
        pendingPrompt ||
        admissions.size ||
        heldRecovery ||
        flush ||
        flushTimer ||
        pending
      )
    },
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
    commandSend(text, options, sequence) {
      if (options?.display?.origin) return () => {} // NoticeStrip owns background-notice recovery.
      const parts: EditorPart[] = [text]
      const message = {
        ...draftMessage(text, options?.display?.text, parts),
        parts,
        seq: sequence ?? ++typed,
      }
      steered.push(message)
      deps.changed?.()
      return () => {
        const index = steered.indexOf(message)
        if (index !== -1) steered.splice(index, 1)
        deps.changed?.()
        if (recoverRejected(message)) view.requestRender()
      }
    },
    dispatch(message, parts, how) {
      if (activity.working && how === "steer") {
        steered.push(message)
        const sentIn = generation
        const admission = { message, reconciled: false, turnId: newTurnId() }
        const active = deps.agent()
        const target = active.turnId
          ? { expectedTurnId: active.turnId }
          : active.holdId
            ? { expectedHoldId: active.holdId }
            : { expectedIdle: true }
        admissions.add(admission)
        deps.changed?.()
        void deps.frontend
          .execute(
            "turn.steer",
            { message: toPrompt(message), turnId: admission.turnId, ...target },
            {
              sessionGeneration: frontendIdentity(deps.frontend).sessionGeneration,
            },
          )
          .catch((error) => {
            if (disposed || admission.reconciled) return
            const index = steered.indexOf(message)
            if (index !== -1) steered.splice(index, 1)
            if (!recoverRejected(message)) putBack([message])
            if (sentIn === generation)
              view.notice("error", error instanceof Error ? error.message : String(error))
            view.requestRender()
          })
          .finally(() => {
            admissions.delete(admission)
            deps.changed?.()
          })
      } else if (activity.working) {
        queued.push(message)
        deps.changed?.()
      } else if (!deps.noModelYet(parts)) send(message)
    },
    turnStarted(prompt, turnId) {
      if (turnId !== undefined) {
        for (const admission of admissions) if (admission.turnId === turnId) admission.reconciled = true
        if (pendingPromptId === turnId) {
          pendingPrompt = undefined
          pendingPromptId = undefined
        }
      }
      // Messages queued together go as one prompt but read as what they were: one each.
      const merged = mergedQueue && messageText(prompt) === mergedQueue.join("\n\n") ? mergedQueue : undefined
      mergedQueue = undefined
      deps.changed?.()
      return merged ? merged.map((text) => ({ ...prompt, display: { text } })) : [prompt]
    },
    clearSteering() {
      // Steering the turn never reached becomes the next turn, which shows it again.
      steering.length = 0
      steered.length = 0
      deps.changed?.()
    },
    turnEnded() {
      endedTurns++
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
      } else releaseQueued()
      deps.changed?.()
    },
    steer(message, state, duringTurn = true, display = true) {
      const text = messageText(message)
      if (state === "queued") {
        let queued = steered.find((entry) => sameOutgoing(entry, message) && !announced.has(entry))
        if (!queued) {
          const parts = messageParts(message)
          queued = { ...draftMessage(userText(message), message.display?.text, parts), parts, seq: ++typed }
          steered.push(queued)
        }
        announced.add(queued)
        reconcileAdmission(queued)
        steering.push(text)
        deps.changed?.()
        return false
      }
      const pendingSteer = steered.find((entry) => sameOutgoing(entry, message))
      if (state === "dropped" && !duringTurn && display) {
        // All inputs of the cancelled hold drop without turn.end. Wait for the whole known
        // batch, including acknowledgements already received, instead of prepending each event.
        heldRecovery ??= {
          waiting: new Set([...(pendingPrompt ? [pendingPrompt] : []), ...steered]),
          dropped: [...(flush?.dropped ?? []), ...queued.splice(0)],
        }
        const original = [...heldRecovery.waiting].find((entry) => sameOutgoing(entry, message))
        if (original) heldRecovery.waiting.delete(original)
        if (pendingPrompt === original) {
          pendingPrompt = undefined
          pendingPromptId = undefined
        }
        const candidate = original ?? pendingSteer
        const index = candidate ? steered.indexOf(candidate) : -1
        if (index !== -1) steered.splice(index, 1)
        heldRecovery.dropped.push(
          original ?? {
            ...draftMessage(userText(message), message.display?.text, messageParts(message)),
            parts: messageParts(message),
            seq: ++typed,
          },
        )
        reconcileAdmission(original)
        activity.sendFailed({ turnStartedAt: 0, turnTokens: 0 }, false)
        spinner.stop()
        flush = undefined
        steering.length = 0
        deps.changed?.()
        return restoreHeld()
      }
      reconcileAdmission(pendingSteer)
      if (pendingSteer) steered.splice(steered.indexOf(pendingSteer), 1)
      const i = steering.indexOf(text)
      if (i !== -1) steering.splice(i, 1)
      const echoed = state !== "promoted" && deps.takeEcho(message)
      if (state === "injected") {
        if (display) {
          if (echoed) deps.echoedNote(message)
          else view.user(message)
        }
      }
      // Stopped with Esc while messages waited: it goes out again at once, with the queued ones.
      else if (state === "dropped" && flush && display) {
        const m = message
        flush.dropped.push({
          ...draftMessage(userText(m), m.display?.text, messageParts(m)),
          parts: pendingSteer?.parts ?? sentParts.get(userText(m)) ?? messageParts(m),
          seq: pendingSteer?.seq ?? 0,
        })
      }
      // Put a message the turn dropped back into the editor rather than losing it.
      else if (state === "dropped" && display) {
        // A message with folded pastes comes back folded.
        const back = message.content.some((b) => b.type === "image")
          ? messageParts(message)
          : (pendingSteer?.parts ?? sentParts.get(userText(message)) ?? [text])
        editor.setParts(editor.isEmpty ? back : [...editor.getParts(), "\n", ...back])
        return true
      }
      // A promoted one shows up again as the next turn's prompt.
      deps.changed?.()
      return false
    },
    reset() {
      generation++
      if (flushTimer) clearTimeout(flushTimer.timer)
      const held = [...(heldRecovery?.dropped ?? []), ...(heldRecovery?.waiting ?? [])]
      for (const admission of admissions) if (held.includes(admission.message)) admission.reconciled = true
      putBack(
        [
          ...queued.splice(0),
          ...(flush?.dropped ?? []),
          ...(flushTimer?.next ?? []),
          ...(pending ?? []),
          ...held,
        ].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
      )
      flush = undefined
      flushTimer = undefined
      pending = undefined
      mergedQueue = undefined
      pendingPrompt = undefined
      pendingPromptId = undefined
      heldRecovery = undefined
      steering.length = 0
      steered.length = 0
      sentParts.clear()
      typed = 0
      lastInterruptAt = 0
      deps.changed?.()
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
      disposed = true
      pending = undefined
      pendingPrompt = undefined
      pendingPromptId = undefined
      heldRecovery = undefined
      if (flushTimer) clearTimeout(flushTimer.timer)
      deps.changed?.()
    },
  }
}

/** Messages waiting above the input box (steering, queued) shown at most; the rest are counted. */
const PENDING_SHOWN = 3
/** Rows each of them takes at most. */
const PENDING_ROWS = 2

/**
 * The rows of messages waiting above the input box: "steering › …" and "queued › …", each on
 * at most two rows hanging on the content column (cut with "…"), at most three of them, then how
 * many more wait. They stay a few rows, however long the messages, so the input box keeps its
 * place on the screen.
 */
export function pendingMessageRows(
  items: readonly { label: string; text: string }[],
  width: number,
  theme: Theme,
): string[] {
  const out: string[] = []
  const room = contentRoom(width)
  for (const { label, text } of items.slice(0, PENDING_SHOWN)) {
    const flat = text.replace(/\s+/g, " ").trim()
    const rows = wrapText(`${label} ${glyphs.user} ${flat}`, room)
    const shown = rows.slice(0, PENDING_ROWS)
    if (rows.length > PENDING_ROWS) {
      const last = shown.length - 1
      shown[last] = truncateToWidth(
        `${shown[last]} ${rows.slice(PENDING_ROWS).join(" ")}`,
        room,
        viewEllipsis(),
      )
    }
    for (const row of shown)
      out.push(truncateToWidth(`${CONTENT_INSET}${theme.muted(row)}`, width, viewEllipsis()))
  }
  const more = items.length - PENDING_SHOWN
  if (more > 0)
    out.push(
      truncateToWidth(`${CONTENT_INSET}${theme.muted(`+${more} more waiting`)}`, width, viewEllipsis()),
    )
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
  const pendingNotices: UserMessage[] = []
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
      if (state === "queued") pendingNotices.push(message)
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
          : ` ${glyphs.separator} retry in ${Math.max(0, Math.ceil((noticeRetryAt - Date.now()) / 1000))}s`
      const lines = pendingNotices.length
        ? pendingNotices.flatMap((message) => userLines(theme, message))
        : noticeRetryAt !== undefined
          ? [`${theme.accent(glyphs.subagent)}${theme.muted(" sub-agents' results")}`]
          : []
      return lines.map((line) => `${line}${theme.muted(` ${glyphs.separator} pending${retry}`)}`)
    },
    dispose() {
      setRetry(undefined)
    },
  }
}
