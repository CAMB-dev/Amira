import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { SessionWriteGuardError, tryFileLock } from "../src/file-lock.ts"
import { leaseOwner, ownerState } from "../src/file-lock-owner.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"
import { boundedExit, startGateReader } from "./file-lock-reader-fixture.ts"

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-dead-gate-acquire-"))
  const store = SessionStore.create({ cwd: dir, dir })
  store.appendMessage(userMessage("saved"))
  const stale = SessionStore.open(store.file)
  store.appendMessage(userMessage("current disk history"))
  const file = sessionLockFile(store.file)
  const gate = `${file}.lease-gate`
  const metadata = path.join(gate, "owner.json")
  const worker = Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.join(import.meta.dir, "file-lock-worker-preload.ts"),
      path.join(import.meta.dir, "file-lock-worker.ts"),
      file,
      dir,
      "crash-gate",
    ],
    {
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
      ),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  try {
    expect(await boundedExit(worker, "crash gate worker")).toBe(0)
    expect(await new Response(worker.stderr).text()).toBe("")
    const contents = fs.readFileSync(metadata, "utf8")
    const owner: ReturnType<typeof leaseOwner> = JSON.parse(contents)
    expect(owner.pid).toBe(worker.pid)
    expect(ownerState(owner)).toBe("dead")
    return { dir, store: stale, file, gate, metadata, contents, owner, tomb: `${gate}.dead-${owner.nonce}` }
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw error
  } finally {
    if (worker.exitCode === null) worker.kill()
    await boundedExit(worker, "owned crash worker stop")
  }
}

if (process.platform === "win32") {
  test("awaited claim recovers an exited child's gate through a real 100ms reader without blocking", async () => {
    const f = await fixture()
    const mock = createMockDialect([])
    const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
    const { reader, ready, go } = startGateReader(f.metadata, f.dir)
    const waits = spyOn(Atomics, "wait")
    let agent: Agent | undefined
    let pending: Agent | Promise<Agent> | undefined
    try {
      const deadline = performance.now() + 3000
      while (!fs.existsSync(ready)) {
        if (reader.exitCode !== null || performance.now() > deadline)
          throw new Error("reader readiness failed")
        await Bun.sleep(2)
      }
      fs.writeFileSync(go, "go")
      const start = performance.now()
      const callback = new Promise<number>((resolve) =>
        setTimeout(() => resolve(performance.now() - start), 0),
      )
      pending = f.store.withClaim(
        () => new Agent({ ai, model: ai.model("mock/m"), cwd: f.dir, session: f.store }),
      )
      expect(pending).toBeInstanceOf(Promise)
      const zero = await callback
      expect(zero).toBeLessThan(20)
      expect(reader.exitCode).toBeNull()
      expect(fs.readFileSync(f.metadata, "utf8")).toBe(f.contents)
      agent = await pending
      const elapsed = performance.now() - start
      console.log(`Dead gate reader: acquisition ${elapsed.toFixed(2)}ms, zero-delay ${zero.toFixed(2)}ms`)
      expect(elapsed).toBeGreaterThanOrEqual(75)
      expect(elapsed).toBeLessThan(2000)
      expect(await boundedExit(reader, "dead gate reader")).toBe(0)
      expect(await new Response(reader.stderr).text()).toBe("")
      expect(agent.messages).toEqual([userMessage("saved"), userMessage("current disk history")])
      expect(mock.requests).toHaveLength(0)
      expect(waits).not.toHaveBeenCalled()
      expect(fs.readFileSync(path.join(f.tomb, "owner.json"), "utf8")).toBe(f.contents)
      await agent.dispose()
      expect(fs.existsSync(f.file)).toBe(false)
      expect(fs.existsSync(f.gate)).toBe(false)
    } finally {
      fs.writeFileSync(go, "go")
      if (reader.exitCode === null) reader.kill()
      await boundedExit(reader, "owned reader stop")
      if (!agent && pending) agent = await Promise.resolve(pending).catch(() => undefined)
      await agent?.dispose()
      waits.mockRestore()
      fs.rmSync(f.dir, { recursive: true, force: true })
    }
  }, 7000)
}

