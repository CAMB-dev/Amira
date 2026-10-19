import "./offline.ts"
import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { OwnedConversation } from "@amira/api"
import { SessionBackgroundJobHost } from "@amira/core"
import { frontendJson } from "../../../core/src/frontend/json.ts"
import { agentSessionOwner } from "../../../core/src/session-routing.ts"
import { RemoteConnection } from "../../src/remote/connection.ts"
import { type RemoteUploadClient, sendRemoteImages } from "../../src/remote/image-upload.ts"
import { workspaceAttachments } from "../../src/server/attachments.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { hello, loopback, welcome } from "../remote/loopback.ts"

async function waitFor(check: () => boolean) {
  const end = Date.now() + 3000
  while (!check() && Date.now() < end) await Bun.sleep(5)
  expect(check()).toBe(true)
}

test("B10 bytes, image steering, native focus and live capture survive a real-codec detach", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "amira-b10-wire-"))
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  writeFileSync(path.join(cwd, "画.png"), png)
  let owned!: OwnedConversation
  const runtime = await createWorkspaceRuntime({
    cwd,
    autoTitle: false,
    model: "mock/test",
    ai: createAi({
      dialects: [
        createMockDialect([
          { text: "first", delayMs: 30 },
          { text: "steered" },
          { text: "native", delayMs: 30 },
        ]),
      ],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    builtins: async () => [
      {
        source: "test:native",
        extension: async (api) => {
          owned = await api.conversations!.openOrCreate(
            { key: path.basename(cwd), name: "Native", cwd, systemPrompt: "", callableTools: [] },
            { askUser: async () => undefined },
          )
          api.registerCommand({
            name: "native",
            description: "test",
            run: (_args, ctx) => {
              ctx.focusConversation?.(owned)
            },
          })
        },
      },
    ],
  })
  const authority = workspaceAttachments(runtime, { heartbeatMs: 0 })
  const peers: RemoteConnection[] = []
  const nativeEvents: unknown[] = []
  const connect = async (resume?: { daemonEpoch: string; after: number; controllerToken: string }) => {
    const io = loopback(79)
    const server = authority.connect(io.server, { release: welcome.release, workspace: cwd })
    const client = new RemoteConnection(io.client, {
      handshake: { role: "client", hello: { ...hello, workspace: cwd, ...(resume ? { resume } : {}) } },
      onMessage: (message) => {
        if (
          message.kind === "event" &&
          message.payload &&
          typeof message.payload === "object" &&
          !Array.isArray(message.payload) &&
          message.payload.sessionId === owned.id
        )
          nativeEvents.push(message.payload)
      },
    })
    peers.push(server, client)
    return { client, server, welcome: await client.ready }
  }
  try {
    let peer = await connect()
    expect(await peer.client.request("images.read", { path: "画.png" })).toMatchObject({
      name: "画.png",
      data: png.toString("base64"),
    })
    const files = await peer.client.request("files.list", {})
    expect(files).toMatchObject({ partial: false, entries: ["画.png"] })
    // Pagination/read traffic must not occupy the bounded mutation ledger.
    for (let page = 0; page < 140; page++) await peer.client.request("files.list", { limit: 1 })
    await peer.client.request("turn.prompt", { message: "first" })
    const client: RemoteUploadClient = {
      sessionGeneration: 1,
      async request(operation, params, options) {
        return peer.client.request(operation, frontendJson(params) as never, options) as never
      },
    }
    await sendRemoteImages(
      client,
      {
        operation: "turn.steer",
        message: {
          role: "user",
          content: [
            { type: "text", text: "before" },
            { type: "image", name: "画.png", mimeType: "image/png", data: png.toString("base64") },
            { type: "text", text: "after" },
          ],
        },
      },
      { operationId: "image-steer" },
    )
    await waitFor(() => JSON.stringify(runtime.workspaceSnapshot()).includes("steered"))
    const command = await peer.client.request("command.run", { line: "/native" })
    expect(command).toMatchObject({ ok: true })
    const listed = (await peer.client.request("conversations.list", {})) as {
      conversations: { id: string; incarnation: string }[]
    }
    const ref = { conversationId: owned.id, incarnation: listed.conversations[0]!.incarnation }
    peer.client.close()
    await peer.server.closed
    peer = await connect({
      daemonEpoch: peer.welcome.daemonEpoch,
      after: 0,
      controllerToken: peer.welcome.controllerToken!,
    })
    expect(await peer.client.request("conversations.focus", ref)).toMatchObject(ref)
    await peer.client.request("conversation.send", { ...ref, message: "native input" })
    await waitFor(() => nativeEvents.some((event) => JSON.stringify(event).includes("native input")))
    await waitFor(() => !owned.status().busy)
    expect(await peer.client.request("conversations.history", ref)).toMatchObject({
      messages: [{ role: "user" }, { role: "assistant" }],
    })
    const owner = agentSessionOwner(owned.id)!
    expect(owner.backgroundJobs).toBeDefined()
    const fakeJob = {
      id: "native-job",
      command: "mock",
      cwd,
      startedAt: 1,
      status: "running" as const,
      meta: {},
      contained: true,
      exitCode: null,
      signal: null,
      stopRequested: false,
      outputChars: 0,
    }
    if (!(owner.backgroundJobsHost instanceof SessionBackgroundJobHost)) throw new Error("Missing job host")
    const list = spyOn(owner.backgroundJobsHost, "listIn").mockImplementation((scope) =>
      scope.rootSessionId === owned.id ? [fakeJob] : [],
    )
    try {
      expect(await peer.client.request("jobs.list", { conversationId: owned.id })).toMatchObject({
        jobs: [{ id: "native-job" }],
      })
      expect(await peer.client.request("jobs.list", {})).toEqual({ jobs: [] })
    } finally {
      list.mockRestore()
    }
    await peer.client.request("conversation.stop", ref)
    expect(JSON.stringify(await peer.client.request("conversations.history", ref))).toContain("native input")
  } finally {
    for (const peer of peers) peer.close()
    await runtime.stop()
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}, 60_000)
