import { open } from "node:fs/promises"
import { looksBinary, type Sniffed, sniffEncoding } from "./text.ts"

const HEAD_BYTES = 8192
const COUNT_TOTAL_BYTES = 16 * 1024 * 1024

export interface LineWindow {
  /** Lines `start` .. `start + count - 1`, without line endings, each cut to `keepChars`. */
  lines: string[]
  /** Total line count, known only when the whole file was read. */
  total?: number
  /** Whether at least one line follows the window. */
  more: boolean
  encoding: Sniffed
  /** Set when UTF-8 decoding hit invalid bytes in the part that was read. */
  invalidUtf8: boolean
}

export type ReadLinesResult = LineWindow | "binary" | "aborted"

/**
 * Streams a text file and keeps only the requested lines, so memory stays bounded by the window
 * no matter how large the file or how far in the window starts.
 */
export async function readLineWindow(
  path: string,
  start: number,
  count: number,
  keepChars: number,
  signal: AbortSignal,
): Promise<ReadLinesResult> {
  const head = await readHead(path)
  const encoding = sniffEncoding(head)
  if (looksBinary(head, encoding)) return "binary"

  const utf8 = encoding.encoding === "utf-8"
  let decoder = new TextDecoder(encoding.encoding, { fatal: utf8, ignoreBOM: true })
  let invalidUtf8 = false
  const decode = (bytes?: Uint8Array) => {
    const opts = { stream: bytes !== undefined }
    try {
      return decoder.decode(bytes, opts)
    } catch {
      // Keep going lossily; a character split across the failing chunk boundary may be garbled.
      invalidUtf8 = true
      decoder = new TextDecoder(encoding.encoding, { ignoreBOM: true })
      return decoder.decode(bytes, opts)
    }
  }

  const end = start + count - 1
  const lines: string[] = []
  let lineNo = 0
  let more = false
  const emit = (line: string) => {
    lineNo++
    if (lineNo > end) more = true
    else if (lineNo >= start) lines.push(line.endsWith("\r") ? line.slice(0, -1) : line)
  }

  let carry = ""
  const feed = (text: string) => {
    let from = 0
    for (;;) {
      const nl = text.indexOf("\n", from)
      const stop = nl === -1 ? text.length : nl
      if (carry.length < keepChars) carry += text.slice(from, Math.min(stop, from + keepChars - carry.length))
      if (nl === -1) return
      emit(carry)
      carry = ""
      from = nl + 1
    }
  }

  let skip = encoding.bomLength
  let consumed = 0
  const reader = Bun.file(path).stream().getReader()
  try {
    for (;;) {
      if (signal.aborted) return "aborted"
      const { value, done } = await reader.read()
      if (done) break
      consumed += value.length
      let bytes = value
      if (skip > 0) {
        const n = Math.min(skip, bytes.length)
        bytes = bytes.subarray(n)
        skip -= n
      }
      feed(decode(bytes))
      // Past the window: keep counting lines for the total only while that stays cheap.
      if (more && consumed >= COUNT_TOTAL_BYTES) return { lines, more, encoding, invalidUtf8 }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  feed(decode())
  if (carry !== "") emit(carry)
  return { lines, total: lineNo, more, encoding, invalidUtf8 }
}

async function readHead(path: string): Promise<Uint8Array> {
  const fh = await open(path, "r")
  try {
    const buf = new Uint8Array(HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}
