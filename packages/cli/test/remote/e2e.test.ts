import "../server/offline.ts"
import { expect, test } from "bun:test"
import { type AssistantMessage, emptyUsage } from "@amira/ai"
import { type AnyEvent, type ExtensionAPI, textResult } from "@amira/api"
import { e2eFixture, eventually } from "./e2e-fixture.ts"
import { deferred, proxyFixture } from "./model-proxy-fixture.ts"

// Offline acceptance over actual codecs + WorkspaceRuntime + RemoteAgentPort +
// local ModelBroker/ProxyAi. Launch via e2e-offline.ts BEFORE test preloads import
// the application. No SSH, Linux daemon, GUI, filesystem-tool or live-provider claim.
const answer = (text: string): AssistantMessage => ({
  role: "assistant",
  model: { provider: "p", model: "m" },
  content: [{ type: "text", text }],
  usage: { ...emptyUsage(), input: 11, output: 7 },
  stopReason: "end",
})

for (const recovery of ["replay", "snapshot"] as const) {
  test(`B15 ${recovery}: lost prompt/approval replies, retained tool and model admission converge exactly once`, async () => {
    const progress = deferred()
    const finish = deferred()
    let streams = 0
    let tools = 0
    let finished = false
    let toolAborted = false
    const model = proxyFixture(async function* () {
      streams++
      yield {
        type: "done",
        message:
          streams === 1
            ? {
                ...answer(""),
                content: [{ type: "toolCall", id: "retained-tool", name: "retained", args: {} }],
                stopReason: "toolUse",
              }
            : answer("Completed once — 世界"),
      }
    }, 30_000)
    const f = await e2eFixture(model, {
      builtins: async () => [
        {
          source: "b15-fixture",
          extension(api) {
            api.intercept("tool.call.before", () => ({ action: "ask", reason: "B15 explicit approval" }))
            api.registerTool({
              name: "retained",
              description: "A gated in-memory tool; no shell or filesystem effects",
              parameters: { type: "object", properties: {}, additionalProperties: false },
              traits: { readOnly: true },
              async execute(_args, ctx) {
                tools++
                await progress.promise
                ctx.update(textResult("Progress one — 世界"))
                ctx.update(textResult("Progress two — 世界"))
                await finish.promise
                toolAborted = ctx.signal.aborted
                finished = true
                return textResult("One retained tool result — 世界")
              },
            })
          },
        },
      ],
    })
    const events: { event: AnyEvent; replay: boolean; seq: number }[] = []
    const resets: string[] = []
    f.port.subscribeEvents((event, context) => events.push({ event, ...context }))
    f.port.subscribeReset((_snapshot, reason) => resets.push(reason))
    try {
      await f.negotiate()
      const originalAuthority = f.port.authority!
      f.faults.dropResponseId = "b15-prompt"
      const prompt = f.port
        .execute("turn.prompt", { message: "Approve and retain — 世界" }, { operationId: "b15-prompt" })
        .catch((error: unknown) => error)
      await eventually(
        "pending real approval and lost prompt acceptance",
        () => f.port.pendingRequests.length === 1 && f.faults.droppedResponses.includes("b15-prompt"),
      )
      const approval = f.port.pendingRequests[0]!
      expect(approval).toMatchObject({ source: "approval", kind: "confirm" })
      expect(tools).toBe(0)
      const busy = () =>
        f.port.execute("turn.prompt", { message: "Already busy" }, { operationId: "b15-known-rejection" })
      await expect(busy()).rejects.toMatchObject({ code: "agent_busy" })
      await f.disconnect()
      expect(await prompt).toMatchObject({ code: "disconnected" })
      expect(f.runtime.signal.aborted).toBe(false)
      expect(f.runtime.quiescent()).toBe(false)
      await f.port.reconnect()
      await f.negotiate()
      await eventually(
        "approval restored with original identity",
        () => f.port.pendingRequests[0]?.requestId === approval.requestId,
      )
      expect(
        await f.port.execute(
          "turn.prompt",
          { message: "Approve and retain — 世界" },
          { operationId: "b15-prompt" },
        ),
      ).toMatchObject({ sessionGeneration: 1 })
      expect(streams).toBe(1)
      // A genuine host rejection stays terminal even after that connection later fails.
      await expect(busy()).rejects.toMatchObject({ code: "agent_busy" })
      expect(
        f.wire.filter(({ frame }) => frame.kind === "request" && frame.id === "b15-known-rejection"),
      ).toHaveLength(1)
      f.faults.dropResponseId = "b15-approval"
      const response = f.port
        .request(
          "ui.respond",
          { requestId: approval.requestId, value: true },
          { operationId: "b15-approval" },
        )
        .catch((error: unknown) => error)
      await eventually(
        "one approved tool and lost approval result",
        () => tools === 1 && f.faults.droppedResponses.includes("b15-approval"),
      )
      if (recovery === "snapshot") {
        // Lose the approval reply AND a runtime event before exposing the gap.
        // Snapshot recovery must retain the uncertain mutation's original identity.
        f.faults.dropNextEvent = true
        progress.resolve()
        await eventually("gap disconnect", () => f.port.status === "disconnected")
      } else {
        await f.disconnect()
        progress.resolve()
      }
      expect(await response).toMatchObject({ code: recovery === "snapshot" ? "replay_gap" : "disconnected" })
      finish.resolve()
      await eventually("tool finishes without any frontend", () => finished)
      expect(toolAborted).toBe(false)
      expect(streams).toBe(1)
      expect(f.runtime.signal.aborted).toBe(false)
      expect(f.runtime.quiescent()).toBe(false)
      await f.port.reconnect()
      // Welcome/replay alone cannot start the next local provider call.
      expect(streams).toBe(1)
      await f.negotiate()
      expect(
        await f.port.request(
          "ui.respond",
          { requestId: approval.requestId, value: true },
          { operationId: "b15-approval" },
        ),
      ).toEqual({ status: "accepted" })
      await eventually(
        "authoritative completed transcript",
        () =>
          f.port.snapshot.state.status === "idle" &&
          JSON.stringify(f.port.snapshot.transcript).includes("Completed once"),
      )
      expect(tools).toBe(1)
      expect(streams).toBe(2)
      expect(f.port.pendingRequests).toHaveLength(0)
      expect(f.port.authority!.controllerToken).toBe(originalAuthority.controllerToken)
      expect(f.port.authority!.controllerGeneration).toBeGreaterThan(originalAuthority.controllerGeneration)
      const entries = f.port.snapshot.transcript.messages
      expect(entries.map((entry) => entry.message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "assistant",
      ])
      const ids = entries.map((entry) => entry.id)
      expect(new Set(ids).size).toBe(4)
      expect(events.filter(({ event }) => event.type === "turn.end")).toHaveLength(1)
      expect(events.filter(({ event }) => event.type === "ui.request")).toHaveLength(1)
      expect(new Set(events.map(({ seq }) => seq)).size).toBe(events.length)
      if (recovery === "replay") {
        expect(resets).toEqual([])
        expect(
          events.filter(({ event, replay }) => event.type === "tool.execute.end" && replay),
        ).toHaveLength(1)
      } else {
        expect(f.faults.droppedEvents).toHaveLength(1)
        expect(resets).toEqual(["fresh"])
        expect(f.wire.filter(({ frame }) => frame.kind === "hello").at(-1)?.frame).toMatchObject({
          snapshot: true,
        })
      }
      const eventCount = events.length
      await f.disconnect()
      await f.port.reconnect()
      await f.negotiate()
      // A roundtrip read acts as a delivery barrier, without seeding runtime work directly.
      await f.port.request("status.read", {})
      expect(f.port.snapshot.transcript.messages.map((entry) => entry.id)).toEqual(ids)
      expect(events).toHaveLength(eventCount)
      expect(f.faults.droppedAcks).toBeGreaterThan(0)
      await expect(
        f.port.execute("turn.prompt", { message: "Changed mutation" }, { operationId: "b15-prompt" }),
      ).rejects.toMatchObject({ code: "operation_conflict" })
      expect(tools).toBe(1)
      expect(streams).toBe(2)
      await f.port.detach()
      expect(f.runtime.signal.aborted).toBe(false)
    } finally {
      progress.resolve()
      finish.resolve()
      await f.close()
    }
  }, 120_000)
}

