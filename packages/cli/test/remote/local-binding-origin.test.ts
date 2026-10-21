import "../server/offline.ts"
import { expect, test } from "bun:test"
import { createAi } from "@amira/ai"
import { localModelBindings } from "../../src/remote/local-models.ts"
import { ProxyAi } from "../../src/remote/proxy-ai.ts"
import type { ServerOperations } from "../../src/server/operations.ts"

test("changed remote endpoint identity invalidates approval instead of reusing a local key", async () => {
  const ai = createAi({
    providers: [
      { id: "p", dialect: "openai-chat", baseUrl: "https://billing.invalid", apiKey: "not-on-wire" },
    ],
    env: {},
  })
  const model = ai.model("p/m")
  const origins = [{ provider: "p", origin: "https://first.invalid" }]
  const proxy = new ProxyAi(
    [{ model, available: false, revision: "unbound", replay: ai.replayTarget(model) }],
    { origins },
  )
  let approvals = 0
  const local = localModelBindings(ai, async () => ++approvals === 1)
  const port = {
    async request<K extends "proxy.describe" | "proxy.bind">(
      operation: K,
      params: ServerOperations[K]["params"],
    ): Promise<ServerOperations[K]["result"]> {
      if (operation === "proxy.describe") return proxy.describeBindings() as ServerOperations[K]["result"]
      proxy.bindMetadata((params as ServerOperations["proxy.bind"]["params"]).metadata)
      return { sessionGeneration: 0 } as ServerOperations[K]["result"]
    },
  }
  try {
    await local.negotiate(port)
    expect(proxy.hasKey("p")).toBe(true)
    origins[0]!.origin = "https://changed.invalid"
    await local.negotiate(port)
    expect(approvals).toBe(2)
    expect(proxy.hasKey("p")).toBe(false)
  } finally {
    proxy.close()
  }
})
