import { randomBytes } from "node:crypto"
import { open, rm } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { WebFetchDetails } from "@amira/api"
import { sessionOutputDir } from "@amira/api/internal/session-output-dir"

const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/x-gzip": ".gz",
  "application/x-tar": ".tar",
  "application/wasm": ".wasm",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "image/x-icon": ".ico",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
}

/** Only a single, portable filename component; no URL text can choose a directory. */
function filename(url: URL, contentType: string): string {
  let raw = url.pathname.split("/").pop() || "download"
  try {
    raw = decodeURIComponent(raw)
  } catch {}
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^[._-]+/, "") || "download"
  const suffix = extname(safe)
  const extension = EXTENSIONS[contentType] ?? (/^\.[a-zA-Z0-9]{1,10}$/.test(suffix) ? suffix : ".bin")
  const stem = (suffix ? safe.slice(0, -suffix.length) : safe).slice(0, 80) || "download"
  // Windows reserves device names even before a dot, e.g. CON.report.pdf.
  const portable = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem) ? `download-${stem}` : stem
  return `${portable}-${randomBytes(8).toString("hex")}${extension}`
}

/** Replay a sniffed prefix; cancellation starts cleanup but must not wait on a remote source. */
function replayBody(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel">,
  chunks: Uint8Array[] = [],
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = chunks.shift()
      if (chunk) {
        controller.enqueue(chunk)
        return
      }
      const next = await reader.read()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {})
    },
  })
}

/** Stream to the session's outputs directory, removing incomplete files on every failure. */
export async function saveBinary(
  res: Response,
  url: URL,
  contentType: string,
  dir: string,
  sessionDir: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<NonNullable<WebFetchDetails["saved"]>> {
  const name = filename(url, contentType)
  let path = join(dir, name)
  let bytes = 0
  let created = false
  try {
    signal.throwIfAborted()
    path = join(await sessionOutputDir(dir, dirname(sessionDir)), name)
    signal.throwIfAborted()
    const file = await open(path, "wx", 0o600)
    created = true
    try {
      const cap = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length
          if (bytes > maxBytes) {
            callback(
              new Error(
                `binary response exceeds the ${maxBytes} byte download cap (web.fetch.maxBinaryBytes)`,
              ),
            )
          } else {
            callback(null, chunk)
          }
        },
      })
      await pipeline(
        res.body ? Readable.fromWeb(replayBody(res.body.getReader())) : Readable.from([]),
        cap,
        file.createWriteStream(),
        { signal },
      )
    } finally {
      await file.close()
    }
  } catch (err) {
    void res.body?.cancel().catch(() => {})
    if (created) await rm(path, { force: true })
    throw err
  }
  return { path, name: basename(path), contentType, bytes }
}

/** Peek within the text budget (up to 1 KiB, at least the 5-byte PDF signature), then replay. */
export async function sniffBody(
  res: Response,
  signal: AbortSignal,
  textBudget: number,
): Promise<{ head: Uint8Array; response: Response }> {
  if (!res.body) return { head: new Uint8Array(), response: res }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  const head = new Uint8Array(Math.min(1024, Math.max(5, textBudget)))
  let size = 0
  const abort = () => void reader.cancel(signal.reason).catch(() => {})
  signal.addEventListener("abort", abort, { once: true })
  try {
    signal.throwIfAborted()
    while (size < head.length) {
      const next = await reader.read()
      signal.throwIfAborted()
      if (next.done) break
      chunks.push(next.value)
      const part = next.value.subarray(0, head.length - size)
      head.set(part, size)
      size += part.length
    }
  } catch (err) {
    void reader.cancel().catch(() => {})
    throw err
  } finally {
    signal.removeEventListener("abort", abort)
  }
  const body = replayBody(reader, chunks)
  return {
    head: head.subarray(0, size),
    response: new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers }),
  }
}
