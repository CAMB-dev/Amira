import { cursor } from "../ansi.ts"
import { sanitize } from "../width.ts"
import type { ImageBlock } from "./encode.ts"

/**
 * Images reach the scrollback as committed lines holding a marker: an APC string with a random
 * per-process nonce and an id. Content can never forge one (the renderer strips APC strings from
 * everything else, and the nonce is not known), and only markers registered here count.
 */
const NONCE = Math.random().toString(36).slice(2, 10)
const MARKER_START = `\x1b_tk:img:${NONCE}:`
const MARKER = new RegExp(`\\x1b_tk:img:${NONCE}:(\\d+)\\x07$`)

/**
 * How long a marker keeps its image after its deadline, for a line held back (suspended)
 * meanwhile; after that only its fallback rows are kept until it is committed.
 */
const KEEP_MS = 60_000

interface Pending {
  state: "loading" | "ready" | "failed"
  block?: ImageBlock
  /** Rows shown while it loads, and committed instead when it fails or takes too long. */
  fallback: string[]
  deadline: number
  listeners: Set<() => void>
}

const pending = new Map<number, Pending>()
let nextId = 1

/**
 * A line to commit that becomes the image once `load` has it, or `fallback` when it fails or is
 * not there by `timeoutMs` from now. Whatever is committed after it waits for it, so the
 * scrollback keeps the order. Text may go in front of the marker (a gutter); it is drawn first,
 * and the image or the fallback's first row start where it ends.
 */
export function pendingImage(
  load: Promise<ImageBlock | undefined>,
  fallback: string[],
  timeoutMs = 3000,
  now = performance.now(),
): string {
  const id = nextId++
  // Printed as they are later: only styles and links may stay in them.
  fallback = fallback.flatMap((r) => sanitize(r).split("\n"))
  const entry: Pending = { state: "loading", fallback, deadline: now + timeoutMs, listeners: new Set() }
  pending.set(id, entry)
  const settle = (block: ImageBlock | undefined) => {
    if (entry.state !== "loading") return
    if (block) {
      entry.state = "ready"
      entry.block = block
    } else entry.state = "failed"
    for (const fn of entry.listeners) fn()
    entry.listeners.clear()
  }
  load.then(settle, () => settle(undefined))
  // Not committed long after its time (held back while a full-screen view is open): the image
  // is let go, but the fallback stays, so the line still shows something when it goes out.
  const forget = setTimeout(() => {
    if (!pending.has(id)) return
    entry.block = undefined
    entry.state = "failed"
    entry.listeners.clear()
  }, timeoutMs + KEEP_MS)
  ;(forget as { unref?: () => void }).unref?.()
  return `${MARKER_START}${id}\x07`
}

/** A committed line holding an image marker: the text in front of it and its id. */
export function findImageMarker(line: string): { prefix: string; id: number } | undefined {
  if (!line.includes(MARKER_START)) return undefined
  const m = MARKER.exec(line)
  if (!m || !pending.has(Number(m[1]))) return undefined
  return { prefix: line.slice(0, m.index), id: Number(m[1]) }
}

export type ImageState =
  | { kind: "wait"; fallback: string[]; deadline: number }
  | { kind: "image"; block: ImageBlock; fallback: string[] }
  | { kind: "fallback"; fallback: string[] }

/** Where an image stands: still loading (within its time), ready, or to be shown as its fallback. */
export function imageState(id: number, now = performance.now(), force = false): ImageState {
  const e = pending.get(id)
  if (!e) return { kind: "fallback", fallback: [] }
  if (e.state === "ready") return { kind: "image", block: e.block!, fallback: e.fallback }
  if (e.state === "failed" || force || now >= e.deadline) return { kind: "fallback", fallback: e.fallback }
  return { kind: "wait", fallback: e.fallback, deadline: e.deadline }
}

/** Calls `fn` once when the image settles; returns how to stop waiting. */
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
