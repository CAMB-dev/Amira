// Owns one MCP server process. Spawning can block its thread for seconds on some Windows
// machines (antivirus scanning), so it happens here instead of on the main thread.
import { type FromPipeWorker, openPipe, type PipeHandle, type ToPipeWorker } from "./pipe.ts"

declare const self: Worker

let pipe: PipeHandle | undefined
const post = (m: FromPipeWorker) => self.postMessage(m)

self.onmessage = (e: MessageEvent<ToPipeWorker>) => {
  const msg = e.data
  if (msg.type === "open") pipe ??= openPipe(msg.spec, post)
  else if (msg.type === "write") pipe?.write(msg.data)
  else pipe?.close(msg.graceMs)
}

post({ type: "ready" })
