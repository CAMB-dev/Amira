import "./offline.ts"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import type { ExtensionAPI } from "@amira/api"
import type { FrontendUpdate } from "@amira/core"
import { REMOTE_LIMITS } from "../../src/remote/protocol.ts"
import { validateRemoteDto } from "../../src/remote-schema.ts"
import {
  createWorkspaceRuntime,
  type ServerEvent,
  type WorkspaceRuntimeOptions,
} from "../../src/server/runtime.ts"

async function fixture(steps: MockStep[], builtins?: WorkspaceRuntimeOptions["builtins"]) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-runtime-events-"))
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "", apiKey: "test" }],
  })
  const runtime = await createWorkspaceRuntime({
    cwd,
    ai,
    model: "mock/test",
    autoTitle: false,
    ...(builtins ? { builtins } : {}),
  })
  return {
    runtime,
    ai,
    async close() {
      await runtime.stop()
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}
function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Expected workspace event did not arrive")), 4000)
    }),
  ]).finally(() => clearTimeout(timer))
}

test("actual ask_user completion reaches subscribeEvents with persisted presenter details", async () => {
  const questions = [
    {
      question: "Which option?",
      header: "Choice",
      options: [
        { label: "Alpha", description: "First" },
        { label: "Beta", description: "Second" },
      ],
    },
  ]
  const f = await fixture([{ toolCalls: [{ name: "ask_user", args: { questions } }] }, { text: "Answered" }])
  const attachment = f.runtime.attach()
  const events: ServerEvent[] = []
  let opened!: (id: string) => void
  let ended!: () => void
  const pending = new Promise<string>((resolve) => {
    opened = resolve
  })
  const done = new Promise<void>((resolve) => {
    ended = resolve
  })
  const off = attachment.subscribeEvents((event) => {
    events.push(event)
    if (event.type === "ui.request" && event.data.kind === "ask") opened(event.data.requestId)
    if (event.type === "turn.end") ended()
  })
  try {
    await attachment.execute("turn.prompt", { message: "Ask me" })
    const requestId = await deadline(pending)
    expect(await attachment.request("ui.respond", { requestId, value: [{ selected: ["Alpha"] }] })).toEqual({
      status: "accepted",
    })
    await deadline(done)
    const results = events.filter(
      (event) => event.type === "tool.execute.end" && event.data.name === "ask_user",
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({
      result: {
        persistDetails: true,
        details: { questions, outcome: { answers: [{ selected: ["Alpha"] }] } },
      },
    })
    expect(events.some((event) => event.type === "extension.error")).toBe(false)
    expect(JSON.stringify(attachment.snapshot.transcript)).toContain("Alpha")
  } finally {
    off()
    await f.close()
  }
}, 10_000)

test("persisted partial and complete tool results both reach subscribeEvents", async () => {
  const result = {
    content: [{ type: "text" as const, text: "Result" }],
    details: { selected: "Alpha" },
    persistDetails: true,
  }
  const f = await fixture([{ toolCalls: [{ name: "partial", args: {} }] }, { text: "Done" }], async () => [
    {
      source: "fixture",
      extension: (api) => {
        api.registerTool({
          name: "partial",
          description: "Report progress",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          traits: { readOnly: true },
          async execute(_args, ctx) {
            ctx.update(result)
            return result
          },
        })
      },
    },
  ])
  const attachment = f.runtime.attach()
  const events: ServerEvent[] = []
  let ended!: () => void
  const done = new Promise<void>((resolve) => {
    ended = resolve
  })
  const off = attachment.subscribeEvents((event) => {
    events.push(event)
    if (event.type === "turn.end") ended()
  })
  try {
    await attachment.execute("turn.prompt", { message: "Report progress" })
    await deadline(done)
    expect(events.filter((event) => event.type === "tool.execute.update")).toMatchObject([
      { data: { partial: result } },
    ])
    expect(events.filter((event) => event.type === "tool.execute.end")).toMatchObject([{ data: { result } }])
    expect(events.some((event) => event.type === "extension.error")).toBe(false)
  } finally {
    off()
    await f.close()
  }
}, 10_000)

for (const unexpected of ["SENTINEL_PROVIDER_SECRET", () => "SENTINEL_PROVIDER_SECRET"]) {
  test(`an invalid outgoing event becomes an explicit sanitized protocol error (${typeof unexpected})`, async () => {
    let api!: ExtensionAPI
    const f = await fixture([], async () => [
      {
        source: "fixture",
        extension: (value) => {
          api = value
        },
      },
    ])
    const attachment = f.runtime.attach()
    const events: ServerEvent[] = []
    const off = attachment.subscribeEvents((event) => {
      events.push(event)
    })
    try {
      api.notify("Invalid fixture event", "info", { unexpected } as never)
      api.notify("Valid event after failure")
      await Bun.sleep(0)
      expect(events.filter((event) => event.type === "extension.error")).toMatchObject([
        { data: { source: "remote:protocol" } },
      ])
      expect(events.filter((event) => event.type === "extension.notice")).toMatchObject([
        { data: { text: "Valid event after failure" } },
      ])
      expect(JSON.stringify(events)).not.toContain("SENTINEL")
      expect(events).toHaveLength(2)
    } finally {
      off()
      await f.close()
    }
  })
}

test("protocol faults do not inherit poisoned serialization hooks", async () => {
  let api!: ExtensionAPI
  const f = await fixture([], async () => [
    {
      source: "fixture",
      extension: (value) => {
        api = value
      },
    },
  ])
  const attachment = f.runtime.attach()
  const events: ServerEvent[] = []
  const off = attachment.subscribeEvents((event) => {
    events.push(event)
  })
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON")
  let hooks = 0
  let faultHooks = 0
  let serializedFault = ""
  let validationFailure: unknown
  try {
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() {
        hooks++
        return "SENTINEL_REPLACEMENT"
      },
    })
    try {
      api.notify("Fixture event")
      await Bun.sleep(0)
      if (events[0]) {
        const before = hooks
        try {
          validateRemoteDto("coreEvent", events[0])
          serializedFault = JSON.stringify(events[0])
        } catch (error) {
          validationFailure = error
        }
        faultHooks = hooks - before
      }
    } finally {
      if (original) Object.defineProperty(Object.prototype, "toJSON", original)
      else Reflect.deleteProperty(Object.prototype, "toJSON")
    }
    expect(events).toMatchObject([{ type: "extension.error", data: { source: "remote:protocol" } }])
    expect(validationFailure).toBeUndefined()
    expect(faultHooks).toBe(0)
    expect(JSON.parse(serializedFault)).toMatchObject({
      type: "extension.error",
      data: { source: "remote:protocol" },
    })
  } finally {
    off()
    await f.close()
  }
})

