import "../server/offline.ts"
import { expect, test } from "bun:test"
import { createAi } from "@amira/ai"
import { localModelBindings } from "../../src/remote/local-models.ts"
import { ProxyAi } from "../../src/remote/proxy-ai.ts"
import { validateRemoteParams, validateRemoteResult } from "../../src/remote-schema.ts"
import type { ServerOperations } from "../../src/server/operations.ts"

function fixture() {
  const ai = createAi({
    providers: [
      { id: "p", dialect: "fixture", baseUrl: "https://billing.invalid/v1", apiKey: "LOCAL_SENTINEL" },
    ],
    dialects: [
      {
        id: "fixture",
        stream() {
          throw new Error("not executed")
        },
      },
    ],
    env: {},
  })
  const model = ai.model("p/m")
  const proxy = new ProxyAi(
    [{ model, revision: "unbound", available: false, replay: ai.replayTarget(model) }],
    {
      origins: [{ provider: "p", origin: "https://remote.invalid" }],
    },
  )
  const observed: unknown[] = []
  const port = {
    async request<K extends "proxy.describe" | "proxy.bind">(
      operation: K,
      params: ServerOperations[K]["params"],
    ): Promise<ServerOperations[K]["result"]> {
      validateRemoteParams(operation, params)
      observed.push(params)
      let result: ServerOperations["proxy.describe"]["result"] | ServerOperations["proxy.bind"]["result"]
      if (operation === "proxy.describe") result = proxy.describeBindings()
      else {
        proxy.bindMetadata((params as ServerOperations["proxy.bind"]["params"]).metadata)
        result = { sessionGeneration: 0 }
      }
      validateRemoteResult(operation, result)
      observed.push(result)
      return result as ServerOperations[K]["result"]
    },
  }
  return { ai, proxy, port, observed }
}

test("local model binding approval discloses billing identity and is retained across reconnect", async () => {
  const { ai, proxy, port, observed } = fixture()
  let approvals = 0
  const local = localModelBindings(ai, async (binding) => {
    approvals++
    expect(binding).toMatchObject({
      endpointOrigin: "https://billing.invalid",
      remoteOrigin: "https://remote.invalid",
    })
    return true
  })
  try {
    await local.negotiate(port)
    expect(proxy.hasKey("p")).toBe(true)
    await local.negotiate(port)
    expect(approvals).toBe(1)
    expect(JSON.stringify(observed)).not.toContain("LOCAL_SENTINEL")
    const metadata = local.broker.metadata([proxy.model("p/m")])
    metadata[0]!.model.contextWindow++
    expect(() => proxy.bindMetadata(metadata)).toThrow("remote configuration")
  } finally {
    proxy.close()
  }
})

test("declining local provider approval never enables the remote selected model", async () => {
  const { ai, proxy, port } = fixture()
  try {
    await localModelBindings(ai, async () => false).negotiate(port)
    expect(proxy.hasKey("p")).toBe(false)
    expect(proxy.model("p/m").provider).toBe("p")
  } finally {
    proxy.close()
  }
})