test("B15 controller takeover fences stale approval authority without settling the retained dialog", async () => {
  let api!: ExtensionAPI
  let commands = 0
  const model = proxyFixture(async function* () {
    yield { type: "done", message: answer("unused") }
  }, 30_000)
  const f = await e2eFixture(model, {
    builtins: async () => [
      {
        source: "b15-controller",
        extension(value) {
          api = value
          api.registerCommand({
            name: "approval",
            description: "Retained controller dialog",
            async run() {
              commands++
              await api.ui.confirm("Controller-owned approval")
            },
          })
        },
      },
    ],
  })
  try {
    const pending = f.port
      .execute("command.run", { line: "/approval" }, { operationId: "controller-command" })
      .catch((error: unknown) => error)
    await eventually("controller dialog", () => f.port.pendingRequests.length === 1)
    const requestId = f.port.pendingRequests[0]!.requestId
    const old = f.port.authority!
    const contender = f.rawClient({ clientId: "unrelated-client" })
    await expect(contender.ready).rejects.toMatchObject({ code: "controller_busy" })
    expect(f.port.status).toBe("connected")
    const replacement = f.rawClient({
      resume: {
        daemonEpoch: old.daemonEpoch,
        after: f.port.cursor!.after,
        controllerToken: old.controllerToken!,
      },
    })
    const current = await replacement.ready
    await eventually("old frontend fenced", () => f.port.status === "disconnected")
    expect(await pending).toMatchObject({ code: "disconnected" })
    expect(current.controllerGeneration).toBeGreaterThan(old.controllerGeneration)
    await expect(
      replacement.request(
        "ui.respond",
        { requestId, value: true },
        {
          controllerGeneration: old.controllerGeneration,
        },
      ),
    ).rejects.toMatchObject({ code: "stale_controller" })
    // A fresh codec peer bypasses the port's local identity cache: this conflict
    // must be rejected by the runtime's retained mutation ledger itself.
    await expect(
      replacement.request("command.run", { line: "/changed" }, { operationId: "controller-command" }),
    ).rejects.toMatchObject({ code: "operation_conflict" })
    expect(commands).toBe(1)
    await f.port.reconnect()
    await replacement.closed
    await eventually("unsettled approval recovered", () => f.port.pendingRequests[0]?.requestId === requestId)
    expect(await f.port.request("ui.respond", { requestId, value: true })).toEqual({ status: "accepted" })
    expect(
      await f.port.execute("command.run", { line: "/approval" }, { operationId: "controller-command" }),
    ).toMatchObject({ ok: true })
    expect(commands).toBe(1)
    await eventually("settled dialog disappears", () => f.port.pendingRequests.length === 0)
  } finally {
    await f.close()
  }
}, 120_000)

