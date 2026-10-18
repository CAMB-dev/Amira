import "./offline.ts"
import { afterAll, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import type { Extension, UiApi } from "@amira/api"
import { SessionStore, sessionLockFile } from "@amira/core"
import { createWorkspaceRuntime, type WorkspaceRuntime } from "../../src/server/runtime.ts"
import { createServerRuntime } from "../../src/server-main.ts"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "amira-server-review-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
const ai = () =>
  createAi({ dialects: [createMockDialect([])], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
async function fixture(extension: Extension = () => {}) {
  const store = SessionStore.create({ cwd: root })
  const runtime = await createWorkspaceRuntime({
    cwd: root,
    ai: ai(),
    model: "mock/test",
    autoTitle: false,
    store,
    builtins: async () => [{ source: "test", extension }],
  })
  return { runtime, store }
}

for (const kind of ["dialog", "form"] as const) {
  test(`retained ${kind} can be answered through acknowledged host operations`, async () => {
    let ui!: UiApi
    const { runtime } = await fixture((api) => {
      ui = api.ui
    })
    try {
      const first = runtime.attach()
      const answer =
        kind === "dialog"
          ? ui.confirm("Approve")
          : ui.form({
              title: "Name",
              fields: [{ type: "text", id: "name", label: "Name", required: true }],
              beforeSubmit: async () => ({}),
            })
      const requestId = first.pendingRequests[0]!.requestId
      await first.detach()
      const next = runtime.attach()
      if (kind === "dialog") {
        expect(await next.request("ui.respond", { requestId, value: "bad" })).toMatchObject({
          status: "invalid",
        })
        expect(next.pendingRequests).toHaveLength(1)
        expect(await next.request("ui.respond", { requestId, value: true })).toEqual({ status: "accepted" })
        expect(await answer).toBe(true)
      } else {
        const claim = await next.request("form.open", { requestId })
        const invalid = { ...claim, values: { name: "" } }
        expect((await next.request("form.evaluate", { requestId, draft: invalid })).errors.name).toBeDefined()
        expect((await next.request("form.submit", { requestId, draft: invalid })).status).toBe("invalid")
        const valid = { ...claim, revision: claim.revision + 1, values: { name: "Ada" } }
        await next.request("form.evaluate", { requestId, draft: valid })
        expect((await next.request("form.submit", { requestId, draft: valid })).status).toBe("accepted")
        expect(await answer).toEqual({ name: "Ada" })
      }
      expect(next.pendingRequests).toHaveLength(0)
      expect(await next.request("ui.respond", { requestId, value: true })).toEqual({ status: "settled" })
    } finally {
      await runtime.stop()
    }
  })
}

test("form editor replacement fences old actions and cancellation across detach", async () => {
  let ui!: UiApi
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const { runtime } = await fixture((api) => {
    ui = api.ui
  })
  try {
    const first = runtime.attach()
    const answer = ui.form({
      title: "Form authority",
      fields: [
        {
          type: "action",
          id: "load",
          label: "Load",
          run: async () => {
            started.resolve()
            await gate.promise
            return { message: "late result" }
          },
        },
      ],
    })
    const requestId = first.pendingRequests[0]!.requestId
    const old = await first.request("form.open", { requestId })
    const action = first.request("form.action", { requestId, draft: { ...old, values: {}, action: "load" } })
    await started.promise
    await first.detach()
    const next = runtime.attach()
    const fresh = await next.request("form.open", { requestId })
    gate.resolve()
    expect((await action).status).toBe("stale")
    expect(await next.request("form.cancel", { requestId, ...old })).toMatchObject({ status: "invalid" })
    expect(next.pendingRequests).toHaveLength(1)
    expect(await next.request("form.cancel", { requestId, ...fresh })).toEqual({ status: "cancelled" })
    expect(await answer).toBeUndefined()
  } finally {
    gate.resolve()
    await runtime.stop()
  }
})

function holdAcquisition(target: SessionStore) {
  const gate = `${sessionLockFile(target.file)}.lease-gate`
  const rename = fs.renameSync
  let blocked = true
  const hook = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (blocked && String(from) === gate && String(to).includes(".retired-"))
      throw Object.assign(new Error("test gate reader"), { code: "EPERM" })
    return rename(from, to)
  })
  target.claim()
  target.release()
  return () => {
    blocked = false
    hook.mockRestore()
  }
}
for (const route of ["direct", "command"] as const) {
  test(`explicit shutdown cancels and drains a waiting ${route} session selection`, async () => {
    const { runtime } = await fixture((api) => {
      api.registerCommand({
        name: "select",
        description: "test",
        run: async (_args, context) => {
          await context.session.resume(target.id)
        },
      })
    })
    const target = SessionStore.create({ cwd: root })
    target.appendMessage(userMessage("destination"))
    const release = holdAcquisition(target)
    const attachment = runtime.attach()
    const pending = (
      route === "direct"
        ? attachment.execute("session.resume", { id: target.id })
        : attachment.execute("command.run", { line: "/select" })
    ).catch((error: unknown) => error)
    try {
      const stopped = runtime.stop()
      release()
      await stopped
      const outcome = await pending
      expect(outcome).toMatchObject(
        route === "direct" ? { code: "cancelled" } : { ok: false, error: "cancelled" },
      )
      const deadline = Date.now() + 1000
      while (fs.existsSync(sessionLockFile(target.file)) && Date.now() < deadline) await Bun.sleep(5)
      expect(fs.existsSync(sessionLockFile(target.file))).toBe(false)
      expect(() => runtime.attach()).toThrow("stopped")
    } finally {
      release()
      await pending
      await runtime.stop()
    }
  })
}

for (const route of ["direct", "command"] as const) {
  test(`detach preserves a waiting ${route} selection until explicit shutdown`, async () => {
    const target = SessionStore.create({ cwd: root })
    target.appendMessage(userMessage("destination"))
    const { runtime } = await fixture((api) => {
      api.registerCommand({
        name: "select",
        description: "test",
        run: async (_args, context) => {
          await context.session.resume(target.id)
        },
      })
    })
    const release = holdAcquisition(target)
    const attachment = runtime.attach()
    const pending =
      route === "direct"
        ? attachment.execute("session.resume", { id: target.id })
        : attachment.execute("command.run", { line: "/select" })
    try {
      await attachment.detach()
      release()
      await pending
      expect(runtime.attach().identity!.sessionId).toBe(target.id)
      expect(fs.existsSync(sessionLockFile(target.file))).toBe(true)
    } finally {
      release()
      await pending
      await runtime.stop()
    }
    expect(fs.existsSync(sessionLockFile(target.file))).toBe(false)
  })
}

test("initial attachment retains startup errors, warnings and skipped executable contributions", async () => {
  const unsafe = path.join(root, "unsafe.ts")
  fs.writeFileSync(unsafe, "throw new Error('must not execute')")
  const runtime = await createWorkspaceRuntime({
    cwd: root,
    ai: ai(),
    model: "mock/test",
    autoTitle: false,
    warnings: ["remote configuration warning"],
    extensions: [unsafe],
    builtins: async () => [
      {
        source: "broken-builtin",
        extension: () => {
          throw new Error("builtin failed")
        },
      },
    ],
  })
  try {
    const first = runtime.attach()
    const text = JSON.stringify(first.startupEvents)
    expect(text).toContain("remote configuration warning")
    expect(text).toContain("builtin failed")
    expect(text).toContain("unsafe.ts")
    expect(text).toContain("Skipped executable extension")
    await first.detach()
    expect(runtime.attach().startupEvents).toEqual(first.startupEvents)
  } finally {
    await runtime.stop()
  }
})

async function turn(attachment: ReturnType<WorkspaceRuntime["attach"]>) {
  const ended = new Promise<void>((resolve) => {
    const off = attachment.subscribeEvents((event) => {
      if (event.type === "turn.end") {
        off()
        resolve()
      }
    })
  })
  await attachment.execute("turn.prompt", { message: "hello" })
  await ended
}
test("configured remote reload rereads settings without auth or local presentation", async () => {
  const home = path.join(root, "reload-home")
  const cwd = path.join(root, "reload-workspace")
  const dirs = ["before", "after"].map((name) => path.join(root, name))
  for (const dir of [home, cwd, ...dirs]) fs.mkdirSync(dir)
  for (const [i, dir] of dirs.entries()) {
    const skill = path.join(dir, `unique-skill-${i}`)
    fs.mkdirSync(skill)
    fs.writeFileSync(
      path.join(skill, "SKILL.md"),
      `---\nname: unique-skill-${i}\ndescription: test skill ${i}\n---\nInstructions`,
    )
  }
  const settingsFile = path.join(home, "settings.json")
  const settings = (dir: string) => ({
    model: "mock/test",
    skills: { dirs: [dir] },
    sessions: { autoTitle: false },
    tui: { theme: "missing" },
  })
  fs.writeFileSync(settingsFile, JSON.stringify(settings(dirs[0]!)))
  fs.writeFileSync(path.join(home, "auth.json"), "invalid auth that must not be read")
  const previous = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = home
  const mock = createMockDialect([{ text: "first" }, { text: "second" }])
  let runtime: WorkspaceRuntime | undefined
  try {
    runtime = await createServerRuntime({
      cwd,
      ai: createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] }),
    })
    const attachment = runtime.attach()
    await turn(attachment)
    expect(mock.requests[0]!.systemPrompt).toContain("unique-skill-0")
    fs.writeFileSync(settingsFile, JSON.stringify(settings(dirs[1]!)))
    expect((await attachment.execute("command.run", { line: "/reload" })).ok).toBe(true)
    await turn(attachment)
    expect(mock.requests[1]!.systemPrompt).toContain("unique-skill-1")
    expect(mock.requests[1]!.systemPrompt).not.toContain("unique-skill-0")
  } finally {
    await runtime?.stop()
    if (previous === undefined) delete process.env.AMIRA_HOME
    else process.env.AMIRA_HOME = previous
  }
})
