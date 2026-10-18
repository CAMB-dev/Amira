import "./offline.ts"
import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { Extension, UiApi } from "@amira/api"
import { SessionStore } from "@amira/core"
import { createWorkspaceRuntime, type WorkspaceRuntime } from "../../src/server/runtime.ts"

const root = mkdtempSync(path.join(os.tmpdir(), "amira-server-runtime-"))
const runtimes: WorkspaceRuntime[] = []
afterAll(async () => {
  for (const runtime of runtimes) await runtime.stop()
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})
const ai = () =>
  createAi({
    dialects: [createMockDialect([{ text: "completed detached", delayMs: 60 }])],
    providers: [
      { id: "mock", dialect: "mock", baseUrl: "https://never.invalid/?key=sentinel", apiKey: "sentinel" },
    ],
  })
async function setup(builtins: () => Promise<{ source: string; extension: Extension }[]> = async () => []) {
  const store = SessionStore.create({ cwd: root })
  const runtime = await createWorkspaceRuntime({
    cwd: root,
    ai: ai(),
    model: "mock/test",
    autoTitle: false,
    store,
    builtins,
  })
  runtimes.push(runtime)
  return { runtime, store }
}
async function eventually(check: () => boolean) {
  const end = Date.now() + 2000
  while (!check() && Date.now() < end) await Bun.sleep(5)
  expect(check()).toBe(true)
}

test("detach retains work, session lease and stable transcript identity across sequential attachments", async () => {
  let unloads = 0
  const { runtime, store } = await setup(async () => [
    {
      source: "test",
      extension: (api) => {
        api.onUnload(() => {
          unloads++
        })
      },
    },
  ])
  const first = runtime.attach()
  let updates = 0
  first.subscribe(() => {
    updates++
  })
  expect(first.quitBehavior).toBe("detach")
  expect(() => runtime.attach()).toThrow("already attached")
  const generation = first.identity!.sessionGeneration
  await first.execute("turn.prompt", { message: "keep going" })
  await first.detach()
  const updateCut = updates
  expect(existsSync(`${store.file}.lock`)).toBe(true)
  expect(unloads).toBe(0)
  await expect(first.execute("turn.abort", {})).rejects.toMatchObject({ code: "disconnected" })
  const second = runtime.attach()
  await eventually(() => second.snapshot.transcript.messages.some((e) => e.message.role === "assistant"))
  expect(second.identity!.sessionGeneration).toBe(generation)
  expect(updates).toBe(updateCut)
  const ids = second.snapshot.transcript.messages.map((e) => e.id)
  await second.detach()
  const third = runtime.attach()
  expect(third.snapshot.transcript.messages.map((e) => e.id)).toEqual(ids)
  expect(JSON.stringify(third.snapshot)).toContain("completed detached")
  await runtime.stop()
  expect(unloads).toBe(1)
  expect(existsSync(`${store.file}.lock`)).toBe(false)
  expect(() => runtime.attach()).toThrow("stopped")
})

test("pending dialogs survive detach without fallback/denial or extension unload", async () => {
  let ui: UiApi | undefined
  const { runtime } = await setup(async () => [
    {
      source: "test",
      extension: (api) => {
        ui = api.ui
      },
    },
  ])
  const first = runtime.attach()
  let settled = false
  const answer = ui!.confirm("Keep this approval").then((value) => {
    settled = true
    return value
  })
  expect(first.pendingRequests.length).toBe(1)
  const id = first.pendingRequests[0]!.requestId
  await first.detach()
  await Bun.sleep(10)
  expect(settled).toBe(false)
  const next = runtime.attach()
  expect(next.pendingRequests[0]!.requestId).toBe(id)
  await runtime.stop()
  expect(await answer).toBeUndefined()
})