for (const code of ["EPERM", "EBUSY", "EACCES"]) {
  for (const duration of ["one-shot", "100ms"] as const) {
    test(`dead gate ${duration} ${code} retirement re-proves death and rechecks metadata on every claim`, async () => {
      const f = await fixture()
      const rename = fs.renameSync
      const read = fs.readFileSync
      const probe = spyOn(process, "kill")
      let reads = 0
      let attempts = 0
      let constructed = 0
      const start = performance.now()
      const failure = Object.assign(new Error(`${code}: rename ${f.gate} -> ${f.tomb}`), {
        code,
        path: f.gate,
        dest: f.tomb,
      })
      const reading = spyOn(fs, "readFileSync").mockImplementation(
        new Proxy(read, {
          apply(target, receiver, args) {
            if (String(args[0]) === f.metadata) reads++
            return Reflect.apply(target, receiver, args)
          },
        }),
      )
      const hook = spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (String(from) === f.gate && String(to) === f.tomb) {
          attempts++
          expect(reads).toBe(attempts * 2)
          expect(probe).toHaveBeenCalledTimes(attempts)
          expect(probe).toHaveBeenLastCalledWith(f.owner.pid, 0)
          if (duration === "one-shot" ? attempts === 1 : performance.now() - start < 100) throw failure
        }
        return rename(from, to)
      })
      try {
        const callback = new Promise<number>((resolve) =>
          setTimeout(() => resolve(performance.now() - start), 0),
        )
        const pending = f.store.withClaim(() => {
          constructed++
          return "claimed"
        })
        expect(pending).toBeInstanceOf(Promise)
        expect(await callback).toBeLessThan(20)
        expect(await pending).toBe("claimed")
        expect(constructed).toBe(1)
        expect(attempts).toBeGreaterThanOrEqual(2)
        if (duration === "one-shot") expect(attempts).toBe(2)
        else expect(performance.now() - start).toBeGreaterThanOrEqual(100)
        expect(fs.existsSync(f.file)).toBe(false)
        expect(fs.existsSync(f.gate)).toBe(false)
        expect(fs.readFileSync(path.join(f.tomb, "owner.json"), "utf8")).toBe(f.contents)
      } finally {
        hook.mockRestore()
        reading.mockRestore()
        probe.mockRestore()
        f.store.release()
        fs.rmSync(f.dir, { recursive: true, force: true })
      }
    })
  }

  test(`synchronous tryFileLock preserves dead-retirement ${code} without sleeping or timers`, async () => {
    const f = await fixture()
    const rename = fs.renameSync
    const failure = Object.assign(new Error(`${code}: rename ${f.gate}`), { code, path: f.gate })
    const hook = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === f.gate && String(to) === f.tomb) throw failure
      return rename(from, to)
    })
    const timers = spyOn(globalThis, "setTimeout")
    const waits = spyOn(Atomics, "wait")
    try {
      const start = performance.now()
      let caught: unknown
      try {
        tryFileLock(f.file, 1, undefined, true)
      } catch (error) {
        caught = error
      }
      expect(caught).toBe(failure)
      expect(performance.now() - start).toBeLessThan(20)
      expect(timers).not.toHaveBeenCalled()
      expect(waits).not.toHaveBeenCalled()
      expect(fs.readFileSync(f.metadata, "utf8")).toBe(f.contents)
      expect(fs.existsSync(f.tomb)).toBe(false)
      expect(fs.existsSync(f.file)).toBe(false)
    } finally {
      waits.mockRestore()
      timers.mockRestore()
      hook.mockRestore()
      fs.rmSync(f.dir, { recursive: true, force: true })
    }
  })
}

