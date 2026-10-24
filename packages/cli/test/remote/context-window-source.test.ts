import "../server/offline.ts"
import { expect, test } from "bun:test"
import { RemoteDecoder } from "../../src/remote/codec.ts"
import { RemoteConnection, type RemoteIO } from "../../src/remote/connection.ts"
import { encodeModelRequest } from "../../src/remote/model-codec.ts"
import { remoteMessageForPeer } from "../../src/remote/peer-compat.ts"
import {
  CONTEXT_WINDOW_SOURCE_PROVIDER_CAPABILITY,
  type RemoteJson,
  type RemoteMessage,
} from "../../src/remote/protocol.ts"
import { enumeration, matches, type Schema } from "../../src/remote/schema/base.ts"
import { copyRemoteJson, REMOTE_FRAME_SCHEMAS } from "../../src/remote-schema.ts"
import { hello, loopback, welcome } from "./loopback.ts"
import { model, modelParams, operationFixtures, snapshot } from "./schema-fixtures.ts"

const capability = CONTEXT_WINDOW_SOURCE_PROVIDER_CAPABILITY
const previousSource = enumeration("settings", "catalog", "default")
const previousSchemas = new WeakMap<Schema, Schema>()

/** The previous wire schema differs only in the two contextWindowSource enums. */
function previousSchema(schema: Schema): Schema {
  const cached = previousSchemas.get(schema)
  if (cached) return cached
  const previous: Schema = {
    ...schema,
    ...(schema.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(schema.properties).map(([key, child]) => [
              key,
              key === "contextWindowSource" ? previousSource : previousSchema(child),
            ]),
          ),
        }
      : {}),
    ...(schema.items ? { items: previousSchema(schema.items) } : {}),
    ...(schema.oneOf ? { oneOf: schema.oneOf.map(previousSchema) } : {}),
    ...(schema.anyOf ? { anyOf: schema.anyOf.map(previousSchema) } : {}),
    ...(schema.additionalProperties && { additionalProperties: previousSchema(schema.additionalProperties) }),
  }
  previousSchemas.set(schema, previous)
  return previous
}

function checkedIO(io: RemoteIO, understands: boolean, frames: RemoteMessage[]): RemoteIO {
  const decoder = new RemoteDecoder()
  return {
    ...io,
    async write(bytes) {
      for (const frame of decoder.push(bytes)) {
        const schema = REMOTE_FRAME_SCHEMAS[frame.kind]
        expect(matches(copyRemoteJson(frame), understands ? schema : previousSchema(schema))).toBe(true)
        frames.push(frame)
      }
      await io.write(bytes)
    },
  }
}

const providerModel = {
  ...model,
  contextWindow: 320_000,
  maxOutput: 16_000,
  contextWindowSource: "provider" as const,
}
const metadata = [
  {
    model: providerModel,
    revision: "binding-1",
    available: true,
    replay: {
      dialect: model.dialect,
      provider: model.provider,
      host: "mock.invalid",
      model: model.id,
      webSearch: false,
    },
  },
]
const status = {
  ...operationFixtures["status.read"].result,
  info: {
    ...operationFixtures["status.read"].result.info,
    contextWindow: 320_000,
    contextWindowSource: "provider" as const,
  },
}
const semantic = { status, models: [], subagents: [], groups: [] }
const workspace = {
  frontend: snapshot,
  semantic,
  pendingRequests: [],
  startupEvents: [],
  activity: { events: [] },
  owners: {},
  jobs: [],
}

