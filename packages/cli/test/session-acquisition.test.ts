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
  test(`awaited CLI ${boundary} waits for transient lock sharing error and restores current disk history`, async () => {
    const { dir, store, mock, options } = fixture()
    const session = await createSession({ ...options, store })
    store.appendMessage(userMessage("saved"))
    const stale = SessionStore.open(store.file)
    store.appendMessage(userMessage("new on disk"))
    const lock = sessionLockFile(store.file)
    const link = fs.linkSync
    let blocked = true
    const hook = spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (blocked && String(to) === lock) {
        throw Object.assign(new Error("reader denies link"), { code: "EPERM" })
      }
      return link(from, to)
    })
    let resumed: Awaited<ReturnType<typeof session.resume>> | undefined
    let acquiring: Promise<NonNullable<typeof resumed>> | undefined
    const atomicWait = spyOn(Atomics, "wait")
    const sleepSync = spyOn(Bun, "sleepSync")
    try {
      await session.agent.dispose()
      let settled = false
      acquiring = Promise.resolve(
        boundary === "resume"
          ? session.resume(stale)
          : createSession({ ...options, store: stale }).then((next) => next.agent),
      ).finally(() => {
        settled = true
      })
      // Observe early failures while checking the timer; awaiting acquisition below still throws.
      void acquiring.catch(() => {})
      // Keep publication blocked until an unrelated timer runs. Scheduler latency is
      // irrelevant: acquisition must yield and cannot complete while blocked.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(false)
      expect(atomicWait).not.toHaveBeenCalled()
      expect(sleepSync).not.toHaveBeenCalled()
      blocked = false
      resumed = await acquiring
      expect(resumed.messages.map((m) => m.content)).toEqual([
        userMessage("saved").content,
        userMessage("new on disk").content,
      ])
      expect(mock.requests).toHaveLength(0)
    } finally {
      blocked = false
      hook.mockRestore()
      atomicWait.mockRestore()
      sleepSync.mockRestore()
      resumed ??= await acquiring?.catch(() => undefined)
      await resumed?.dispose()
      await session.agent.dispose()
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
    const link = fs.linkSync
    const oldLock = sessionLockFile(store.file)
    let denied = false
    const atomicWait = spyOn(Atomics, "wait")
    const sleepSync = spyOn(Bun, "sleepSync")
    const hook = spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (denied && String(to) !== oldLock && String(to).endsWith(".lock")) {
        throw Object.assign(new Error("transient sharing violation"), { code: "EPERM" })
      }
      return link(from, to)
    })
    const create = SessionStore.create
    const acquire = SessionStore.prototype.withClaim
    let callback: Promise<void> | undefined
    const acquisition = spyOn(SessionStore.prototype, "withClaim").mockImplementation(function <T>(
      this: SessionStore,
      construct: () => T,
      opts?: Parameters<SessionStore["withClaim"]>[1],
    ) {
      denied = true
      callback = new Promise<void>((resolve) => setTimeout(resolve, 0))
      return (acquire<T>).call(this, construct, opts)
    })
    let switching: Promise<unknown> | undefined
    try {
      let target: SessionStore | undefined
      if (command === "resume") {
        target = create({ cwd: dir, dir })
        target.appendMessage(userMessage("destination"))
      }
      const pending =
        command === "resume"
          ? host.control.resume!(target!.id)
          : command === "clear"
            ? host.control.newSession!()
            : host.control.fork!()
      switching = pending
      void pending.catch(() => {})
      // The timer must run before release, without synchronous acquisition sleeps.
      expect(callback).toBeDefined()
      await callback
      expect(atomicWait).not.toHaveBeenCalled()
      expect(sleepSync).not.toHaveBeenCalled()
      expect(host.agent).toBe(old)
      expect(handover).not.toHaveBeenCalled()
      expect(cancel).not.toHaveBeenCalled()
      expect(announcements).toEqual([])
      store.appendDisplay({ type: "display", level: "info", text: "old owner remains usable while waiting" })
      denied = false
      await pending
      expect(host.agent).not.toBe(old)
      expect(handover).toHaveBeenCalledTimes(1)
      expect(announcements).toEqual([`${command === "clear" ? "clear" : command}:${host.agent.sessionId}`])
      expect(host.agent.messages).toHaveLength(command === "clear" ? 0 : 1)
    } finally {
      denied = false
      hook.mockRestore()
      atomicWait.mockRestore()
      sleepSync.mockRestore()
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
  fs.writeFileSync(sessionLockFile(target.file), `${process.pid}\nforeign-holder\n`)
  const old = session.agent
  const host = createCommandHost({ session, cwd: dir })
  const cancel = spyOn(old, "cancelNoticeRetry")
  const handover = spyOn(session.host.backgroundJobs, "handoverRoot")
  const timers = spyOn(globalThis, "setTimeout")
  try {
    await expect(host.control.resume!(target.id)).rejects.toThrow("is open in another Amira process")
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
