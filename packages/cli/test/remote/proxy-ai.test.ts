import "../server/offline.ts"
import { expect, test } from "bun:test"
import type { AssistantMessage, StreamEvent } from "@amira/ai"
import { encodeModelEvent } from "../../src/remote/model-codec.ts"
import type { RemoteJson } from "../../src/remote/protocol.ts"
import { collectEvents, deferred, proxyFixture, secret } from "./model-proxy-fixture.ts"

const message: AssistantMessage = {
  role: "assistant",
  model: { provider: "p", model: "m" },
  content: [{ type: "text", text: "finished" }],
  stopReason: "end",
}

test("proxy executes only at the local Ai and preserves remote request restrictions", async () => {
  const fixture = proxyFixture(async function* (request, ctx) {
    expect(ctx.endpoint.apiKey).toBe(secret)
    expect(request.model.caps.webSearch).toBe(false)
    expect(request.model.caps.tools).toBe("none")
    expect(request.model.contextWindow).toBe(12345)
    yield { type: "text.delta", text: "finished" }
    yield { type: "done", message }
  })
  try {
    await fixture.connect()
    const model = fixture.proxy.model("p/m")
    model.caps.tools = "none"
    model.caps.webSearch = false
    model.contextWindow = 12345
    const events = await collectEvents(fixture.proxy.stream({ ...fixture.request, model }))
    expect(events.at(-1)?.type).toBe("done")
    expect(fixture.proxy.model("p/m").contextWindow).not.toBe(12345)
    expect(() => fixture.proxy.providerEndpoint("p")).toThrow("locally")
    expect(fixture.proxy.knownModels()).toEqual(["p/m"])
    for (const frame of fixture.observed) expect(frame).not.toContain(secret)
  } finally {
    fixture.close()
  }
})

test("same accepted stream continues across disconnect without another provider request", async () => {
  const release = deferred()
  const started = deferred()
  let attempts = 0
  const fixture = proxyFixture(async function* () {
    attempts++
    yield { type: "text.delta", text: "prefix ".repeat(20) }
    yield { type: "text.delta", text: "middle ".repeat(20) }
    started.resolve()
    await release.promise
    yield { type: "text.delta", text: "suffix" }
    yield { type: "done", message }
  })
  try {
    const connection = await fixture.connect()
    const iterator = fixture.proxy.stream(fixture.request)[Symbol.asyncIterator]()
    let first: IteratorResult<StreamEvent>
    do {
      first = await iterator.next()
    } while (!first.done && first.value.type !== "text.delta")
    await started.promise
    connection.close()
    await connection.closed
    release.resolve()
    await fixture.connect()
    const rest: StreamEvent[] = []
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      rest.push(next.value)
    }
    expect(rest.at(-1)?.type).toBe("done")
    expect(attempts).toBe(1)
  } finally {
    release.resolve()
    fixture.close()
  }
})

test("local-process loss keeps partial text, drops incomplete tool calls and never reissues", async () => {
  const release = deferred()
  let attempts = 0
  const fixture = proxyFixture(async function* () {
    attempts++
    yield { type: "text.delta", text: "partial answer ".repeat(20) }
    yield { type: "text.delta", text: "continued ".repeat(20) }
    yield { type: "toolCall.delta", id: "unfinished", index: 0, name: "danger", argsDelta: "{" }
    await release.promise
    yield { type: "done", message }
  })
  try {
    const connection = await fixture.connect()
    const iterator = fixture.proxy.stream(fixture.request)[Symbol.asyncIterator]()
    while (true) {
      const next = await iterator.next()
      if (next.done || next.value.type === "text.delta") break
    }
    connection.close()
    await connection.closed
    await fixture.connect(true)
    const rest: StreamEvent[] = []
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      rest.push(next.value)
    }
    const terminal = rest.at(-1)
    expect(terminal?.type).toBe("error")
    if (terminal?.type === "error") {
      expect(terminal.error.code).toBe("proxy_broker_lost")
      expect(terminal.retryable).toBe(false)
      expect(
        terminal.message.content.some((part) => part.type === "text" && part.text.includes("partial")),
      ).toBe(true)
      expect(terminal.message.content.some((part) => part.type === "toolCall")).toBe(false)
    }
    expect(attempts).toBe(1)
  } finally {
    release.resolve()
    fixture.close()
  }
})

