import type { RemoteIO } from "../../src/remote/connection.ts"
import { REMOTE_PEER_LIMITS, type RemoteHello, type RemoteWelcome } from "../../src/remote/protocol.ts"

class BytePipe implements AsyncIterable<Uint8Array> {
  private queue: Uint8Array[] = []
  private wake?: () => void
  private ended = false

  push(bytes: Uint8Array): void {
    if (this.ended) throw new Error("Pipe closed")
    this.queue.push(Uint8Array.from(bytes))
    this.wake?.()
  }
  close(): void {
    this.ended = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    while (true) {
      const item = this.queue.shift()
      if (item) yield item
      else if (this.ended) return
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
    }
  }
}

/** In-memory bytes only: every test traverses the real codec, never direct object callbacks. */
export function loopback(fragment = Number.POSITIVE_INFINITY): {
  client: RemoteIO
  server: RemoteIO
  injectServer(bytes: Uint8Array): void
} {
  const toClient = new BytePipe()
  const toServer = new BytePipe()
  const endpoint = (input: BytePipe, output: BytePipe): RemoteIO => ({
    input,
    async write(bytes) {
      for (let i = 0; i < bytes.length; i += fragment) output.push(bytes.subarray(i, i + fragment))
      await Promise.resolve()
    },
    close() {
      input.close()
      output.close()
    },
  })
  return {
    client: endpoint(toClient, toServer),
    server: endpoint(toServer, toClient),
    injectServer: (bytes) => toServer.push(bytes),
  }
}

const release = { version: "test", buildId: "fixture", target: "test-native" }
export const hello: RemoteHello = {
  v: 1,
  kind: "hello",
  clientId: "client-1",
  workspace: "/srv/世界",
  release,
  limits: REMOTE_PEER_LIMITS,
  capabilities: ["model.proxy"],
}
export const welcome: RemoteWelcome = {
  v: 1,
  kind: "welcome",
  release,
  daemonEpoch: "epoch-1",
  workspaceId: "workspace-1",
  workspace: "/srv/世界",
  sessionGeneration: 1,
  controllerGeneration: 1,
  limits: REMOTE_PEER_LIMITS,
  capabilities: ["model.proxy"],
}
