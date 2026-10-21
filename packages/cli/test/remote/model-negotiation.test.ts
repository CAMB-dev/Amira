import "../server/offline.ts"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { createRemoteAgentPort } from "../../src/remote/agent-port.ts"
import { localModelBindings } from "../../src/remote/local-models.ts"
import { ModelBrokerPeer } from "../../src/remote/model-peer.ts"
import type { RemoteHello } from "../../src/remote/protocol.ts"
import { ProxyAi } from "../../src/remote/proxy-ai.ts"
import { workspaceAttachments } from "../../src/server/attachments.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { until } from "./agent-port-fixture.ts"
import { hello, loopback } from "./loopback.ts"
import { deferred } from "./model-proxy-fixture.ts"

for (const releaseBeforeWelcome of [false, true])
  test(`fresh local broker negotiates before the next model call after a tool (${releaseBeforeWelcome ? "waiting before" : "waiting after"} welcome)`, async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-model-negotiation-"))
    const toolStarted = deferred()
    const toolRelease = deferred()
    const mock = createMockDialect([
      { toolCalls: [{ name: "held", args: {} }] },
      { text: "fresh local broker answer" },
    ])
    let providerCalls = 0
    const ai = createAi({
      providers: [{ id: "p", dialect: "mock", baseUrl: "https://mock.invalid/v1", apiKey: "LOCAL_ONLY" }],
      dialects: [
        {
          ...mock,
          stream(request, context) {
            providerCalls++
            return mock.stream(request, context)
          },
        },
      ],
      env: {},
    })
    const model = ai.model("p/m")
    const proxy = new ProxyAi(
      [{ model, revision: "unbound", available: false, replay: ai.replayTarget(model) }],
      { reconnectTimeoutMs: 5000 },
    )
    let modelCalls = 0
    const stream = proxy.stream
    proxy.stream = (request, signal) => {
      modelCalls++
      return stream(request, signal)
    }
    const runtime = await createWorkspaceRuntime({
      cwd,
      ai: proxy,
      modelProxy: proxy,
      model: "p/m",
      autoTitle: false,
      builtins: async () => [
        {
          source: "fixture",
          extension(api) {
            api.registerTool({
              name: "held",
              description: "Wait at the remote tool boundary",
              parameters: { type: "object", properties: {}, additionalProperties: false },
              traits: { readOnly: true },
              async execute() {
                toolStarted.resolve()
                await toolRelease.promise
                return { content: [{ type: "text", text: "remote tool completed" }] }
              },
            })
          },
        },
      ],
    })
    const authority = workspaceAttachments(runtime, { heartbeatMs: 0 })
    const sessions: {
      server: ReturnType<typeof authority.connect>
      peer: ModelBrokerPeer
      port: Awaited<ReturnType<typeof createRemoteAgentPort>>
    }[] = []
    const sent: string[] = []
    const opens = () =>
      sent
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((frame) => frame.kind === "request" && frame.op === "model.open")
    async function connect(approve: () => Promise<boolean>, resume?: RemoteHello["resume"]) {
      // A new approval registry AND retention peer model a genuinely fresh local process.
      const local = localModelBindings(ai, approve)
      const peer = new ModelBrokerPeer(local.broker)
      const io = loopback(37)
      const server = authority.connect(
        {
          ...io.server,
          async write(bytes) {
            sent.push(Buffer.from(bytes).toString())
            await io.server.write(bytes)
          },
        },
        { release: hello.release, workspace: cwd },
      )
      const port = await createRemoteAgentPort({
        hello: { ...hello, workspace: cwd, ...(resume ? { resume } : {}) },
        brokerPeer: peer,
        async connect() {
          return io.client
        },
      })
      const session = { local, peer, server, port }
      sessions.push(session)
      return session
    }
    try {
      const first = await connect(async () => true)
      await first.local.negotiate(first.port)
      const oldRevision = first.local.broker.metadata([model])[0]!.revision
      await first.port.execute("turn.prompt", { message: "wait at a tool and recover locally" })
      await toolStarted.promise
      first.server.close()
      await until(() => first.port.status === "disconnected")
      first.peer.close()
      if (releaseBeforeWelcome) {
        toolRelease.resolve()
        await until(() => modelCalls === 2)
      }
      const approval = deferred<boolean>()
      const fresh = await connect(() => approval.promise, {
        ...first.port.cursor!,
        controllerToken: first.port.authority!.controllerToken!,
      })
      const negotiating = fresh.local.negotiate(fresh.port)
      void negotiating.catch(() => {})
      if (!releaseBeforeWelcome) {
        toolRelease.resolve()
        await until(() => modelCalls === 2)
      }
      await fresh.port.request("proxy.describe", {})
      expect(opens()).toHaveLength(1)
      expect(providerCalls).toBe(1)
      approval.resolve(true)
      await negotiating
      await until(() => JSON.stringify(fresh.port.snapshot.transcript).includes("fresh local broker answer"))
      const calls = opens()
      expect(calls).toHaveLength(2)
      expect(calls[1].params).toMatchObject({ resume: false, after: 0 })
      expect(calls[1].params.callId).not.toBe(calls[0].params.callId)
      expect(calls[1].params.revision).not.toBe(oldRevision)
      expect(calls[1].params.revision).toBe(fresh.local.broker.metadata([model])[0]!.revision)
      expect(providerCalls).toBe(2)
      expect(JSON.stringify(fresh.port.snapshot.transcript)).toContain("remote tool completed")
      expect(sent.join("")).not.toContain("LOCAL_ONLY")
    } finally {
      toolRelease.resolve()
      for (const { server, peer } of sessions) {
        server.close()
        peer.close()
      }
      await runtime.stop()
      for (const { port } of sessions) await port.detach()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }, 30_000)
