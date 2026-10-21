import { expect, test } from "bun:test"
import { emptyUsage } from "@amira/ai"
import { ModelBrokerPeer } from "../../src/remote/model-peer.ts"
import { agentPortFixture, until } from "./agent-port-fixture.ts"
import { proxyFixture } from "./model-proxy-fixture.ts"

test("injectable broker shares the port attachment and model output reaches the authoritative transcript", async () => {
  let streams = 0
  const model = proxyFixture(async function* () {
    streams++
    yield {
      type: "done",
      message: {
        role: "assistant",
        model: { provider: "p", model: "m" },
        content: [{ type: "text", text: "local broker answer" }],
        usage: emptyUsage(),
        stopReason: "end",
      },
    }
  })
  const peer = new ModelBrokerPeer(model.broker)
  try {
    const f = await agentPortFixture(
      { ai: model.proxy, modelProxy: model.proxy, model: "p/m" },
      { brokerPeer: peer },
    )
    try {
      const negotiate = () =>
        f.port.request("proxy.bind", {
          metadata: model.broker.metadata([model.request.model]),
        })
      await negotiate()
      await f.port.execute("turn.prompt", { message: "use injected local model" })
      await until(() =>
        f.port.snapshot.transcript.messages.some((entry) => entry.message.role === "assistant"),
      )
      expect(streams).toBe(1)
      expect(JSON.stringify(f.port.snapshot.transcript)).toContain("local broker answer")
      f.disconnect()
      await until(() => f.port.status === "disconnected")
      await f.port.reconnect()
      await negotiate()
      await f.port.execute("turn.prompt", { message: "after reconnect" })
      await until(() => streams === 2)
    } finally {
      await f.close()
    }
  } finally {
    peer.close()
    model.close()
  }
})
