import "../server/offline.ts"
import { expect, test } from "bun:test"
import type { AssistantMessage, CompactResult, ModelRequest, ToolResultMessage } from "@amira/ai"
import type { EventMap } from "@amira/api"
import { encodeRemoteMessage, RemoteDecoder } from "../../src/remote/codec.ts"
import type { RemoteFrame, RemoteJson, RemoteMessage, RemoteOperation } from "../../src/remote/protocol.ts"
import { REMOTE_OPERATIONS } from "../../src/remote/protocol.ts"
import {
  validateRemoteDto,
  validateRemoteFrame,
  validateRemoteParams,
  validateRemoteResult,
} from "../../src/remote-schema.ts"
import { allStreamTypesCovered, eventFixtures, streamFixtures } from "./schema-events.ts"
import { assistant, modelParams, operationFixtures, snapshot, usage, user } from "./schema-fixtures.ts"

const channel = (op: RemoteOperation) =>
  op === "model.stream" || op === "model.compact" ? ("model" as const) : ("control" as const)
function request(op: RemoteOperation, params: unknown) {
  return {
    v: 1,
    kind: "request",
    channel: channel(op),
    id: "r1",
    controllerGeneration: 1,
    sessionGeneration: 1,
    op,
    params,
  }
}
function response(op: RemoteOperation, result: unknown) {
  return { v: 1, kind: "response", channel: channel(op), id: "r1", op, ok: true, result }
}
function event(payload: RemoteJson): RemoteMessage {
  return { v: 1, kind: "event", daemonEpoch: "epoch-1", seq: 1, payload }
}
function roundtrip(message: RemoteFrame) {
  if (message.kind === "chunk") throw new Error("Expected a complete message fixture")
  const decoder = new RemoteDecoder()
  const decoded = [...encodeRemoteMessage(message)].flatMap((bytes) => decoder.push(bytes))
  decoder.finish()
  expect(decoded).toEqual([message])
}

test("operation fixtures cover the entire finite wire surface", () => {
  expect(Object.keys(operationFixtures).sort()).toEqual([...REMOTE_OPERATIONS].sort())
  expect(allStreamTypesCovered).toBe(true)
})

for (const op of REMOTE_OPERATIONS) {
  const fixture = operationFixtures[op]
  test(`${op} validates and roundtrips its own required params and result DTO`, () => {
    validateRemoteParams(op, fixture.params)
    validateRemoteResult(op, fixture.result)
    roundtrip(validateRemoteFrame(request(op, fixture.params)))
    roundtrip(validateRemoteFrame(response(op, fixture.result)))
    for (const invalid of fixture.invalidParams) {
      expect(() => validateRemoteParams(op, invalid)).toThrow()
      expect(() => validateRemoteFrame(request(op, invalid))).toThrow()
    }
    for (const invalid of fixture.invalidResults) {
      expect(() => validateRemoteResult(op, invalid)).toThrow()
      expect(() => validateRemoteFrame(response(op, invalid))).toThrow()
    }
    expect(() => validateRemoteParams(op, { ...fixture.params, unexpected: true })).toThrow()
    if (fixture.result && typeof fixture.result === "object" && !Array.isArray(fixture.result))
      expect(() => validateRemoteResult(op, { ...fixture.result, unexpected: true })).toThrow()
  })
}

for (const [type, data] of Object.entries(eventFixtures)) {
  test(`core event ${type} validates its envelope and closed data DTO`, () => {
    const payload = { seq: 1, ts: 1234, sessionId: "s1", parentSessionId: "parent", turnId: "t1", type, data }
    validateRemoteDto("coreEvent", payload)
    roundtrip(event(payload))
    for (const invalid of [
      { ...payload, unexpected: true },
      { ...payload, data: null },
      { ...payload, data: { ...data, unexpected: true } },
      { ...payload, sessionId: 1 },
    ]) {
      expect(() => validateRemoteDto("coreEvent", invalid)).toThrow()
      expect(() => validateRemoteFrame(event(invalid))).toThrow()
    }
    const { data: _missing, ...missingData } = payload
    expect(() => validateRemoteDto("coreEvent", missingData)).toThrow()
  })
}

for (const fixture of streamFixtures) {
  test(`model event ${fixture.type} validates and roundtrips without admitting unknown fields`, () => {
    roundtrip({ v: 1, kind: "model.event", callId: "call-1", seq: 1, event: fixture })
    for (const invalid of [{ ...fixture, unexpected: true }, { ...fixture, type: "unknown" }, {}])
      expect(() =>
        validateRemoteFrame({ v: 1, kind: "model.event", callId: "call-1", seq: 1, event: invalid }),
      ).toThrow()
  })
}

