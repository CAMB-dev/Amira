// Prepares images for the full-screen view off the main thread (see prepare.ts).
import { type PrepareRequest, prepareImage } from "./prepare.ts"

declare const self: Worker

self.onmessage = (e: MessageEvent<{ id: number; req: PrepareRequest }>) => {
  const { id, req } = e.data
  try {
    self.postMessage({ id, ok: true, prepared: prepareImage(req) })
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
