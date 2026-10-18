import "../server/offline.ts"
import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { encodeRemoteMessage } from "../../src/remote/codec.ts"
import { RemoteWriter } from "../../src/remote/writer.ts"
import { validateRemoteFrame } from "../../src/remote-schema.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"

const request = (op: string, params: unknown) => ({
  v: 1,
  kind: "request",
  id: "r1",
  channel: "control",
  controllerGeneration: 1,
  sessionGeneration: 1,
  op,
  params,
})

test("invalid required params, enums, types and unknown fields never reach remote dispatch", () => {
  for (const invalid of [
    request("turn.prompt", {}),
    request("thinking.set", { level: "not-an-effort" }),
    request("fastMode.set", { enabled: "false", extra: "unexpected" }),
  ])
    expect(() => validateRemoteFrame(invalid)).toThrow()
})

test("direct workspace operations reject malformed params before changing runtime state", async () => {
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const runtime = await createWorkspaceRuntime({
    cwd: process.env.HOME!,
    ai,
    model: "mock/test",
    autoTitle: false,
    builtins: async () => [],
  })
  try {
    const attached = runtime.attach()
    await expect(
      attached.request("fastMode.set", { enabled: "false", extra: "unexpected" } as never),
    ).rejects.toThrow()
    await expect(attached.request("thinking.set", { level: "not-an-effort" } as never)).rejects.toThrow()
    expect((await attached.request("status.read", {})).info.fastMode?.requested).toBe(false)
    await expect(attached.execute("turn.prompt", {} as never)).rejects.toThrow()
  } finally {
    await runtime.stop()
  }
})

test("array subclasses with inherited serialization hooks are rejected before yielding or writing bytes", async () => {
  class Replaced extends Array<string> {
    toJSON() {
      return "replacement"
    }
  }
  const message = {
    v: 1 as const,
    kind: "event" as const,
    daemonEpoch: "epoch-1",
    seq: 1,
    payload: {
      seq: 1,
      ts: 1,
      sessionId: "s1",
      type: "tool.execute.start",
      data: { toolCallId: "call-1", name: "read", args: { array: new Replaced("original") } },
    },
  }
  expect(() => [...encodeRemoteMessage(message)]).toThrow()
  let writes = 0
  const writer = new RemoteWriter(async () => {
    writes++
  })
  try {
    await expect(writer.send(message)).rejects.toThrow()
    expect(writes).toBe(0)
  } finally {
    writer.close()
  }
})