test("rich model messages, metadata and native-compaction results keep their strict nested DTOs", () => {
  const message = {
    ...assistant,
    content: [
      {
        type: "text",
        text: "cited",
        citations: [{ url: "https://source.invalid", title: "Source", start: 0, end: 5 }],
      },
      {
        type: "thinking",
        text: "",
        redacted: true,
        signature: { dialect: "mock", value: "opaque", kind: "checkpoint" },
      },
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        args: { path: "/srv/file", arbitrary: [true, null, 1] },
      },
      {
        type: "serverTool",
        id: "web-1",
        name: "web_search",
        input: { query: "test" },
        status: "done",
        sources: [{ url: "https://source.invalid" }],
        searchEntryPoint: { renderedContent: "suggestion", sdkBlob: "opaque" },
      },
    ],
    usage: {
      ...usage,
      speed: "fast",
      serviceTier: "priority",
      pricingUnknown: true,
      outputReported: true,
      reasoning: 1,
      cost: 0.01,
      webSearchRequests: 1,
      webSearchCost: 0.01,
    },
    stopReason: "toolUse",
  } satisfies AssistantMessage
  const tool = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "blocked" }],
    isError: true,
    rejected: "blocked",
    details: { opaque: [1, "x", false] },
  } satisfies ToolResultMessage
  const requestDto = {
    ...modelParams.request,
    model: {
      ...modelParams.request.model,
      contextWindowSource: "settings",
      compat: { thinkingDisplay: "omitted" },
      fast: { kind: "service-tier", value: "priority", textOnly: true, responseHeader: "x-tier" },
      cost: {
        input: 1,
        output: 2,
        cacheRead: 0.5,
        cacheWrite: 0.5,
        webSearch: 0.01,
        fast: { input: 2, output: 4, maxInputTokens: 100 },
      },
    },
    messages: [user, message, tool],
    maxTokens: 100,
    temperature: 0.5,
    reasoning: { effort: "high" },
    promptCache: true,
    fastMode: true,
    forceStandard: false,
  } satisfies ModelRequest
  const compact = {
    ok: true,
    checkpoint: {
      dialect: "mock",
      value: "checkpoint",
      kind: "checkpoint",
      provider: "mock",
      model: "test",
      host: "mock.invalid",
    },
    summary: "Summary",
    usage,
    usageIncomplete: false,
    method: "native",
    tried: [{ method: "alternate", error: "unsupported", unsupported: true }],
  } satisfies CompactResult
  validateRemoteParams("model.stream", { request: requestDto })
  roundtrip(validateRemoteFrame(request("model.stream", { request: requestDto })))
  roundtrip(validateRemoteFrame(response("model.compact", compact)))
  roundtrip(
    validateRemoteFrame({
      v: 1,
      kind: "model.event",
      callId: "call-1",
      seq: 1,
      event: { type: "done", message },
    }),
  )
  expect(() =>
    validateRemoteParams("model.stream", {
      request: { ...requestDto, model: { ...requestDto.model, apiKey: "must-not-cross" } },
    }),
  ).toThrow()
  expect(() =>
    validateRemoteResult("model.compact", {
      ...compact,
      checkpoint: { ...compact.checkpoint, unexpected: true },
    }),
  ).toThrow()
})

