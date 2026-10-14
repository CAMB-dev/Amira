import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import { Agent, type AgentOptions } from "../src/agent.ts"
import { pendingOwnedLockCleanup, SessionWriteGuardError, tryFileLock } from "../src/file-lock.ts"
import { takeFilesystemGate } from "../src/file-lock-gate.ts"
import { leaseOwner } from "../src/file-lock-owner.ts"
import { SessionInUseError, SessionStore, sessionLockFile } from "../src/session-store.ts"
import { finishWorker, startWorker, waitFor } from "./session-ownership-worker.ts"

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-acquire-core-"))
  const store = SessionStore.create({ cwd: dir, dir })
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const options: AgentOptions = { ai, model: ai.model("mock/m"), cwd: dir, session: store }
  const file = sessionLockFile(store.file)
  return { dir, store, file, options }
}

for (const code of ["EPERM", "EBUSY", "EACCES"]) {
  test(`awaited claim retries raw ${code} publication errors without blocking`, async () => {
    const { dir, store, file } = fixture()
    const link = fs.linkSync
    let denied = true
    const hook = spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (denied && String(to) === file) throw Object.assign(new Error("sharing violation"), { code })
      return link(from, to)
    })
    let attempts = 0
    let release: ReturnType<typeof setTimeout> | undefined
    try {
      const pending = store.withClaim(() => {
        attempts++
        return "ready"
      })
      release = setTimeout(() => {
        denied = false
      }, 40)
      expect(await pending).toBe("ready")
      expect(attempts).toBe(1)
      expect(fs.existsSync(file)).toBe(false)
    } finally {
      clearTimeout(release)
      hook.mockRestore()
      store.release()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

for (const kind of [
  "foreign gate",
  "corrupt gate",
  "legacy lease",
  "corrupt lease",
  "foreign lease",
  "live lease",
]) {
  test(`awaited claim fails ${kind} immediately, without scheduling a wait`, async () => {
    const { dir, store, file } = fixture()
    const foreign = { ...leaseOwner(), host: "different-host" }
    const gate = `${file}.lease-gate`
    fs.mkdirSync(dir, { recursive: true })
    if (kind.endsWith("gate")) {
      fs.mkdirSync(gate)
      fs.writeFileSync(
        path.join(gate, "owner.json"),
        kind === "foreign gate" ? JSON.stringify(foreign) : "invalid",
      )
    } else {
      const owner = kind === "foreign lease" ? foreign : leaseOwner()
      fs.writeFileSync(
        file,
        kind === "legacy lease"
          ? `${process.pid}\n`
          : kind === "corrupt lease"
            ? "invalid"
            : `${owner.pid}\n${owner.nonce}\n${JSON.stringify(owner)}\n`,
      )
    }
    const timers = spyOn(globalThis, "setTimeout")
    const atomicWait = spyOn(Atomics, "wait")
    const sleepSync = spyOn(Bun, "sleepSync")
    let constructed = false
    try {
      const errorType = kind === "live lease" ? SessionInUseError : SessionWriteGuardError
      expect(() =>
        store.withClaim(() => {
          constructed = true
        }),
      ).toThrow(errorType)
      expect(constructed).toBe(false)
      // Reject scheduled and synchronous sleeps without relying on wall-clock timing.
      expect(timers).not.toHaveBeenCalled()
      expect(atomicWait).not.toHaveBeenCalled()
      expect(sleepSync).not.toHaveBeenCalled()
    } finally {
      timers.mockRestore()
      atomicWait.mockRestore()
      sleepSync.mockRestore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("awaited acquisition fails a verified live foreign-process lease without sleeping", async () => {
  const { dir, store, file } = fixture()
  store.appendMessage(userMessage("saved"))
  const worker = startWorker(dir, store.file, "hold")
  try {
    await waitFor(path.join(dir, "claimed"), worker)
    expect(worker.exitCode).toBeNull()
    expect(fs.readFileSync(file, "utf8").split("\n")[0]).toBe(String(worker.pid))
    const timers = spyOn(globalThis, "setTimeout")
    const atomicWait = spyOn(Atomics, "wait")
    const sleepSync = spyOn(Bun, "sleepSync")
    try {
      const pending = Promise.resolve().then(() => store.withClaim(() => "never constructed"))
      await expect(pending).rejects.toThrow(SessionInUseError)
      await expect(pending).rejects.toThrow(`pid ${worker.pid}`)
      // Reject scheduled and synchronous sleeps without relying on wall-clock timing.
      expect(timers).not.toHaveBeenCalled()
      expect(atomicWait).not.toHaveBeenCalled()
      expect(sleepSync).not.toHaveBeenCalled()
    } finally {
      timers.mockRestore()
      atomicWait.mockRestore()
      sleepSync.mockRestore()
    }
  } finally {
    fs.writeFileSync(path.join(dir, "release"), "release")
    await finishWorker(worker, dir)
  }
})

test("an own pending lease does not make a foreign blocking gate retryable", () => {
  const { dir, store, file } = fixture()
  store.claim()
  const remove = fs.rmSync
  const hook = spyOn(fs, "rmSync").mockImplementation((target, options) => {
    if (String(target) === file) throw Object.assign(new Error("lease reader"), { code: "EPERM" })
    return remove(target, options)
  })
  store.release()
  hook.mockRestore()
  expect(pendingOwnedLockCleanup(file)).toBe(true)
  const gate = `${file}.lease-gate`
  fs.mkdirSync(gate)
  const contents = JSON.stringify({ ...leaseOwner(), host: "foreign", pid: process.pid })
  fs.writeFileSync(path.join(gate, "owner.json"), contents)
  const timers = spyOn(globalThis, "setTimeout")
  try {
    expect(() => store.withClaim(() => "must not construct")).toThrow(SessionWriteGuardError)
    expect(timers).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(gate, "owner.json"), "utf8")).toBe(contents)
  } finally {
    timers.mockRestore()
    fs.rmSync(gate, { recursive: true, force: true })
    store.claim()
    store.release()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

for (const overshoot of [0, 249]) {
  test(`two-second acquisition deadline is monotonic and retains the original path diagnostic (${overshoot}ms scheduler overshoot)`, async () => {
    const { dir, store, file } = fixture()
    const link = fs.linkSync
    const failure = Object.assign(new Error(`EPERM: link ${file}`), { code: "EPERM", path: file })
    const later = Object.assign(new Error("later sharing failure"), { code: "EACCES" })
    let attempts = 0
    const hook = spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (String(to) === file) throw ++attempts === 1 ? failure : later
      return link(from, to)
    })
    const clock = spyOn(Date, "now").mockReturnValue(123)
    let now = 5000
    const monotonic = spyOn(performance, "now").mockImplementation(() => now)
    let scheduled: (() => void) | undefined
    const delays: number[] = []
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
      scheduled = callback
      delays.push(ms)
      return 1
    }) as unknown as typeof setTimeout)
    let constructed = false
    try {
      const pending = Promise.resolve(
        store.withClaim(() => {
          constructed = true
        }),
      )
      const rejected = pending.catch((error) => error)
      // The initial attempt and 199 retries precede the fixed two-second deadline.
      for (let tick = 0; tick < 199; tick++) {
        now += 10
        const wake = scheduled!
        scheduled = undefined
        wake()
        await Promise.resolve()
      }
      expect(now).toBe(6990)
      expect(attempts).toBe(200)
      expect(delays).toEqual(Array(200).fill(10))
      // A timer may wake late; expiry must still prevent even one additional claim.
      now += 10 + overshoot
      const wake = scheduled!
      scheduled = undefined
      wake()
      expect(await rejected).toBe(failure)
      expect(now).toBe(7000 + overshoot)
      expect(attempts).toBe(200)
      expect(timers).toHaveBeenCalledTimes(200)
      expect(scheduled).toBeUndefined()
      expect(constructed).toBe(false)
      expect(fs.existsSync(file)).toBe(false)
    } finally {
      timers.mockRestore()
      monotonic.mockRestore()
      clock.mockRestore()
      hook.mockRestore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("abort clears its wait timer/listener and never claims after cancellation", async () => {
  const { dir, store, file } = fixture()
  const link = fs.linkSync
  const hook = spyOn(fs, "linkSync").mockImplementation((from, to) => {
    if (String(to) === file) throw Object.assign(new Error("sharing"), { code: "EACCES" })
    return link(from, to)
  })
  const controller = new AbortController()
  const added = spyOn(controller.signal, "addEventListener")
  const removed = spyOn(controller.signal, "removeEventListener")
  const clear = spyOn(globalThis, "clearTimeout")
  const timers = spyOn(globalThis, "setTimeout")
  let constructions = 0
  const reason = new Error("cancel acquisition")
  try {
    const pending = store.withClaim(
      () => {
        constructions++
      },
      { signal: controller.signal },
    )
    const waitTimer = timers.mock.results.at(-1)?.value
    expect(waitTimer).toBeDefined()
    controller.abort(reason)
    await expect(Promise.resolve(pending)).rejects.toBe(reason)
    expect(clear).toHaveBeenCalledWith(waitTimer)
    expect(added).toHaveBeenCalledTimes(1)
    expect(removed).toHaveBeenCalledTimes(1)
    expect(constructions).toBe(0)
    hook.mockRestore()
    const noLateClaim = spyOn(fs, "linkSync")
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(noLateClaim).not.toHaveBeenCalled()
    noLateClaim.mockRestore()
    const available = tryFileLock(file, 1, undefined, true)
    expect(available).toBeDefined()
    available!.release()
  } finally {
    hook.mockRestore()
    timers.mockRestore()
    clear.mockRestore()
    added.mockRestore()
    removed.mockRestore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

for (const view of ["same", "different", "unclaimed"] as const) {
  test(`constructor failure releases only its temporary and constructor refs (${view})`, async () => {
    const { dir, store, file, options } = fixture()
    store.appendMessage(userMessage("saved"))
    const owner = view === "unclaimed" ? undefined : new Agent(options)
    const target = view === "different" ? SessionStore.open(store.file) : store
    const failure = Object.assign(new Error("constructor EPERM is not acquisition"), { code: "EPERM" })
    let constructions = 0
    try {
      expect(() =>
        target.withClaim(() => {
          constructions++
          return new Agent({
            ...options,
            session: target,
            get fileRewindSettings(): AgentOptions["fileRewindSettings"] {
              throw failure
            },
          })
        }),
      ).toThrow(failure)
      expect(constructions).toBe(1)
      expect(fs.existsSync(file)).toBe(!!owner)
      await owner?.dispose()
      expect(fs.existsSync(file)).toBe(false)
      const available = tryFileLock(file, 1, undefined, true)
      expect(available).toBeDefined()
      available!.release()
    } finally {
      await owner?.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("a replacement gate with the same PID is not the exact release-requested gate", () => {
  const { dir, store, file } = fixture()
  const gate = `${file}.lease-gate`
  const unlock = takeFilesystemGate(file)!
  expect(unlock).toBeDefined()
  const rename = fs.renameSync
  const hook = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(from) === gate && String(to).includes(".retired-"))
      throw Object.assign(new Error("reader"), { code: "EPERM" })
    return rename(from, to)
  })
  unlock()
  expect(pendingOwnedLockCleanup(gate)).toBe(true)
  hook.mockRestore()
  rename(gate, `${gate}.displaced`)
  fs.mkdirSync(gate)
  const replacement = JSON.stringify(leaseOwner())
  fs.writeFileSync(path.join(gate, "owner.json"), replacement)
  const timers = spyOn(globalThis, "setTimeout")
  try {
    expect(pendingOwnedLockCleanup(gate)).toBe(false)
    expect(() => store.withClaim(() => "not constructed")).toThrow(SessionWriteGuardError)
    expect(timers).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(gate, "owner.json"), "utf8")).toBe(replacement)
  } finally {
    timers.mockRestore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

for (const existingOwner of [false, true]) {
  test(`cancellation after temporary claim releases exactly that ref (existing owner ${existingOwner})`, async () => {
    const { dir, store, file, options } = fixture()
    const owner = existingOwner ? new Agent(options) : undefined
    const controller = new AbortController()
    const reason = new Error("cancelled after claim")
    const claim = store.claim
    const hook = spyOn(store, "claim").mockImplementation(() => {
      const claimed = claim.call(store)
      controller.abort(reason)
      return claimed
    })
    let constructed = false
    try {
      expect(() =>
        store.withClaim(
          () => {
            constructed = true
          },
          { signal: controller.signal },
        ),
      ).toThrow(reason)
      expect(constructed).toBe(false)
      expect(fs.existsSync(file)).toBe(existingOwner)
      hook.mockRestore()
      await owner?.dispose()
      expect(fs.existsSync(file)).toBe(false)
    } finally {
      hook.mockRestore()
      await owner?.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("already-aborted acquisition neither claims nor schedules timers", () => {
  const { dir, store, file } = fixture()
  const controller = new AbortController()
  const reason = new Error("already cancelled")
  controller.abort(reason)
  const claim = spyOn(store, "claim")
  const timers = spyOn(globalThis, "setTimeout")
  try {
    expect(() => store.withClaim(() => "not constructed", { signal: controller.signal })).toThrow(reason)
    expect(claim).not.toHaveBeenCalled()
    expect(timers).not.toHaveBeenCalled()
    expect(fs.existsSync(file)).toBe(false)
  } finally {
    claim.mockRestore()
    timers.mockRestore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("refresh/header conflict is not retried and releases only the failed claim", () => {
  const { dir, store, file } = fixture()
  store.appendMessage(userMessage("saved"))
  const raw = fs.readFileSync(store.file, "utf8")
  fs.writeFileSync(store.file, raw.replace(store.id, "other-session"))
  let constructions = 0
  const timers = spyOn(globalThis, "setTimeout")
  try {
    expect(() =>
      store.withClaim(() => {
        constructions++
      }),
    ).toThrow("session file belongs to a different session")
    expect(timers).not.toHaveBeenCalled()
    expect(constructions).toBe(0)
    expect(fs.existsSync(file)).toBe(false)
  } finally {
    timers.mockRestore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
