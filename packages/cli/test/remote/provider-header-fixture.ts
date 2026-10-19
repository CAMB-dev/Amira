import "../server/offline.ts"
import type { Ai, ModelRequest } from "@amira/ai"
import { RemoteConnection } from "../../src/remote/connection.ts"
import { createModelBroker } from "../../src/remote/model-broker.ts"
import { ModelBrokerPeer } from "../../src/remote/model-peer.ts"
import { ProviderBindings } from "../../src/remote/provider-bindings.ts"
import { ProxyAi } from "../../src/remote/proxy-ai.ts"
import { hello, loopback, welcome } from "./loopback.ts"

/** Real framing and broker delivery around an Ai with an injected, non-network fetch. */
export function providerHeaderFixture(ai: Ai) {
  const model = ai.model("p/header-echo")
  const bindings = new ProviderBindings(ai, [
    {
      provider: model.provider,
      localProvider: model.provider,
      dialect: model.dialect,
      endpointOrigin: new URL(ai.providerEndpoint(model.provider).baseUrl).origin,
    },
  ])
  const broker = createModelBroker({ ai, bindings })
  const metadata = broker.metadata([model])
  const proxy = new ProxyAi(metadata, { reconnectTimeoutMs: 1000 })
  const peer = new ModelBrokerPeer(broker, { timeoutMs: 1000 })
  const observed = [JSON.stringify(metadata)]
  const connections: RemoteConnection[] = []
  const request: ModelRequest = { model, systemPrompt: "", messages: [], tools: [] }
  return {
    proxy,
    request,
    observed,
    async connect() {
      const pipes = loopback(37)
      const local = peer.connect(
        {
          ...pipes.client,
          async write(bytes) {
            observed.push(Buffer.from(bytes).toString())
            await pipes.client.write(bytes)
          },
        },
        hello,
      )
      const server = new RemoteConnection(pipes.server, {
        handshake: { role: "server", accept: () => welcome },
        onMessage: (message) => proxy.receive(server, message),
      })
      connections.push(local, server)
      const [authority] = await Promise.all([server.ready, local.ready])
      proxy.attach(server, authority)
    },
    close() {
      proxy.close()
      peer.close()
      for (const connection of connections) connection.close()
    },
  }
}
