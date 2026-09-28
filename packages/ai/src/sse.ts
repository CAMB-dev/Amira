export interface SSEMessage {
  event?: string
  data: string
}

/** Parses a text/event-stream body into messages. Handles chunks split anywhere. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
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

  const reader = body.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let nl = buf.search(/\r?\n/)
      while (nl !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(buf[nl] === "\r" ? nl + 2 : nl + 1)
        if (line === "") {
          const msg = flush()
          if (msg) yield msg
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":")
          const field = colon === -1 ? line : line.slice(0, colon)
          let value = colon === -1 ? "" : line.slice(colon + 1)
          if (value.startsWith(" ")) value = value.slice(1)
          if (field === "data") data.push(value)
          else if (field === "event") event = value
        }
        nl = buf.search(/\r?\n/)
      }
      if (done) break
    }
    if (buf !== "") {
      if (buf.startsWith("data:")) data.push(buf.slice(5).trimStart())
    }
    const msg = flush()
    if (msg) yield msg
  } finally {
    reader.releaseLock()
  }
}