for (const replacement of [
  "same-pid live",
  "foreign",
  "unknown",
  "corrupt",
  "legacy",
  "nonce during proof",
]) {
  test(`a sharing retry rejects ${replacement} replacement without retiring the wrong gate`, async () => {
    const f = await fixture()
    const rename = fs.renameSync
    const probe = process.kill
    let attempts = 0
    let proofs = 0
    let constructed = false
    const next = { ...f.owner, nonce: leaseOwner().nonce }
    if (replacement === "same-pid live") next.pid = process.pid
    if (replacement === "foreign") next.host = "foreign-host"
    if (replacement === "unknown") next.host = null
    const contents =
      replacement === "corrupt"
        ? "invalid"
        : JSON.stringify({
            ...next,
            ...(replacement === "legacy" ? { v: 1 } : {}),
          })
    const proof = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === f.owner.pid && signal === 0) {
        proofs++
        if (replacement === "nonce during proof" && proofs === 2) fs.writeFileSync(f.metadata, contents)
      }
      return probe(pid, signal)
    })
    const hook = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === f.gate && String(to).startsWith(`${f.gate}.dead-`)) {
        attempts++
        if (replacement !== "nonce during proof") fs.writeFileSync(f.metadata, contents)
        throw Object.assign(new Error(`EPERM: rename ${f.gate}`), { code: "EPERM", path: f.gate })
      }
      return rename(from, to)
    })
    const timers = spyOn(globalThis, "setTimeout")
    try {
      const start = performance.now()
      await expect(
        Promise.resolve().then(() =>
          f.store.withClaim(() => {
            constructed = true
          }),
        ),
      ).rejects.toThrow(SessionWriteGuardError)
      expect(performance.now() - start).toBeLessThan(100)
      expect(constructed).toBe(false)
      expect(attempts).toBe(1)
      expect(timers).toHaveBeenCalledTimes(1)
      expect(fs.readFileSync(f.metadata, "utf8")).toBe(contents)
      expect(fs.readdirSync(f.dir).filter((name) => name.includes(".dead-"))).toEqual([])
      expect(fs.existsSync(f.file)).toBe(false)
      if (replacement === "nonce during proof") expect(proofs).toBe(2)
    } finally {
      timers.mockRestore()
      hook.mockRestore()
      proof.mockRestore()
      fs.rmSync(f.dir, { recursive: true, force: true })
    }
  })
}

for (const kind of ["live", "foreign", "unknown", "corrupt", "legacy"]) {
  for (const unreadable of [false, true]) {
    test(`${kind} gate ${unreadable ? "read sharing error" : "metadata"} rejects immediately with safe guidance`, async () => {
      const f = await fixture()
      const contents =
        kind === "corrupt"
          ? "invalid"
          : JSON.stringify({
              ...f.owner,
              ...(kind === "live" ? { pid: process.pid } : {}),
              ...(kind === "foreign" ? { host: "foreign-host" } : {}),
              ...(kind === "unknown" ? { host: null } : {}),
              ...(kind === "legacy" ? { v: 1 } : {}),
            })
      fs.writeFileSync(f.metadata, contents)
      const read = fs.readFileSync
      const hook = spyOn(fs, "readFileSync").mockImplementation(
        new Proxy(read, {
          apply(target, receiver, args) {
            if (unreadable && String(args[0]) === f.metadata)
              throw Object.assign(new Error("metadata reader"), { code: "EPERM" })
            return Reflect.apply(target, receiver, args)
          },
        }),
      )
      const timers = spyOn(globalThis, "setTimeout")
      const start = performance.now()
      try {
        expect(() => f.store.withClaim(() => "never claimed")).toThrow(
          `session stale-write guard is busy or unverifiable: ${f.gate}; retry, or remove this directory manually only after confirming no Amira process is running on any host using these session files`,
        )
        expect(performance.now() - start).toBeLessThan(20)
        expect(timers).not.toHaveBeenCalled()
        expect(fs.existsSync(f.file)).toBe(false)
        expect(fs.existsSync(f.tomb)).toBe(false)
        hook.mockRestore()
        expect(fs.readFileSync(f.metadata, "utf8")).toBe(contents)
      } finally {
        timers.mockRestore()
        hook.mockRestore()
        fs.rmSync(f.dir, { recursive: true, force: true })
      }
    })
  }
}

