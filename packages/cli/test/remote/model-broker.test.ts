import "../server/offline.ts"
import { expect, test } from "bun:test"
import { createAi, type DialectContext, type ModelRequest } from "@amira/ai"
import { createModelBroker } from "../../src/remote/model-broker.ts"
import { ModelBindingError, ProviderBindings } from "../../src/remote/provider-bindings.ts"
import { BASE_URL, done, drain, HEADER, KEY, provider, setup, URL_SECRET } from "./model-fixtures.ts"

test("ordinary local Ai executes a pinned provider with remote model overrides and restrictions intact", async () => {
  let received: ModelRequest | undefined, context: DialectContext | undefined
  const { broker, call, metadata } = setup({
    id: "fake",
    async *stream(req, ctx) {
      received = req
      context = ctx
      yield done(req)
    },
  })
  call.request.messages.push({
    role: "assistant",
    model: { provider: "remote", model: "old" },
    content: [
      {
        type: "toolCall",
        id: "historical",
        name: "test",
        args: { provider: "remote", nested: { role: "assistant", model: { provider: "remote" } } },
      },
    ],
  })
  const events = await drain(broker.stream(call))
  expect(received?.model).toEqual({ ...call.request.model, provider: "local" })
  expect(received?.messages[1]).toMatchObject({
    model: { provider: "local" },
    content: [{ args: { provider: "remote", nested: { model: { provider: "remote" } } } }],
  })
  expect(context?.endpoint.apiKey).toBe(KEY)
  expect(context?.endpoint.headers?.["X-Private"]).toBe(HEADER)
  expect(events.at(-1)).toMatchObject({
    type: "done",
    message: { model: { provider: "remote", model: call.request.model.id } },
  })
  expect(metadata).toMatchObject({
    available: true,
    model: { contextWindow: 12345, maxOutput: 222, caps: { tools: "none", webSearch: false } },
    replay: { provider: "remote", host: "approved.invalid", webSearch: false },
  })
  const serialized = JSON.stringify([metadata, events])
  for (const secret of [KEY, HEADER, BASE_URL, URL_SECRET, "url-user", "url-pass"])
    expect(serialized).not.toContain(secret)
})

test("unapproved origins/dialects, stale revisions, endpoint changes and revocation never invoke the model", async () => {
  let executions = 0
  const { ai, bindings, broker, call } = setup({
    id: "fake",
    async *stream(req) {
      executions++
      yield done(req)
    },
  })
  expect(
    () =>
      new ProviderBindings(ai, [
        { provider: "r", dialect: "fake", localProvider: "local", endpointOrigin: "https://evil.invalid" },
      ]),
  ).toThrow(ModelBindingError)
  expect(
    () =>
      new ProviderBindings(ai, [
        {
          provider: "r",
          dialect: "other",
          localProvider: "local",
          endpointOrigin: "https://approved.invalid",
        },
      ]),
  ).toThrow(ModelBindingError)
  await expect(drain(broker.stream({ ...call, bindingRevision: "stale" }))).rejects.toThrow(ModelBindingError)
  await expect(
    drain(
      broker.stream({
        ...call,
        request: { ...call.request, model: { ...call.request.model, dialect: "other" } },
      }),
    ),
  ).rejects.toThrow(ModelBindingError)
  ai.registerProvider({ ...provider, headers: { "X-Private": "changed" } })
  await expect(drain(broker.stream(call))).rejects.toThrow(ModelBindingError)
  ai.registerProvider(provider)
  bindings.revoke("remote")
  await expect(drain(broker.stream(call))).rejects.toThrow(ModelBindingError)
  expect(executions).toBe(0)
})

test("literal credentials, resolved headers, URL credentials and arbitrary object-key echoes are redacted", async () => {
  const { broker, call } = setup({
    id: "fake",
    async *stream(req) {
      yield { type: "text.delta", text: `before ${KEY} ${HEADER} ${BASE_URL} ${URL_SECRET} url-pass after` }
      yield { type: "thinking.delta", text: encodeURIComponent(KEY) }
      yield {
        type: "serverTool",
        block: {
          type: "serverTool",
          id: "hosted",
          name: "search",
          input: { [HEADER]: KEY, url: BASE_URL },
          status: "done",
        },
      }
      yield done(req, `${KEY} ${HEADER} ${BASE_URL}`)
    },
  })
  const serialized = JSON.stringify(await drain(broker.stream(call)))
  expect(serialized).toContain("[redacted]")
  for (const secret of [KEY, HEADER, BASE_URL, URL_SECRET, "url-pass", encodeURIComponent(KEY)])
    expect(serialized).not.toContain(secret)
})

test("one-character deltas with interleaved thinking cannot leak split credentials", async () => {
  const { broker, call } = setup({
    id: "fake",
    async *stream(req) {
      for (const text of `safe:${KEY}:end ${"padding ".repeat(40)}`) {
        yield { type: "text.delta", text }
        yield { type: "thinking.delta", text: "." }
      }
      yield done(req)
    },
  })
  const events = await drain(broker.stream(call))
  const text = events.flatMap((event) => (event.type === "text.delta" ? [event.text] : [])).join("")
  expect(text).toContain("safe:[redacted]:end")
  expect(text).not.toContain(KEY)
  expect(text).not.toContain(KEY.slice(5))
})

