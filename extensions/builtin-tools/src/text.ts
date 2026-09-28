import { isBinary } from "./files.ts"

const BOM = String.fromCharCode(0xfeff)

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be"

export interface Sniffed {
  encoding: TextEncoding
  /** Length of the byte order mark, 0 when there is none. */
  bomLength: number
}

/** Detects a byte order mark. Files without one are treated as UTF-8. The BOM is stripped by the caller, so decoders keep any further U+FEFF. */
export function sniffEncoding(head: Uint8Array): Sniffed {
  if (head[0] === 0xff && head[1] === 0xfe) return { encoding: "utf-16le", bomLength: 2 }
  if (head[0] === 0xfe && head[1] === 0xff) return { encoding: "utf-16be", bomLength: 2 }
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { encoding: "utf-8", bomLength: 3 }
  return { encoding: "utf-8", bomLength: 0 }
}

/** UTF-16 text is full of NUL bytes, so only BOM-less UTF-8 candidates are checked for them. */
export function looksBinary(head: Uint8Array, sniffed: Sniffed): boolean {
  return sniffed.encoding === "utf-8" && isBinary(head)
}

export interface Decoded extends Sniffed {
  /** The text without its byte order mark. */
  text: string
  /** Set when UTF-8 decoding hit invalid bytes; `text` then has U+FFFD in their place. */
  invalid?: { offset: number }
}

export function decodeText(bytes: Uint8Array): Decoded {
  const sniffed = sniffEncoding(bytes)
  const body = bytes.subarray(sniffed.bomLength)
  if (sniffed.encoding !== "utf-8") {
    return { ...sniffed, text: new TextDecoder(sniffed.encoding, { ignoreBOM: true }).decode(body) }
  }
  try {
    return { ...sniffed, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body) }
  } catch {
    const offset = invalidUtf8Offset(body) + sniffed.bomLength
    return {
      ...sniffed,
      text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(body),
      invalid: { offset },
    }
  }
}

export function encodeText(text: string, sniffed: Sniffed): Uint8Array {
  const bom = sniffed.bomLength > 0 ? BOM : ""
  if (sniffed.encoding === "utf-8") return Buffer.from(bom + text, "utf8")
  const bytes = Buffer.from(bom + text, "utf16le")
  if (sniffed.encoding === "utf-16be") bytes.swap16()
  return bytes
}

/** Byte offset of the first malformed UTF-8 sequence (a close approximation; used for messages only). */
function invalidUtf8Offset(b: Uint8Array): number {
  for (let i = 0; i < b.length; ) {
    const c = b[i]!
    const n =
      c < 0x80 ? 0 : c >= 0xc2 && c < 0xe0 ? 1 : c >= 0xe0 && c < 0xf0 ? 2 : c >= 0xf0 && c < 0xf5 ? 3 : -1
    if (n < 0) return i
    for (let k = 1; k <= n; k++) if (((b[i + k] ?? 0) & 0xc0) !== 0x80) return i
    i += n + 1
  }
  return 0
}
