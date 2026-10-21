import { createHash, randomUUID } from "node:crypto"
import { validateRemoteFrame } from "../remote-schema.ts"
import { RemoteError } from "./errors.ts"
import {
  REMOTE_LIMITS,
  type RemoteChunk,
  type RemoteFrame,
  type RemoteMessage,
  remoteChannel,
} from "./protocol.ts"

// Leaves ample room for base64 expansion and envelope metadata under the line cap.
const CHUNK_BYTES = 128 * 1024
const utf8 = new TextDecoder("utf-8", { fatal: true })
const encode = new TextEncoder()
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

function parse(bytes: Uint8Array): RemoteFrame {
  try {
    return validateRemoteFrame(JSON.parse(utf8.decode(bytes)))
  } catch (error) {
    if (error instanceof RemoteError) throw error
    throw new RemoteError("invalid_frame", "Malformed JSON or UTF-8")
  }
}

/** Validate and serialize one inert copy, retaining it for writer scheduling metadata. */
export function prepareRemoteMessage(message: RemoteMessage): { message: RemoteMessage; bytes: Uint8Array } {
  const frame = validateRemoteFrame(message, { outgoing: true })
  if (frame.kind === "chunk") throw new RemoteError("invalid_frame", "Cannot send a nested chunk")
  const bytes = encode.encode(JSON.stringify(frame))
  if (bytes.byteLength > REMOTE_LIMITS.logicalBytes)
    throw new RemoteError("limit_exceeded", "Logical payload limit exceeded")
  return { message: frame, bytes }
}

export function serializeRemoteMessage(message: RemoteMessage): Uint8Array {
  return prepareRemoteMessage(message).bytes
}

/** Lazy chunk production lets the writer interleave large payloads without an unbounded frame queue. */
export function encodeRemoteMessage(message: RemoteMessage): Generator<Uint8Array> {
  const prepared = prepareRemoteMessage(message)
  return encodeRemoteBytes(prepared.bytes, remoteChannel(prepared.message))
}

/** Internal writer seam: bytes have already been strictly validated and accounted for. */
export function* encodeRemoteBytes(
  bytes: Uint8Array,
  channel: ReturnType<typeof remoteChannel>,
): Generator<Uint8Array> {
  if (bytes.byteLength <= REMOTE_LIMITS.lineBytes) {
    yield encode.encode(`${utf8.decode(bytes)}\n`)
    return
  }
  const transferId = randomUUID()
  const sha256 = hash(bytes)
  const total = Math.ceil(bytes.byteLength / CHUNK_BYTES)
  for (let index = 0; index < total; index++) {
    const chunk: RemoteChunk = {
      v: 1,
      kind: "chunk",
      channel,
      transferId,
      index,
      total,
      bytes: bytes.byteLength,
      sha256,
      data: Buffer.from(bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)).toString("base64"),
    }
    yield encode.encode(`${JSON.stringify(chunk)}\n`)
  }
}

interface Transfer {
  header: RemoteChunk
  parts: Uint8Array[]
  received: number
}

/** A connection owns one decoder. Errors are terminal; callers must close that connection. */
export class RemoteDecoder {
  private parts: Uint8Array[] = []
  private lineBytes = 0
  private transfers = new Map<string, Transfer>()
  private transferBytes = 0
  private failed = false

  push(bytes: Uint8Array): RemoteMessage[] {
    if (this.failed) throw new RemoteError("disconnected", "Decoder has failed")
    const messages: RemoteMessage[] = []
    try {
      let start = 0
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 10) continue
        this.append(bytes.subarray(start, i))
        let line = Buffer.concat(this.parts, this.lineBytes)
        this.parts = []
        this.lineBytes = 0
        if (line.at(-1) === 13) line = line.subarray(0, -1)
        const frame = parse(line)
        const message = frame.kind === "chunk" ? this.chunk(frame) : frame
        if (message) messages.push(message)
        start = i + 1
      }
      this.append(bytes.subarray(start))
      return messages
    } catch (error) {
      this.failed = true
      this.clear()
      throw error
    }
  }

  finish(): void {
    const incomplete = this.lineBytes !== 0 || this.transfers.size !== 0
    this.failed = true
    this.clear()
    // EOF cannot establish that an unfinished line/transfer is malformed. Discard it,
    // but preserve transport-loss typing so a fresh attachment may recover safely.
    if (incomplete) throw new RemoteError("disconnected", "Incomplete remote frame at EOF")
  }

  private clear(): void {
    this.parts = []
    this.lineBytes = 0
    this.transfers.clear()
    this.transferBytes = 0
  }

  private append(bytes: Uint8Array): void {
    if (!bytes.length) return
    this.lineBytes += bytes.length
    if (this.lineBytes > REMOTE_LIMITS.lineBytes)
      throw new RemoteError("limit_exceeded", "Remote line limit exceeded")
    // Do not retain a possibly huge input backing buffer or an externally mutable view.
    this.parts.push(Uint8Array.from(bytes))
  }

  private chunk(frame: RemoteChunk): RemoteMessage | undefined {
    if (frame.total !== Math.ceil(frame.bytes / CHUNK_BYTES) || frame.index >= frame.total)
      throw new RemoteError("invalid_frame", "Invalid chunk dimensions")
    let transfer = this.transfers.get(frame.transferId)
    if (!transfer) {
      if (frame.index !== 0) throw new RemoteError("invalid_frame", "Chunk transfer must start at zero")
      if (
        this.transfers.size >= REMOTE_LIMITS.transfers ||
        this.transferBytes + frame.bytes > REMOTE_LIMITS.transferBytes
      )
        throw new RemoteError("limit_exceeded", "Chunk reassembly limit exceeded")
      transfer = { header: frame, parts: [], received: 0 }
      this.transfers.set(frame.transferId, transfer)
      this.transferBytes += frame.bytes
    }
    const header = transfer.header
    if (
      frame.index !== transfer.parts.length ||
      frame.total !== header.total ||
      frame.bytes !== header.bytes ||
      frame.sha256 !== header.sha256 ||
      frame.channel !== header.channel
    )
      throw new RemoteError("invalid_frame", "Inconsistent or unordered chunks")
    const part = Buffer.from(frame.data, "base64")
    const expected = Math.min(CHUNK_BYTES, frame.bytes - frame.index * CHUNK_BYTES)
    if (part.byteLength !== expected || part.toString("base64") !== frame.data)
      throw new RemoteError("invalid_frame", "Invalid chunk bytes")
    transfer.parts.push(part)
    transfer.received += part.byteLength
    if (transfer.parts.length !== header.total) return undefined
    const bytes = Buffer.concat(transfer.parts, transfer.received)
    this.transfers.delete(frame.transferId)
    this.transferBytes -= header.bytes
    if (hash(bytes) !== header.sha256) throw new RemoteError("invalid_frame", "Chunk checksum mismatch")
    const message = parse(bytes)
    if (message.kind === "chunk" || remoteChannel(message) !== header.channel)
      throw new RemoteError("invalid_frame", "Invalid chunk envelope")
    return message
  }
}
