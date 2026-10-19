import { RemoteConnection } from "../../src/remote/connection.ts"
import { ModelBrokerPeer } from "../../src/remote/model-peer.ts"
import type { RemoteMessage } from "../../src/remote/protocol.ts"
import { hello, loopback, welcome } from "./loopback.ts"
import { proxyFixture } from "./model-proxy-fixture.ts"

/** Dedicated attachment controls; all model traffic still crosses the real byte codec. */
export function transportFixture(...args: Parameters<typeof proxyFixture>) {
  const fixture = proxyFixture(...args)
  const peer = new ModelBrokerPeer(fixture.broker, { timeoutMs: 1000 })
  const connections: RemoteConnection[] = []
  let generation = 0
  return {
    ...fixture,
    async connectTransport(
      hooks: { localWrite?(bytes: Uint8Array): Promise<void>; received?(message: RemoteMessage): void } = {},
    ) {
      const pipes = loopback(37)
      const local = peer.connect(
        {
          ...pipes.client,
          async write(bytes) {
            await hooks.localWrite?.(bytes)
            await pipes.client.write(bytes)
          },
        },
        hello,
      )
      const server = new RemoteConnection(pipes.server, {
        handshake: { role: "server", accept: () => ({ ...welcome, controllerGeneration: ++generation }) },
        onMessage(message) {
          fixture.proxy.receive(server, message)
          hooks.received?.(message)
        },
      })
      connections.push(local, server)
      const [authority] = await Promise.all([server.ready, local.ready])
      fixture.proxy.attach(server, authority)
      return { local, server }
    },
    close() {
      fixture.close()
      peer.close()
      for (const connection of connections) connection.close()
    },
  }
}

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export async function bounded<T>(promise: Promise<T>, ms = 350): Promise<T | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<"pending">((resolve) => {
        timer = setTimeout(() => resolve("pending"), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