test("a live foreign-process gate rejects without scheduling acquisition even when its reader is denied", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-live-gate-acquire-"))
  const store = SessionStore.create({ cwd: dir, dir })
  store.appendMessage(userMessage("saved"))
  const file = sessionLockFile(store.file)
  const gate = `${file}.lease-gate`
  const metadata = path.join(gate, "owner.json")
  const worker = Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.join(import.meta.dir, "file-lock-worker-preload.ts"),
      path.join(import.meta.dir, "file-lock-worker.ts"),
      file,
      dir,
      "session-pause-gate-create",
    ],
    {
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
      ),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  try {
    const deadline = performance.now() + 3000
    while (!fs.existsSync(path.join(dir, "paused"))) {
      if (worker.exitCode !== null || performance.now() > deadline)
        throw new Error("live gate readiness failed")
      await Bun.sleep(2)
    }
    const contents = fs.readFileSync(metadata, "utf8")
    const owner = JSON.parse(contents)
    expect(owner.pid).toBe(worker.pid)
    expect(ownerState(owner)).toBe("live")
    const read = fs.readFileSync
    for (const unreadable of [false, true]) {
      const hook = spyOn(fs, "readFileSync").mockImplementation(
        new Proxy(read, {
          apply(target, receiver, args) {
            if (unreadable && String(args[0]) === metadata)
              throw Object.assign(new Error("reader denied"), { code: "EACCES" })
            return Reflect.apply(target, receiver, args)
          },
        }),
      )
      const timers = spyOn(globalThis, "setTimeout")
      try {
        const start = performance.now()
        expect(() => store.withClaim(() => "never claimed")).toThrow(SessionWriteGuardError)
        expect(performance.now() - start).toBeLessThan(20)
        expect(timers).not.toHaveBeenCalled()
        expect(fs.existsSync(file)).toBe(false)
      } finally {
        timers.mockRestore()
        hook.mockRestore()
      }
    }
    expect(fs.readFileSync(metadata, "utf8")).toBe(contents)
    expect(worker.exitCode).toBeNull()
  } finally {
    if (worker.exitCode === null) worker.kill()
    await boundedExit(worker, "owned live gate worker stop")
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

for (const code of ["EEXIST", "ENOTEMPTY", "EPERM", "EBUSY", "EACCES", "actual OS"]) {
  test(`dead gate ${code} tombstone collision fails closed without an acquisition timer`, async () => {
    const f = await fixture()
    fs.mkdirSync(f.tomb)
    fs.writeFileSync(path.join(f.tomb, "owner.json"), "retained nonce fence")
    const rename = fs.renameSync
    const hook = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === f.gate && String(to) === f.tomb && code !== "actual OS")
        throw Object.assign(new Error("tombstone collision"), { code })
      return rename(from, to)
    })
    const timers = spyOn(globalThis, "setTimeout")
    try {
      expect(() => f.store.withClaim(() => "never claimed")).toThrow(SessionWriteGuardError)
      expect(timers).not.toHaveBeenCalled()
      expect(fs.readFileSync(f.metadata, "utf8")).toBe(f.contents)
      expect(fs.readFileSync(path.join(f.tomb, "owner.json"), "utf8")).toBe("retained nonce fence")
      expect(fs.existsSync(f.file)).toBe(false)
    } finally {
      timers.mockRestore()
      hook.mockRestore()
      fs.rmSync(f.dir, { recursive: true, force: true })
    }
  })
}

for (const mode of ["deadline", "abort"] as const) {
  test(`permanent dead-gate sharing preserves original path and ${mode} budget`, async () => {
    const f = await fixture()
    const rename = fs.renameSync
    const failure = Object.assign(new Error(`EBUSY: rename ${f.gate} -> ${f.tomb}`), {
      code: "EBUSY",
      path: f.gate,
      dest: f.tomb,
    })
    let attempts = 0
    const hook = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === f.gate && String(to) === f.tomb) {
        attempts++
        throw failure
      }
      return rename(from, to)
    })
    const clock = spyOn(Date, "now").mockReturnValue(123)
    const controller = new AbortController()
    const reason = new Error("cancel dead gate acquisition")
    let constructed = false
    try {
      const start = performance.now()
      const pending = f.store.withClaim(
        () => {
          constructed = true
        },
        { signal: controller.signal },
      )
      expect(pending).toBeInstanceOf(Promise)
      if (mode === "abort") controller.abort(reason)
      await expect(Promise.resolve(pending)).rejects.toBe(mode === "abort" ? reason : failure)
      if (mode === "deadline") {
        const elapsed = performance.now() - start
        console.log(`Dead gate permanent sharing: ${elapsed.toFixed(2)}ms`)
        expect(elapsed).toBeGreaterThanOrEqual(1950)
        expect(elapsed).toBeLessThan(2200)
        expect(attempts).toBeGreaterThan(1)
      }
      const settled = attempts
      await Bun.sleep(25)
      expect(attempts).toBe(settled)
      expect(constructed).toBe(false)
      expect(fs.readFileSync(f.metadata, "utf8")).toBe(f.contents)
      expect(fs.existsSync(f.file)).toBe(false)
      expect(fs.existsSync(f.tomb)).toBe(false)
    } finally {
      clock.mockRestore()
      hook.mockRestore()
      fs.rmSync(f.dir, { recursive: true, force: true })
    }
  }, 4000)
}
