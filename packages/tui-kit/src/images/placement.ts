import { cursor } from "../ansi.ts"
import { sanitize } from "../width.ts"
import type { ImageBlock } from "./types.ts"

/**
 * Images, and other rows that are not ready when their line is committed (a diagram an
 * extension renders), reach the scrollback as committed lines holding a marker: an APC string
 * with a random per-process nonce and an id. Content can never forge one (the renderer strips
 * APC strings from everything else, and the nonce is not known), and only markers registered
 * here count.
 */
const NONCE = Math.random().toString(36).slice(2, 10)
const MARKER_START = `\x1b_tk:img:${NONCE}:`
const MARKER = new RegExp(`\\x1b_tk:img:${NONCE}:(\\d+)\\x07$`)

/**
 * How long a marker keeps what it became after its deadline, for a line held back (suspended)
 * meanwhile; after that only its fallback rows are kept until it is committed.
 */
const KEEP_MS = 60_000

/** What a pending line becomes: an image, or rows of text. */
export type PendingResult = ImageBlock | string[]

interface Pending {
  state: "loading" | "ready" | "failed"
  result?: PendingResult
  /** Rows shown while it loads, and committed instead when it fails or takes too long. */
  fallback: string[] | (() => string[])
  deadline: number
  listeners: Set<() => void>
}

const pending = new Map<number, Pending>()
let nextId = 1

/** Printed as they are later: only styles and links may stay in them. */
const safeRows = (rows: string[]) => rows.flatMap((r) => sanitize(r).split("\n"))

/**
 * A line to commit that becomes what `load` resolves to (an image, or rows), or `fallback`
 * when it resolves to nothing, fails, or is not there by `timeoutMs` from now. Whatever is
 * committed after it waits for it, so the scrollback keeps the order. Text may go in front of
 * the marker (a gutter); it is drawn first, and the image or the first row start where it ends.
 * A fallback getter lets a renderer supply better text before its image finishes loading.
 */
export function pendingBlock(
  load: Promise<PendingResult | undefined>,
  fallback: string[] | (() => string[]),
  timeoutMs = 3000,
  now = performance.now(),
): string {
  const id = nextId++
  const entry: Pending = {
    state: "loading",
    fallback: typeof fallback === "function" ? () => safeRows(fallback()) : safeRows(fallback),
    deadline: now + timeoutMs,
    listeners: new Set(),
  }
  pending.set(id, entry)
  const settle = (result: PendingResult | undefined) => {
    if (entry.state !== "loading") return
    if (result) {
      entry.state = "ready"
      entry.result = Array.isArray(result) ? safeRows(result) : result
    } else entry.state = "failed"
    for (const fn of entry.listeners) fn()
    entry.listeners.clear()
  }
  load.then(settle, () => settle(undefined))
  // Not committed long after its time (held back while a full-screen view is open): what it
  // became is let go, but the fallback stays, so the line still shows something when it goes out.
  const forget = setTimeout(() => {
    if (!pending.has(id)) return
    entry.result = undefined
    if (typeof entry.fallback === "function") entry.fallback = entry.fallback()
    entry.state = "failed"
    entry.listeners.clear()
  }, timeoutMs + KEEP_MS)
  ;(forget as { unref?: () => void }).unref?.()
  return `${MARKER_START}${id}\x07`
}

/** A line to commit that becomes the image once `load` has it: see `pendingBlock`. */
export function pendingImage(
  load: Promise<ImageBlock | undefined>,
  fallback: string[],
  timeoutMs = 3000,
  now = performance.now(),
): string {
  return pendingBlock(load, fallback, timeoutMs, now)
}

/** A committed line holding a marker: the text in front of it and its id. */
export function findImageMarker(line: string): { prefix: string; id: number } | undefined {
  if (!line.includes(MARKER_START)) return undefined
  const m = MARKER.exec(line)
  if (!m || !pending.has(Number(m[1]))) return undefined
  return { prefix: line.slice(0, m.index), id: Number(m[1]) }
}

export type ImageState =
  | { kind: "wait"; fallback: string[]; deadline: number }
  | { kind: "image"; block: ImageBlock; fallback: string[] }
  | { kind: "rows"; rows: string[]; fallback: string[] }
  | { kind: "fallback"; fallback: string[] }

/** Where a marker stands: still loading (within its time), ready, or to be shown as its fallback. */
export function imageState(id: number, now = performance.now(), force = false): ImageState {
  const e = pending.get(id)
  if (!e) return { kind: "fallback", fallback: [] }
  const fallback = typeof e.fallback === "function" ? e.fallback() : e.fallback
  if (e.state === "ready") {
    const r = e.result!
    return Array.isArray(r) ? { kind: "rows", rows: r, fallback } : { kind: "image", block: r, fallback }
  }
  if (e.state === "failed" || force || now >= e.deadline) return { kind: "fallback", fallback }
  return { kind: "wait", fallback, deadline: e.deadline }
}

/** Calls `fn` once when the marker settles; returns how to stop waiting. */
export function onImageSettled(id: number, fn: () => void): () => void {
  const e = pending.get(id)
  if (e?.state !== "loading") return () => {}
  e.listeners.add(fn)
  return () => e.listeners.delete(fn)
}

/** Forgets a marker whose line was committed, so its image is kept only by what printed it. */
export function releaseImage(id: number): void {
  pending.delete(id)
}

/**
 * Prints an image at column `col` of the current row, which it takes along with the `rows - 1`
 * below, leaving the cursor on its last row: the rows are made first (scrolling as needed), so
 * drawing never scrolls, and the cursor is saved and restored around the image, since terminals
 * leave it in different places after one.
 */
export function placeImage(block: ImageBlock, col: number): string {
  const n = block.rows
  return `${"\r\n".repeat(n)}${cursor.up(n)}${cursor.column(col)}\x1b7${block.seq}\x1b8${cursor.down(n - 1)}`
}