test("disconnected admission is cancellable and terminal expiry latches within a turn", async () => {
  let attempts = 0
  const fixture = proxyFixture(async function* () {
    attempts++
    yield { type: "done", message }
  }, 15)
  try {
    const controller = new AbortController()
    const first = await collectEvents(fixture.proxy.stream(fixture.request, controller.signal))
    expect(first.at(-1)).toMatchObject({
      type: "error",
      error: { kind: "network", code: "proxy_reconnect_expired" },
      retryable: false,
    })
    // A newly attached broker cannot restart an expired operation/turn through compaction fallback.
    await fixture.connect()
    const compact = await fixture.proxy.compact(fixture.request, controller.signal)
    expect(compact).toMatchObject({ ok: false, failure: { code: "proxy_reconnect_expired" } })
    expect(attempts).toBe(0)
    const abort = new AbortController()
    fixture.close()
    const waiting = collectEvents(fixture.proxy.stream(fixture.request, abort.signal))
    abort.abort()
    expect((await waiting).at(-1)).toMatchObject({ type: "error", message: { stopReason: "aborted" } })
  } finally {
    fixture.close()
  }
})

test("iterator return cancels accepted local execution, not merely its attachment handler", async () => {
  const aborted = deferred()
  const fixture = proxyFixture(async function* (_request, context) {
    context.signal?.addEventListener("abort", () => aborted.resolve(), { once: true })
    yield { type: "text.delta", text: "working ".repeat(30) }
    yield { type: "text.delta", text: "continued ".repeat(30) }
    await aborted.promise
    yield { type: "done", message }
  })
  try {
    await fixture.connect()
    const iterator = fixture.proxy.stream(fixture.request)[Symbol.asyncIterator]()
    while (true) {
      const next = await iterator.next()
      if (next.done || next.value.type === "text.delta") break
    }
    await iterator.return?.()
    await aborted.promise
  } finally {
    fixture.close()
  }
})

test("credential echoes split across streaming frames never reach the remote observer", async () => {
  const fixture = proxyFixture(async function* () {
    yield { type: "text.delta", text: secret.slice(0, 10) }
    yield { type: "text.delta", text: secret.slice(10) }
    yield {
      type: "error",
      error: { message: secret, host: secret, code: secret, kind: "auth" },
      retryable: false,
      message: { ...message, content: [{ type: "text", text: secret }], stopReason: "error" },
    }
  })
  try {
    await fixture.connect()
    const events = await collectEvents(fixture.proxy.stream(fixture.request))
    expect(events.at(-1)?.type).toBe("error")
    const allRemoteBytes = fixture.observed.join("")
    expect(allRemoteBytes).not.toContain(secret)
    expect(JSON.stringify(events)).not.toContain(secret)
    for (const frame of fixture.observed) {
      expect(frame).not.toContain(secret)
      expect(frame).not.toContain("https://provider.invalid/v1")
    }
  } finally {
    fixture.close()
  }
})

test("model-frame authority fields are mandatory and stale controller answers are rejected", async () => {
  const release = deferred()
  const started = deferred()
  const fixture = proxyFixture(async function* () {
    started.resolve()
    await release.promise
    yield { type: "done", message }
  })
  try {
    const connection = await fixture.connect()
    const work = collectEvents(fixture.proxy.stream(fixture.request))
    await started.promise
    const open = fixture.sent
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((frame) => frame.kind === "request")
    expect(open).toBeDefined()
    const callId = open.params.callId
    expect(() =>
      fixture.proxy.receive(connection, {
        v: 1,
        kind: "model.frame",
        daemonEpoch: "epoch-1",
        controllerGeneration: 0,
        sessionGeneration: 1,
        callId,
        seq: 1,
        payload: { kind: "stream", data: encodeModelEvent({ type: "start" }) as unknown as RemoteJson },
      }),
    ).toThrow("authority")
    release.resolve()
    await work
  } finally {
    release.resolve()
    fixture.close()
  }
})
