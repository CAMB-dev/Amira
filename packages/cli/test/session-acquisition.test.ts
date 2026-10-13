import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import { SessionStore, sessionLockFile } from "@amira/core"
import { createCommandHost } from "../src/control.ts"
import { createSession } from "../src/session.ts"

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-acquisition-"))
  const mock = createMockDialect([])
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const store = SessionStore.create({ cwd: dir, dir })
  const options = {
    ai,
    model: "mock/main",
    cwd: dir,
    extensions: [],
    noBuiltins: true,
    catalog: false as const,
  }
  return { dir, store, mock, options }
}

for (const boundary of ["resume", "startup"] as const) {
  test(`awaited CLI ${boundary} waits for requested gate retirement and restores current disk history`, async () => {
    const { dir, store, mock, options } = fixture()
    const session = await createSession({ ...options, store })
    store.appendMessage(userMessage("saved"))
    const stale = SessionStore.open(store.file)
    store.appendMessage(userMessage("new on disk"))
    const gate = `${sessionLockFile(store.file)}.lease-gate`
    const rename = fs.renameSync
    let blocked = true
    const hook = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (blocked && String(from) === gate && String(to).includes(".retired-")) {
        throw Object.assign(new Error("reader denies deletion"), { code: "EPERM" })
      }
      return rename(from, to)
    })
    let resumed: Awaited<ReturnType<typeof session.resume>> | undefined
    let release: ReturnType<typeof setTimeout> | undefined
    try {
      await session.agent.dispose()
      const start = performance.now()
      const callback = new Promise<number>((resolve) =>
        setTimeout(() => resolve(performance.now() - start), 0),
      )
      release = setTimeout(() => {
        blocked = false
      }, 100)
      resumed =
        boundary === "resume"
          ? await session.resume(stale)
          : (await createSession({ ...options, store: stale })).agent
      expect(performance.now() - start).toBeGreaterThanOrEqual(90)
      expect(await callback).toBeLessThan(20)
      expect(resumed.messages.map((m) => m.content)).toEqual([
        userMessage("saved").content,
        userMessage("new on disk").content,
      ])
      expect(mock.requests).toHaveLength(0)
    } finally {
      blocked = false
      clearTimeout(release)
      hook.mockRestore()
      await resumed?.dispose()
      await session.agent.dispose()
      // Drive any exact release-requested cleanup before removing this fixture.
      store.claim()
      store.release()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

for (const command of ["resume", "clear", "fork"] as const) {
  test(`CLI ${command} waits before job/notice hand-over and announces only the acquired agent`, async () => {
    const { dir, store, options } = fixture()
    const session = await createSession({ ...options, store })
    store.appendMessage(userMessage("source"))
    const old = session.agent
    const announcements: string[] = []
    const host = createCommandHost({
      session,
      cwd: dir,
      announce: (agent, reason) => announcements.push(`${reason}:${agent.sessionId}`),
    })
    const handover = spyOn(session.host.backgroundJobs, "handoverRoot")
    const cancel = spyOn(old, "cancelNoticeRetry")
    const rename = fs.renameSync
    const oldGate = `${sessionLockFile(store.file)}.lease-gate`
    let denied = true
    let release: ReturnType<typeof setTimeout> | undefined
    const hook = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (
        denied &&
        String(from) !== oldGate &&
        String(from).endsWith(".lease-gate") &&
        String(to).includes(".retired-")
      ) {
        release ??= setTimeout(() => {
          denied = false
        }, 100)
        throw Object.assign(new Error("requested gate reader"), { code: "EPERM" })
      }
      return rename(from, to)
    })
    const create = SessionStore.create
    const acquire = SessionStore.prototype.withClaim
    let callback: Promise<number> | undefined
    const acquisition = spyOn(SessionStore.prototype, "withClaim").mockImplementation(function <T>(
      this: SessionStore,
      construct: () => T,
      opts?: Parameters<SessionStore["withClaim"]>[1],
    ) {
      const start = performance.now()
      callback = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - start), 0))
      return (acquire<T>).call(this, construct, opts)
    })
    let created: ReturnType<typeof spyOn> | undefined
    let switching: Promise<unknown> | undefined
    try {
      let target: SessionStore | undefined
      if (command === "resume") {
        target = create({ cwd: dir, dir })
        target.appendMessage(userMessage("destination"))
      } else if (command === "clear") {
        created = spyOn(SessionStore, "create").mockImplementation((opts) => {
          const next = create(opts)
          next.claim()
          next.release()
          return next
        })
      }
      const pending =
        command === "resume"
          ? host.control.resume!(target!.id)
          : command === "clear"
            ? host.control.newSession!()
            : host.control.fork!()
      switching = pending
      // Measure warm acquisition, not the synchronous fork's disk/history copy beforehand.
      expect(callback).toBeDefined()
      expect(await callback).toBeLessThan(20)
      expect(host.agent).toBe(old)
      expect(handover).not.toHaveBeenCalled()
      expect(cancel).not.toHaveBeenCalled()
      expect(announcements).toEqual([])
      store.appendDisplay({ type: "display", level: "info", text: "old owner remains usable while waiting" })
      await pending
      expect(host.agent).not.toBe(old)
      expect(handover).toHaveBeenCalledTimes(1)
      expect(announcements).toEqual([`${command === "clear" ? "clear" : command}:${host.agent.sessionId}`])
      expect(host.agent.messages).toHaveLength(command === "clear" ? 0 : 1)
    } finally {
      denied = false
      clearTimeout(release)
      hook.mockRestore()
      created?.mockRestore()
      acquisition.mockRestore()
      handover.mockRestore()
      cancel.mockRestore()
      await switching?.catch(() => {})
      await host.agent.dispose()
      await old.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("failed CLI switch preserves the old agent's notices and job scope", async () => {
  const { dir, store, options } = fixture()
  const session = await createSession({ ...options, store })
  const target = SessionStore.create({ cwd: dir, dir })
  target.appendMessage(userMessage("destination"))
  const gate = `${sessionLockFile(target.file)}.lease-gate`
  fs.mkdirSync(gate)
  fs.writeFileSync(path.join(gate, "owner.json"), "corrupt owner")
  const old = session.agent
  const host = createCommandHost({ session, cwd: dir })
  const cancel = spyOn(old, "cancelNoticeRetry")
  const handover = spyOn(session.host.backgroundJobs, "handoverRoot")
  const timers = spyOn(globalThis, "setTimeout")
  try {
    await expect(host.control.resume!(target.id)).rejects.toThrow(gate)
    expect(timers).not.toHaveBeenCalled()
    expect(host.agent).toBe(old)
    expect(cancel).not.toHaveBeenCalled()
    expect(handover).not.toHaveBeenCalled()
    store.appendDisplay({ type: "display", level: "info", text: "still owned" })
    expect(fs.existsSync(sessionLockFile(store.file))).toBe(true)
  } finally {
    timers.mockRestore()
    cancel.mockRestore()
    handover.mockRestore()
    await old.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
