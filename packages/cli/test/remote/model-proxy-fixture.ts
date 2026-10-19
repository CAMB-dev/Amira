import "../server/offline.ts"
import { type AiOptions, createAi, type Dialect, type ModelRequest, type StreamEvent } from "@amira/ai"
import { RemoteConnection } from "../../src/remote/connection.ts"
import { createModelBroker } from "../../src/remote/model-broker.ts"
import { ModelBrokerPeer } from "../../src/remote/model-peer.ts"
import { ProviderBindings } from "../../src/remote/provider-bindings.ts"
import { ProxyAi } from "../../src/remote/proxy-ai.ts"
import { hello, loopback, welcome } from "./loopback.ts"

export const secret = "SENTINEL_LOCAL_MODEL_SECRET_r5"
export function deferred<T = void>() {
  return Promise.withResolvers<T>()
}
export function proxyFixture(
  stream: Dialect["stream"],
  timeoutMs = 1000,
  compaction?: Dialect["compaction"],
  nativeTimeoutMs = 1000,
  credentials: Pick<AiOptions, "providers" | "env" | "apiKeys"> = {},
) {
  const providers = credentials.providers ?? [
    { id: "p", dialect: "fixture", baseUrl: "https://provider.invalid/v1", apiKey: secret },
  ]
  const ai = createAi({
    providers,
    ...credentials,
    dialects: [{ id: "fixture", stream, ...(compaction ? { compaction } : {}) }],
    retry: { retries: 0, nativeCompactionTimeoutMs: nativeTimeoutMs },
    env: credentials.env ?? {},
    fetch: Object.assign(
      () => {
        throw new Error("No network in proxy tests")
      },
      { preconnect() {} },
    ),
  })
  const bindings = new ProviderBindings(ai, [
    {
      provider: "p",
      localProvider: "p",
      dialect: "fixture",
      endpointOrigin: new URL(providers[0]!.baseUrl).origin,
    },
  ])
  const broker = createModelBroker({ ai, bindings })
  const model = ai.model("p/m")
  const metadata = broker.metadata([model])
  const proxy = new ProxyAi(metadata, { reconnectTimeoutMs: timeoutMs })
  const request: ModelRequest = { model, systemPrompt: "remote instructions", messages: [], tools: [] }
  let peer = new ModelBrokerPeer(broker, { timeoutMs })
  const connections: RemoteConnection[] = []
  const observed: string[] = [JSON.stringify(metadata)]
  const sent: string[] = []
  let generation = 0
  async function connect(
    replace = false,
    hooks: {
      localWrite?(bytes: Uint8Array): Promise<void>
      serverWrite?(bytes: Uint8Array): Promise<void>
    } = {},
  ) {
    if (replace) {
      peer.close()
      peer = new ModelBrokerPeer(broker, { timeoutMs })
    }
    const pipes = loopback(37)
    const io = {
      ...pipes.client,
      async write(bytes: Uint8Array) {
        observed.push(Buffer.from(bytes).toString())
        await hooks.localWrite?.(bytes)
        await pipes.client.write(bytes)
      },
    }
    const local = peer.connect(io, hello)
    const serverIO = {
      ...pipes.server,
      async write(bytes: Uint8Array) {
        sent.push(Buffer.from(bytes).toString())
        await hooks.serverWrite?.(bytes)
        await pipes.server.write(bytes)
      },
    }
    const server = new RemoteConnection(serverIO, {
      handshake: { role: "server", accept: () => ({ ...welcome, controllerGeneration: ++generation }) },
      onMessage: (message) => proxy.receive(server, message),
    })
    const [authority] = await Promise.all([server.ready, local.ready])
    proxy.attach(server, authority)
    connections.push(server, local)
    return server
  }
  return {
    ai,
    proxy,
    broker,
    bindings,
    request,
    observed,
    sent,
    connect,
    close() {
      proxy.close()
      peer.close()
      for (const connection of connections) connection.close()
    },
  }
}
export async function collectEvents(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