for (const source of ["literal", "environment", "stored"] as const) {
  test(`B15 ${source}: sentinel provider output/errors stay absent from reconnect wire and runtime snapshots`, async () => {
    const key = `SENTINEL_B15_${source}@KEY`
    const header = `SENTINEL_B15_${source}@HEADER`
    const password = `SENTINEL_B15_${source}@PASSWORD`
    const query = `SENTINEL_B15_${source}@QUERY`
    const baseUrl = `https://user:${encodeURIComponent(password)}@provider.invalid/v1?token=${encodeURIComponent(query)}`
    const secrets = [key, header, password, query, baseUrl]
    const variants = secrets.flatMap((value) => [
      value,
      encodeURIComponent(value),
      Buffer.from(value).toString("base64"),
    ])
    const release = deferred()
    let streams = 0
    let api!: ExtensionAPI
    const model = proxyFixture(
      async function* (_request, context) {
        streams++
        expect(context.endpoint.apiKey).toBe(key)
        expect(context.endpoint.headers?.["X-Private"]).toBe(`Bearer ${header}`)
        if (streams === 1) {
          yield { type: "text.delta", text: `Safe prefix 世界 ${key.slice(0, 15)}` }
          await release.promise
          yield { type: "text.delta", text: key.slice(15) }
          yield {
            type: "done",
            message: {
              ...answer(`Safe completion 世界 ${variants.join(" ")}`),
              content: [
                {
                  type: "text",
                  text: `Safe completion 世界 ${variants.join(" ")}`,
                  citations: [{ url: baseUrl }],
                },
              ],
            },
          }
        } else {
          yield {
            type: "error",
            retryable: false,
            error: {
              kind: "auth",
              status: 401,
              code: header,
              host: baseUrl,
              message: variants.join(" "),
            },
            message: { ...answer(variants.join(" ")), stopReason: "error" },
          }
        }
      },
      30_000,
      undefined,
      30_000,
      {
        providers: [
          {
            id: "p",
            dialect: "fixture",
            baseUrl,
            ...(source === "literal" ? { apiKey: key } : { apiKeyEnv: "B15_MODEL_KEY" }),
            // biome-ignore lint/suspicious/noTemplateCurlyInString: deliberate local provider interpolation
            headers: { "X-Private": "Bearer ${B15_PRIVATE_HEADER}" },
          },
        ],
        env: { B15_PRIVATE_HEADER: header, ...(source === "environment" ? { B15_MODEL_KEY: key } : {}) },
        apiKeys: source === "stored" ? { p: key } : {},
      },
    )
    const f = await e2eFixture(model, {
      builtins: async () => [
        {
          source: "b15-security",
          extension(value) {
            api = value
          },
        },
      ],
    })
    const observed: string[] = []
    const events: AnyEvent[] = []
    f.port.subscribe((update) => observed.push(JSON.stringify(update)))
    f.port.subscribeEvents((event) => {
      events.push(event)
      observed.push(JSON.stringify(event))
    })
    f.port.subscribeReset((snapshot) => observed.push(JSON.stringify(snapshot)))
    try {
      await f.negotiate()
      await f.port.execute("turn.prompt", { message: "Exercise local provider redaction" })
      await eventually("local provider begins once", () => streams === 1)
      await f.disconnect()
      release.resolve()
      await f.port.reconnect()
      await f.negotiate()
      await eventually(
        "retained model stream completes",
        () =>
          f.port.snapshot.state.status === "idle" &&
          JSON.stringify(f.port.snapshot).includes("Safe completion"),
      )
      expect(streams).toBe(1)
      const opens = f.wire.flatMap(({ frame }) =>
        frame.kind === "request" && frame.op === "model.open" ? [frame] : [],
      )
      expect(opens).toHaveLength(2)
      expect(opens.map((frame) => frame.params.resume)).toEqual([false, true])
      expect(opens[1]!.params.callId).toBe(opens[0]!.params.callId)
      await f.port.execute("turn.prompt", { message: "Exercise provider failure redaction" })
      await eventually(
        "provider error reaches completed turn",
        () => streams === 2 && events.filter((event) => event.type === "turn.end").length === 2,
      )
      // Demand a genuine new snapshot through gap recovery after both normal and error output.
      f.faults.dropNextEvent = true
      api.notify("Security snapshot gap one")
      api.notify("Security snapshot gap two")
      await eventually("security gap disconnect", () => f.port.status === "disconnected")
      await f.port.reconnect()
      await f.negotiate()
      await f.port.request("status.read", {})
      expect(f.wire.filter(({ frame }) => frame.kind === "reset").length).toBeGreaterThanOrEqual(2)
      expect(
        events.filter((event) => event.type === "turn.end" && event.data.reason === "error"),
      ).toMatchObject([{ data: { error: "Local model provider request failed", failure: { kind: "auth" } } }])
      observed.push(JSON.stringify(f.port.workspaceSnapshot), JSON.stringify(f.runtime.workspaceSnapshot()))
      const history = await f.port.execute("transcript.read", {})
      const models = await f.port.request("models.list", {})
      observed.push(JSON.stringify({ history, models }))
      for (const surface of [
        ...f.wire.map(({ text }) => text),
        f.wire.map(({ text }) => text).join(""),
        ...observed,
        JSON.stringify(model.proxy.describeBindings()),
      ]) {
        for (const sentinel of variants) expect(surface).not.toContain(sentinel)
        expect(surface).not.toContain("SENTINEL_B15_")
      }
      expect(streams).toBe(2)
      expect(
        f.port.snapshot.transcript.messages.filter((entry) => entry.message.role === "user"),
      ).toHaveLength(2)
    } finally {
      release.resolve()
      await f.close()
    }
  }, 120_000)
}