test.each([
  { clientUnderstands: false, daemonUnderstands: false },
  { clientUnderstands: true, daemonUnderstands: false },
  { clientUnderstands: false, daemonUnderstands: true },
  { clientUnderstands: true, daemonUnderstands: true },
])(
  "negotiates source metadata: client=$clientUnderstands daemon=$daemonUnderstands",
  async ({ clientUnderstands, daemonUnderstands }) => {
    const io = loopback(17)
    const toDaemon: RemoteMessage[] = []
    const toClient: RemoteMessage[] = []
    const server = new RemoteConnection(checkedIO(io.server, clientUnderstands, toClient), {
      handshake: {
        role: "server",
        accept: () => ({ ...welcome, capabilities: daemonUnderstands ? [capability] : [] }),
      },
      async handle(request): Promise<RemoteJson> {
        if (request.op === "proxy.bind") return { sessionGeneration: 1 }
        if (request.op === "proxy.describe") return { enabled: true, models: [providerModel], origins: [] }
        return status
      },
    })
    const client = new RemoteConnection(checkedIO(io.client, daemonUnderstands, toDaemon), {
      handshake: { role: "client", hello: { ...hello, capabilities: clientUnderstands ? [capability] : [] } },
      async handle() {
        return { accepted: true }
      },
    })
    try {
      await client.request("proxy.bind", { metadata })
      const binding = toDaemon.find((frame) => frame.kind === "request" && frame.op === "proxy.bind")!
      const expectedModel = { ...providerModel }
      if (!daemonUnderstands) Reflect.deleteProperty(expectedModel, "contextWindowSource")
      expect(binding).toMatchObject({ params: { metadata: [{ ...metadata[0], model: expectedModel }] } })
      expect(JSON.stringify(binding).includes('"contextWindowSource":"provider"')).toBe(daemonUnderstands)

      const result = await client.request("status.read", {})
      const expectedInfo = { ...status.info }
      if (!clientUnderstands) Reflect.deleteProperty(expectedInfo, "contextWindowSource")
      expect(result).toEqual({ ...status, info: expectedInfo })
      const description = await client.request("proxy.describe", {})
      const describedModel = { ...providerModel }
      if (!clientUnderstands) Reflect.deleteProperty(describedModel, "contextWindowSource")
      expect(description).toEqual({ enabled: true, models: [describedModel], origins: [] })

      await server.send({
        v: 1,
        kind: "reset",
        daemonEpoch: "epoch-1",
        seq: 0,
        reason: "fresh",
        snapshot: workspace,
      })
      await server.send({
        v: 1,
        kind: "event",
        daemonEpoch: "epoch-1",
        seq: 1,
        payload: { kind: "semantic", semantic },
      })
      for (const frame of toClient.filter((frame) => frame.kind === "reset" || frame.kind === "event")) {
        expect(JSON.stringify(frame).includes('"contextWindowSource":"provider"')).toBe(clientUnderstands)
        expect(JSON.stringify(frame)).toContain('"contextWindow":320000')
      }
      const request = { ...modelParams.request, model: providerModel }
      await server.request("model.open", {
        callId: "call-1",
        revision: "binding-1",
        operation: "stream",
        request: copyRemoteJson(encodeModelRequest(request)),
        resume: false,
        after: 0,
      })
      const opening = toClient.find((frame) => frame.kind === "request" && frame.op === "model.open")!
      expect(JSON.stringify(opening).includes('"contextWindowSource":"provider"')).toBe(clientUnderstands)
      expect(JSON.stringify(opening)).toContain('"maxOutput":16000')
      expect(providerModel.contextWindowSource).toBe("provider")
      expect(status.info.contextWindowSource).toBe("provider")
    } finally {
      client.close()
      server.close()
    }
  },
)

test("downgrading preserves existing sources and opaque tool/user data without mutating the original", () => {
  const opaque = { contextWindowSource: "provider", contextWindow: 123, maxOutput: 45 }
  for (const contextWindowSource of ["settings", "provider", "catalog", "default"] as const) {
    const frame: RemoteMessage = {
      v: 1,
      kind: "request",
      channel: "model",
      id: "request-1",
      controllerGeneration: 1,
      sessionGeneration: 1,
      op: "model.stream",
      params: {
        request: {
          ...modelParams.request,
          model: { ...providerModel, contextWindowSource },
          tools: [{ name: "read", description: "read", parameters: opaque }],
          messages: [
            {
              role: "assistant",
              model: { provider: "mock", model: "test" },
              content: [{ type: "toolCall", id: "call-1", name: "read", args: opaque }],
            },
            {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "read",
              content: [],
              isError: false,
              details: opaque,
            },
          ],
        },
      },
    }
    const before = JSON.stringify(frame)
    const downgraded = remoteMessageForPeer(frame, [])
    const expected = { ...providerModel, contextWindowSource }
    if (contextWindowSource === "provider") Reflect.deleteProperty(expected, "contextWindowSource")
    expect(downgraded).toMatchObject({
      params: {
        request: {
          model: expected,
          tools: [{ parameters: opaque }],
          messages: [{ content: [{ args: opaque }] }, { details: opaque }],
        },
      },
    })
    expect(matches(copyRemoteJson(downgraded), previousSchema(REMOTE_FRAME_SCHEMAS.request))).toBe(true)
    expect(JSON.stringify(frame)).toBe(before)
    expect(remoteMessageForPeer(frame, [capability])).toBe(frame)
  }
})

test("downgrading still rejects getters and unknown model fields before inspecting payloads", () => {
  let reads = 0
  const modelWithGetter = {
    ...providerModel,
    get contextWindowSource() {
      reads++
      return "provider"
    },
  }
  const response = {
    v: 1 as const,
    kind: "response" as const,
    channel: "control" as const,
    id: "response-1",
    op: "proxy.describe" as const,
    ok: true as const,
    result: { enabled: true, origins: [], models: [modelWithGetter] },
  }
  expect(() => remoteMessageForPeer(response, [])).toThrow()
  expect(reads).toBe(0)
  expect(() =>
    remoteMessageForPeer(
      { ...response, result: { ...response.result, models: [{ ...providerModel, secret: "not-on-wire" }] } },
      [],
    ),
  ).toThrow()
})
