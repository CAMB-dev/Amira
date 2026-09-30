export interface SSEMessage {
  event?: string
  data: string
}

/**
 * Parses a text/event-stream body into messages. Handles chunks split anywhere and
 * CRLF, LF or CR line endings. Stopping iteration early cancels the body.
 *
 * With a signal, an abort ends the stream with its reason before the next message, even one
 * already read: one chunk can hold the rest of a reply, success included, and nothing may
 * follow the message during which the consumer aborted.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEMessage> {
  const decoder = new TextDecoder()
  let buf = ""
  let event: string | undefined
  let data: string[] = []

  const flush = (): SSEMessage | undefined => {
    if (data.length === 0) {
      event = undefined
      return undefined
    }
    const msg: SSEMessage = { data: data.join("\n") }
    if (event) msg.event = event
    event = undefined
    data = []
    return msg
  }

  const onLine = (line: string): SSEMessage | undefined => {
    if (line === "") return flush()
    if (line.startsWith(":")) return undefined
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") data.push(value)
    else if (field === "event") event = value
    return undefined
  }

  const reader = body.getReader()
  const eol = /\r\n|\r|\n/g
  let scanFrom = 0
  let finished = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let start = 0
      eol.lastIndex = scanFrom
      let heldCR = false
      for (let m = eol.exec(buf); m; m = eol.exec(buf)) {
        // A trailing CR may be the first half of a CRLF split across chunks.
        if (!done && m[0] === "\r" && m.index === buf.length - 1) {
          heldCR = true
          break
        }
        const msg = onLine(buf.slice(start, m.index))
        if (msg) {
          yield msg
          signal?.throwIfAborted()
        }
        start = eol.lastIndex
      }
      buf = buf.slice(start)
      scanFrom = heldCR ? buf.length - 1 : buf.length
      if (done) break
    }
    if (buf !== "") {
      const msg = onLine(buf)
      if (msg) yield msg
    }
    const msg = flush()
    if (msg) yield msg
    // The last message too: the consumer may have aborted during it.
    signal?.throwIfAborted()
    finished = true
  } finally {
    if (!finished) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