test("revisioned forms expose every field kind without accepting callback or unknown fields", () => {
  const form = {
    kind: "form",
    requestId: "q1",
    title: "All fields",
    layout: "card",
    description: "Fixture",
    sections: [{ title: "Section", collapsed: true, help: "Help", optional: true }],
    summaries: [
      {
        id: "details",
        label: "Details",
        fields: ["text", "select"],
        summaryFields: ["text"],
        when: { field: "check", is: [true] },
      },
    ],
    submitLabel: "Save",
    fields: [
      {
        type: "text",
        id: "text",
        label: "Text",
        default: "name",
        required: true,
        pattern: ".+",
        patternMessage: "Required",
        maxLength: 10,
      },
      { type: "secret", id: "secret", label: "Secret", placeholder: "Secret", required: true },
      { type: "number", id: "number", label: "Number", default: 1, min: 0, max: 10, integer: true },
      {
        type: "select",
        id: "select",
        label: "Select",
        options: [{ value: "a", group: "Group", label: "A", description: "Description", detail: ["Detail"] }],
        default: "a",
      },
      {
        type: "multiselect",
        id: "multi",
        label: "Multi",
        options: [{ value: "a" }],
        default: ["a"],
        required: true,
        allowCustom: true,
      },
      { type: "checkbox", id: "check", label: "Check", default: false },
      { type: "textarea", id: "area", label: "Area", default: "text", rows: 2, maxLength: 100 },
      {
        type: "action",
        id: "load",
        label: "Load",
        placement: "footer",
        buttonLabel: "Load",
        shortcut: "ctrl+t",
        inline: "multi",
        recommended: true,
        auto: { watch: ["text", { field: "select", when: { check: true } }] },
      },
    ],
  } satisfies EventMap["ui.request"]
  validateRemoteDto("uiRequest", form)
  roundtrip(
    validateRemoteFrame({
      v: 1,
      kind: "event",
      daemonEpoch: "epoch-1",
      seq: 1,
      payload: { seq: 1, ts: 1, sessionId: "s1", type: "ui.request", data: form },
    }),
  )
  expect(() =>
    validateRemoteDto("uiRequest", { ...form, fields: [{ ...form.fields[0], unexpected: true }] }),
  ).toThrow()
  for (const action of [
    { ...form.fields[7], shortcut: "ctrl+x" },
    { ...form.fields[7], inline: true },
  ])
    expect(() => validateRemoteDto("uiRequest", { ...form, fields: [action] })).toThrow()
  for (const summary of [
    { label: "Missing id", fields: [], summaryFields: [] },
    { ...form.summaries[0], fields: [true] },
    { ...form.summaries[0], summaryFields: "text" },
    { ...form.summaries[0], when: { field: "check", is: null } },
    { ...form.summaries[0], when: { field: "check", is: true, unexpected: true } },
    { ...form.summaries[0], unexpected: true },
  ])
    expect(() => validateRemoteDto("uiRequest", { ...form, summaries: [summary] })).toThrow()
  for (const is of ["value", 1, true, ["a", "b"], [false, 2, ["a"]]])
    validateRemoteDto("uiRequest", {
      ...form,
      summaries: [{ ...form.summaries[0], when: { field: "check", is } }],
    })
  validateRemoteDto("uiRequest", {
    ...form,
    summaries: [{ id: "always", label: "Always", fields: [], summaryFields: [] }],
  })
  expect(() => validateRemoteDto("uiRequest", { ...form, validate: () => ({}) })).toThrow()
  expect(() =>
    validateRemoteDto("uiRequest", { ...form, fields: [{ type: "execute-code", id: "bad", label: "Bad" }] }),
  ).toThrow()
})

test("snapshot, updates, startup diagnostics and frontend effects have closed DTO schemas", () => {
  const core = { seq: 1, ts: 1, sessionId: "s1", type: "ui.render", data: {} }
  const effect = { kind: "focus", conversationId: "c1", incarnation: "i1" }
  const form = eventFixtures["ui.request"]
  for (const [kind, dto] of [
    ["snapshot", snapshot],
    ["update", { kind: "snapshot", snapshot }],
    ["update", { kind: "error", error: { code: "invalid_snapshot", message: "Unavailable" } }],
    ["effect", effect],
    ["uiRequest", form],
  ] as const) {
    validateRemoteDto(kind, dto)
    expect(() => validateRemoteDto(kind, { ...dto, unexpected: true })).toThrow()
    expect(() => validateRemoteDto(kind, {})).toThrow()
  }
  validateRemoteDto("startup", [core])
  expect(() => validateRemoteDto("startup", [{ ...core, unexpected: true }])).toThrow()
  expect(() =>
    validateRemoteDto("snapshot", { ...snapshot, state: { ...snapshot.state, status: "unknown" } }),
  ).toThrow()
  expect(() =>
    validateRemoteDto("snapshot", {
      ...snapshot,
      transcript: {
        ...snapshot.transcript,
        messages: [{ id: "m1", message: { role: "user", content: [{ type: "image", data: "aA==" }] } }],
      },
    }),
  ).toThrow()
  expect(() => validateRemoteDto("effect", { ...effect, kind: "evaluate-code" })).toThrow()
  const payloads: RemoteJson[] = [
    { kind: "snapshot", snapshot },
    { kind: "effect", effect },
    { kind: "startup", events: [core] },
  ]
  for (const payload of payloads) roundtrip(event(payload))
})