test("errors expose structured facts, never provider messages/codes/hosts/stacks", async () => {
  const { broker, call } = setup({
    id: "fake",
    async *stream(req) {
      yield {
        type: "retry",
        attempt: 1,
        maxRetries: 1,
        delayMs: 0,
        error: { message: KEY, code: HEADER, host: BASE_URL, status: 429, kind: "rate" },
      }
      yield {
        type: "error",
        error: { message: `${KEY} ${HEADER}`, code: URL_SECRET, status: 400, kind: "other" },
        retryable: false,
        message: {
          role: "assistant",
          content: [{ type: "text", text: KEY }],
          model: { provider: req.model.provider, model: req.model.id },
          stopReason: "error",
        },
      }
    },
  })
  const events = await drain(broker.stream(call))
  expect(events.find((event) => event.type === "retry")).toMatchObject({
    error: { status: 429, kind: "rate", code: "local_model_failure" },
  })
  const serialized = JSON.stringify(events)
  for (const secret of [KEY, HEADER, BASE_URL, URL_SECRET]) expect(serialized).not.toContain(secret)
})

test("resolved environment headers and stored keys never cross the model boundary", async () => {
  const env = { KEY: "environment-private-value", HEADER: "interpolated-private-value" }
  const stored = "stored-private-value"
  const ai = createAi({
    providers: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: exercise literal local header interpolation.
      { ...provider, apiKey: undefined, apiKeyEnv: "KEY", headers: { "X-Private": "prefix-${HEADER}" } },
    ],
    apiKeys: { local: stored },
    env,
    dialects: [
      {
        id: "fake",
        async *stream(req, ctx) {
          yield done(req, `${ctx.endpoint.apiKey} ${ctx.endpoint.headers?.["X-Private"]}`)
        },
      },
    ],
  })
  const bindings = new ProviderBindings(ai, [
    {
      provider: "remote",
      dialect: "fake",
      localProvider: "local",
      endpointOrigin: "https://approved.invalid",
    },
  ])
  const broker = createModelBroker({ ai, bindings })
  const model = { ...ai.model("local/m"), provider: "remote" }
  const request = { model, systemPrompt: "", messages: [], tools: [] }
  let metadata = broker.metadata([model])[0]!
  const first = JSON.stringify(await drain(broker.stream({ bindingRevision: metadata.revision, request })))
  expect(first).not.toContain(env.KEY)
  expect(first).not.toContain(env.HEADER)
  env.KEY = ""
  await expect(drain(broker.stream({ bindingRevision: metadata.revision, request }))).rejects.toThrow(
    ModelBindingError,
  )
  bindings.approve({
    provider: "remote",
    dialect: "fake",
    localProvider: "local",
    endpointOrigin: "https://approved.invalid",
  })
  metadata = broker.metadata([model])[0]!
  const second = JSON.stringify(await drain(broker.stream({ bindingRevision: metadata.revision, request })))
  expect(second).not.toContain(stored)
  expect(second).not.toContain(env.HEADER)
})

test("a thrown provider error retains only sanitized partial text and no incomplete tool calls", async () => {
  const { ai, bindings, call } = setup()
  const broker = createModelBroker({
    bindings,
    ai: {
      ...ai,
      async *stream() {
        yield { type: "text.delta" as const, text: `partial ${KEY}` }
        yield { type: "toolCall.delta" as const, id: "incomplete", name: "must-not-execute", argsDelta: "{" }
        throw new Error(`${HEADER} ${BASE_URL}`)
      },
    },
  })
  const events = await drain(broker.stream(call))
  const terminal = events.at(-1)!
  expect(terminal).toMatchObject({
    type: "error",
    retryable: false,
    message: { content: [{ type: "text", text: "partial [redacted]" }], stopReason: "error" },
  })
  expect(JSON.stringify(events)).not.toContain(KEY)
  expect(JSON.stringify(events)).not.toContain(HEADER)
})

test("missing or revoked local approvals leave remote model metadata explicitly unavailable", () => {
  const { broker, bindings, req } = setup()
  bindings.revoke("remote")
  expect(broker.metadata([req.model])).toMatchObject([
    { revision: "unbound", available: false, model: { provider: "remote" }, replay: { host: "" } },
  ])
})

test("iterator return aborts the ordinary local Ai signal", async () => {
  let signal: AbortSignal | undefined
  const { broker, call } = setup({
    id: "fake",
    async *stream(req, ctx) {
      signal = ctx.signal
      yield { type: "start" }
      yield done(req)
    },
  })
  const iterator = broker.stream(call)[Symbol.asyncIterator]()
  while (!signal) await iterator.next()
  await iterator.return?.()
  expect(signal?.aborted).toBe(true)
})
