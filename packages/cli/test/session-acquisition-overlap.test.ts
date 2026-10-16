import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep, userMessage } from "@amira/ai"
import { SessionStore, sessionLockFile } from "@amira/core"
import commandsExtension from "../../../extensions/commands/src/index.ts"
import { SPAWN_TEST_TIMEOUT_MS, waitForSpawnCondition } from "../../../scripts/spawn-test.ts"
import { createCommandHost } from "../src/control.ts"
import { createSession } from "../src/session.ts"

async function fixture(steps: MockStep[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-acquisition-overlap-"))
  const mock = createMockDialect(steps)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const store = SessionStore.create({ cwd: dir, dir })
  const session = await createSession({
    ai,
    model: "mock/main",
    cwd: dir,
    store,
    extensions: [],
    noBuiltins: false,
    catalog: false,
    builtins: async () => [{ source: "builtin:commands", extension: commandsExtension }],
  })
  const announcements: string[] = []
  const host = createCommandHost({
    session,
    cwd: dir,
    announce: (agent) => announcements.push(agent.sessionId),
  })
  const target = SessionStore.create({ cwd: dir, dir })
  target.appendMessage(userMessage("destination"))
  return { dir, mock, store, session, host, target, announcements }
}

function holdAcquisition(target: SessionStore) {
  const gate = `${sessionLockFile(target.file)}.lease-gate`
  const rename = fs.renameSync
  let blocked = true
  const hook = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (blocked && String(from) === gate && String(to).includes(".retired-"))
      throw Object.assign(new Error("own gate reader"), { code: "EPERM" })
    return rename(from, to)
  })
  target.claim()
  target.release()
  // A failed assertion must not leave an acquisition waiting for the two-second budget.
  const timer = setTimeout(() => {
    blocked = false
  }, 100)
  return () => {
    blocked = false
    clearTimeout(timer)
    hook.mockRestore()
  }
}

async function until(check: () => boolean) {
  const deadline = performance.now() + 1000
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("mock turn did not reach its barrier")
    await Bun.sleep(1)
  }
}

test(
  "a waiting slash resume cannot overwrite a newer direct resume or steal its jobs/notices",
  async () => {
    const { dir, store, session, host, target, announcements } = await fixture()
    const old = host.agent
    const release = holdAcquisition(target)
    const pending = host.run(`/resume ${target.id}`, { frontend: "rpc" })
    let job: ReturnType<NonNullable<typeof old.backgroundJobs>["start"]> | undefined
    try {
      expect(host.agent).toBe(old)
      const winning = SessionStore.create({ cwd: dir, dir })
      winning.appendMessage(userMessage("winning session"))
      await host.control.resume!(winning.id)
      const current = host.agent
      job = current.backgroundJobs!.start({
        command: "overlap-owned job",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: dir,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
        ),
      })
      const notice = current.expectNotice()
      await until(() => current.backgroundJobs!.get(job!.id)?.status === "running")
      release()
      expect(await pending).toMatchObject({ ok: false, error: "cancelled" })
      // Cancellation stops acquisition retries; the pre-existing requested release finishes
      // on its own bounded cleanup chain after the reader is released.
      await until(() => !fs.existsSync(sessionLockFile(target.file)))
      expect(host.agent).toBe(current)
      expect(announcements).toEqual([winning.id])
      expect(current.backgroundJobs!.get(job.id)?.status).toBe("running")
      expect(fs.existsSync(sessionLockFile(winning.file))).toBe(true)
      expect(fs.existsSync(sessionLockFile(target.file))).toBe(false)
      notice.deliver(userMessage("winning completion"), { wake: false })
      expect(current.takeNotices()).toEqual([userMessage("winning completion")])
      expect(old.takeNotices()).toEqual([])
    } finally {
      release()
      try {
        await pending
      } finally {
        if (job) {
          const id = job.id
          await session.host.backgroundJobs.stop(id, 0)
          await waitForSpawnCondition(
            "overlap job cleanup",
            () => !["starting", "running"].includes(session.host.backgroundJobs.get(id)?.status ?? ""),
          )
        }
        await host.agent.dispose()
        await old.dispose()
        store.claim()
        store.release()
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test("a fast clear redirects a queued microtask notice before delivery, without old-agent consumption", async () => {
  const { dir, host, mock } = await fixture([{ text: "noticed" }])
  const old = host.agent
  const notice = old.expectNotice()
  queueMicrotask(() => notice.deliver(userMessage("fast completion"), { wake: false }))
  try {
    await host.control.newSession!()
    expect(old.waitingNotices).toBe(0)
    expect(old.messages).toHaveLength(0)
    expect(mock.requests).toHaveLength(0)
    expect(host.agent.waitingNotices).toBe(1)
    const turn = host.agent.wake()
    expect(turn).toBeDefined()
    expect((await turn)?.reason).toBe("done")
    expect(JSON.stringify(mock.requests[0]?.messages)).toContain("fast completion")
  } finally {
    await host.agent.dispose()
    await old.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

for (const wake of ["prompt", "notice"] as const) {
  test(`a waiting resume rejects if a ${wake} starts a turn, without aborting it or its children`, async () => {
    let finish!: () => void
    const barrier = new Promise<void>((resolve) => {
      finish = resolve
    })
    const { dir, store, session, host, target, mock, announcements } = await fixture([
      { text: "child ready" },
      { text: "turn completed", hold: { chunks: 0, until: barrier } },
    ])
    const old = host.agent
    const child = session.tree.spawn(old, { prompt: "stay alive", persistent: true })
    await until(() => child.state === "idle")
    const release = holdAcquisition(target)
    const pending = host.control.resume!(target.id)
    let turn: ReturnType<typeof old.prompt> | undefined
    const finishTimer = setTimeout(finish, 100)
    try {
      expect(host.agent).toBe(old)
      if (wake === "notice") old.expectNotice().deliver(userMessage("background completion"))
      else turn = old.prompt("a new turn")
      turn ??= old.currentTurn
      await until(() => mock.requests.length === 2)
      expect(old.busy).toBe(true)
      release()
      const outcome = await pending.then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(outcome).toBeInstanceOf(Error)
      expect(String(outcome)).toContain("a turn is running")
      expect(host.agent).toBe(old)
      expect(old.busy).toBe(true)
      expect(child.state).toBe("idle")
      expect(session.tree.children).toHaveLength(1)
      expect(announcements).toEqual([])
      expect(fs.existsSync(sessionLockFile(target.file))).toBe(false)
      expect(fs.existsSync(sessionLockFile(store.file))).toBe(true)
      finish()
      expect((await turn)?.reason).toBe("done")
    } finally {
      clearTimeout(finishTimer)
      release()
      finish()
      await pending.catch(() => {})
      await turn
      await host.agent.dispose()
      await old.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}