test("protocol faults bound metadata independently of the failed event", async () => {
  let api!: ExtensionAPI
  const oversized = "S".repeat(REMOTE_LIMITS.logicalBytes + 1)
  const f = await fixture([], async () => [
    {
      source: "fixture",
      extension: (value) => {
        api = value
        api.on("extension.notice", (event) => {
          event.sessionId = oversized
          event.parentSessionId = oversized
          event.turnId = oversized
        })
      },
    },
  ])
  const attachment = f.runtime.attach()
  const events: ServerEvent[] = []
  const off = attachment.subscribeEvents((event) => {
    events.push(event)
  })
  try {
    api.notify("Fixture event")
    await Bun.sleep(0)
    expect(events).toMatchObject([
      { type: "extension.error", sessionId: "host", data: { source: "remote:protocol" } },
    ])
    const fault = events[0]!
    expect(fault.parentSessionId).toBeUndefined()
    expect(fault.turnId).toBeUndefined()
    validateRemoteDto("coreEvent", fault)
    expect(JSON.stringify(fault).length).toBeLessThan(1024)
  } finally {
    off()
    await f.close()
  }
})

test("snapshot update validation failures are explicit and later valid updates still arrive", async () => {
  const f = await fixture([], async () => [])
  const attachment = f.runtime.attach()
  const updates: FrontendUpdate[] = []
  const off = attachment.subscribe((update) => {
    updates.push(update)
  })
  const model = f.ai.model.bind(f.ai)
  let invalid = true
  f.ai.model = (ref) =>
    invalid ? { ...model(ref), contextWindow: "SENTINEL_BAD_METADATA" as never } : model(ref)
  try {
    await attachment.request("model.set", { model: "mock/other" })
    await Bun.sleep(0)
    expect(updates).toMatchObject([{ kind: "error", error: { code: "invalid_snapshot" } }])
    const fault = updates[0]
    expect(Object.getPrototypeOf(fault)).toBeNull()
    if (fault?.kind === "error") expect(Object.getPrototypeOf(fault.error)).toBeNull()
    expect(JSON.stringify(updates)).not.toContain("SENTINEL")
    invalid = false
    await attachment.request("model.set", { model: "mock/test" })
    await Bun.sleep(0)
    expect(updates.at(-1)?.kind).toBe("snapshot")
  } finally {
    off()
    await f.close()
  }
})