test("session/model/status operations are copied JSON DTOs without credential-bearing providers", async () => {
  const { runtime, store } = await setup()
  const attachment = runtime.attach()
  await attachment.execute("turn.prompt", { message: "history" })
  await eventually(() => attachment.snapshot.state.status === "idle")
  const list = await attachment.request("sessions.list", { limit: 1 })
  expect(list.sessions[0]!.id).toBe(store.id)
  const history = await attachment.request("sessions.read", { id: store.id })
  expect(history).not.toBeNull()
  expect(history).not.toHaveProperty("subagentMessages")
  expect(JSON.parse(JSON.stringify(history))).toEqual(history)
  expect(await attachment.request("sessions.read", { id: "missing" })).toBeNull()
  await expect(attachment.request("sessions.list", { limit: 101 })).rejects.toMatchObject({
    code: "invalid_frame",
  })
  const models = await attachment.request("models.list", {})
  expect(models[0]).toMatchObject({ ref: "mock/test", available: true })
  await attachment.request("model.set", { model: "mock/other" })
  await attachment.request("thinking.set", { level: "default" })
  await attachment.request("fastMode.set", { enabled: true })
  const status = await attachment.request("status.read", {})
  expect(status.info.model.model).toBe("other")
  const serialized = JSON.stringify({ models, status, history })
  expect(serialized).not.toContain("sentinel")
  expect(serialized).not.toContain("baseUrl")
  await attachment.execute("session.clear", {})
  expect(attachment.identity!.sessionGeneration).toBe(2)
  await expect(attachment.request("status.read", {}, { sessionGeneration: 1 })).rejects.toMatchObject({
    code: "stale_session",
  })
  await attachment.execute("session.resume", { id: store.id })
  expect(attachment.identity!.sessionGeneration).toBe(3)
  expect(attachment.snapshot.transcript.messages.length).toBe(2)
})

test("arbitrary extensions never execute, including reload, and only allowlisted effects leave commands", async () => {
  const marker = path.join(root, "executed")
  const file = path.join(root, "unsafe.ts")
  writeFileSync(file, `await Bun.write(${JSON.stringify(marker)}, "bad"); export default () => {}`)
  const skillDir = path.join(root, "package-skills")
  const runtime = await createWorkspaceRuntime({
    cwd: root,
    ai: ai(),
    model: "mock/test",
    extensions: [file],
    packages: {
      packages: [
        {
          name: "unexecuted",
          scope: "user",
          dir: root,
          entry: {
            version: "1.0.0",
            source: { type: "path", path: root },
            pinned: {},
            installedAt: new Date().toISOString(),
          },
          manifest: {
            name: "unexecuted",
            version: "1.0.0",
            extensions: [file],
            skills: [skillDir],
            themes: [file],
            commands: {},
            hasDependencies: false,
          },
        },
      ],
      problems: [],
      skipped: [],
    },
    builtins: async () => [
      {
        source: "test",
        extension: (api) => {
          expect(api.settings.skills?.dirs).toContain(skillDir)
          api.registerCommand({
            name: "effects",
            description: "test",
            run: (_args, ctx) => {
              expect(ctx.openView?.({ kind: "arbitrary", data: { callback: () => {} } })).toBe(false)
              ctx.openView?.({ kind: "background-job", data: { id: "job-1", ignored: () => {} } })
              ctx.openRewind?.()
              ctx.print("plain output")
              ctx.quit()
            },
          })
          api.registerCommand({
            name: "reload",
            description: "test",
            run: async (_args, ctx) => {
              await ctx.session.reloadExtensions()
            },
          })
        },
      },
    ],
  })
  runtimes.push(runtime)
  const effects: unknown[] = []
  const attachment = runtime.attach({
    onEffect: (effect) => {
      effects.push(effect)
    },
  })
  const result = await attachment.execute("command.run", { line: "/effects" })
  expect(result).toMatchObject({ ok: true, output: ["plain output"] })
  expect(effects).toEqual([
    { kind: "view", view: "background-job", id: "job-1" },
    { kind: "rewind" },
    { kind: "detach" },
  ])
  expect((await attachment.execute("command.run", { line: "/reload" })).ok).toBe(true)
  expect(existsSync(marker)).toBe(false)
})
