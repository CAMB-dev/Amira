import "./offline.ts"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { ExtensionAPI } from "@amira/api"
import type { FrontendUpdate } from "@amira/core"
import { encodeRemoteMessage, RemoteDecoder } from "../../src/remote/codec.ts"
import type { JournalEvent } from "../../src/server/journal.ts"
import { createWorkspaceRuntime, type ServerEvent } from "../../src/server/runtime.ts"

const secret = "SENTINEL_PROVIDER_SECRET"

test("local projector errors get fixed public messages in subscriptions and wire events", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-projection-errors-"))
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const runtime = await createWorkspaceRuntime({
    cwd,
    ai,
    model: "mock/test",
    autoTitle: false,
    builtins: async () => [],
  })
  const attachment = runtime.attach()
  const updates: FrontendUpdate[] = []
  const off = attachment.subscribe((update) => {
    updates.push(update)
  })
  const journalEvents: JournalEvent[] = []
  const cut = runtime.journal.open(
    { daemonEpoch: runtime.journal.daemonEpoch, after: runtime.journal.watermark },
    () => runtime.workspaceSnapshot(),
    (event) => journalEvents.push(event),
  )
  const model = ai.model.bind(ai)
  ai.model = (ref) => ({
    ...model(ref),
    get contextWindow(): number {
      throw new Error(secret)
    },
  })
  try {
    await attachment.request("model.set", { model: "mock/other" })
    await Bun.sleep(0)
    const error = updates.find((update) => update.kind === "error")
    expect(error).toEqual({
      kind: "error",
      error: { code: "invalid_snapshot", message: "Workspace display state is unavailable." },
    })
    expect(JSON.stringify(updates)).not.toContain(secret)
    expect(JSON.stringify(journalEvents)).not.toContain(secret)
    expect(journalEvents.some((event) => (event.payload as { kind?: string }).kind === "error")).toBe(true)
    if (!error) throw new Error("Expected a projection error update")
    const frames = [
      ...encodeRemoteMessage({ v: 1, kind: "event", daemonEpoch: "epoch-1", seq: 1, payload: error }),
    ]
    expect(new TextDecoder().decode(Buffer.concat(frames))).not.toContain(secret)
    const decoder = new RemoteDecoder()
    expect(frames.flatMap((frame) => decoder.push(frame))).toMatchObject([{ kind: "event", payload: error }])
    decoder.finish()
  } finally {
    cut.close()
    off()
    await runtime.stop()
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

test("a throwing malformed-event accessor produces one fixed fault, then normal delivery continues", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-event-errors-"))
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  let api!: ExtensionAPI
  const runtime = await createWorkspaceRuntime({
    cwd,
    ai,
    model: "mock/test",
    autoTitle: false,
    builtins: async () => [
      {
        source: "fixture",
        extension: (value) => {
          api = value
          api.on("extension.notice", (event) => {
            if (event.data.text === "Malformed event")
              Object.defineProperty(event, "seq", {
                configurable: true,
                get() {
                  throw new Error(secret)
                },
              })
          })
        },
      },
    ],
  })
  const attachment = runtime.attach()
  const events: ServerEvent[] = []
  const off = attachment.subscribeEvents((event) => {
    events.push(event)
  })
  try {
    api.notify("Malformed event")
    api.notify("Following event")
    await Bun.sleep(0)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      seq: 0,
      ts: 0,
      sessionId: "host",
      type: "extension.error",
      data: { source: "remote:protocol" },
    })
    expect(events[0]?.parentSessionId).toBeUndefined()
    expect(events[0]?.turnId).toBeUndefined()
    expect(events[1]).toMatchObject({ type: "extension.notice", data: { text: "Following event" } })
    expect(JSON.stringify(events)).not.toContain(secret)
  } finally {
    off()
    await runtime.stop()
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})
