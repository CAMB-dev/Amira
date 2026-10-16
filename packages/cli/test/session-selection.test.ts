import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep, userMessage } from "@amira/ai"
import { SessionStore, sessionLockFile } from "@amira/core"
import { runInteractive } from "@amira/tui"
import { FakeTerminal } from "@amira/tui-kit"
import commandsExtension from "../../../extensions/commands/src/index.ts"
import { SPAWN_TEST_TIMEOUT_MS, waitForSpawnCondition } from "../../../scripts/spawn-test.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { createCommandHost } from "../src/control.ts"
import { createSession } from "../src/session.ts"

async function until(check: () => boolean) {
  const deadline = performance.now() + 3000
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("selection did not reach its barrier")
    await Bun.sleep(2)
  }
}

async function fixture(steps: MockStep[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-session-selection-"))
  const mock = createMockDialect(steps)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const store = SessionStore.create({ cwd: dir, dir })
  store.appendMessage(userMessage("source"))
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
  const target = (text: string) => {
    const next = SessionStore.create({ cwd: dir, dir })
    next.appendMessage(userMessage(text))
    return next
  }
  return { dir, store, session, host, announcements, target }
}

function blockClaims(stores: SessionStore[]) {
  const blocked = new Set(stores.map((store) => sessionLockFile(store.file)))
  const attempts = new Map<string, number>()
  const link = fs.linkSync
  const hook = spyOn(fs, "linkSync").mockImplementation((from, to) => {
    if (blocked.has(String(to))) {
      attempts.set(String(to), (attempts.get(String(to)) ?? 0) + 1)
      throw Object.assign(new Error("temporary acquisition sharing violation"), { code: "EPERM" })
    }
    return link(from, to)
  })
  return {
    attempts: (store: SessionStore) => attempts.get(sessionLockFile(store.file)) ?? 0,
    release: (store: SessionStore) => blocked.delete(sessionLockFile(store.file)),
    dispose: () => hook.mockRestore(),
  }
}

test(
  "Ctrl+C cancels an actual TUI resume without handing over A's lease, jobs or notices",
  async () => {
    const f = await fixture()
    const old = f.host.agent
    const target = f.target("B")
    const claims = blockClaims([target])
    const handover = spyOn(f.session.host.backgroundJobs, "handoverRoot")
    const terminal = new FakeTerminal(100, 30)
    const screen = new VirtualScreen(100, 30)
    const write = terminal.write.bind(terminal)
    terminal.write = (text) => {
      write(text)
      screen.write(text)
    }
    const text = () => [...screen.scrollback, ...screen.lines].join("\n")
    let ready = false
    const exited = runInteractive({
      agent: old,
      commands: f.host,
      status: f.session.host.status,
      ui: f.session.host.ui,
      terminal,
      env: {},
      settings: { images: "off" },
      setup: async () => ({
        capabilities: {
          win32InputMode: false,
          kittyKeyboard: true,
          synchronizedOutput: false,
          shiftEnter: true,
        },
        leftoverInput: "",
      }),
      onReady: () => {
        old.start("startup")
        ready = true
      },
    })
    let settled = false
    void exited.then(
      () => (settled = true),
      () => (settled = true),
    )
    const notice = old.expectNotice()
    const job = old.backgroundJobs!.start({
      command: "selection-owned job",
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: f.dir,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
      ),
    })
    try {
      await until(() => ready && old.backgroundJobs!.get(job.id)?.status === "running")
      terminal.send(`/resume ${target.id}\r`)
      await until(() => claims.attempts(target) > 0)
      terminal.send("\x03")
      terminal.send("still-responsive")
      await until(() => text().includes("cancelled") && text().includes("still-responsive"))
      const attempts = claims.attempts(target)
      claims.release(target)
      await Bun.sleep(100)
      expect(claims.attempts(target)).toBe(attempts)
      expect(f.host.agent).toBe(old)
      expect(handover).not.toHaveBeenCalled()
      expect(f.announcements).toEqual([])
      expect(fs.existsSync(sessionLockFile(f.store.file))).toBe(true)
      expect(fs.existsSync(sessionLockFile(target.file))).toBe(false)
      expect(old.backgroundJobs!.get(job.id)?.status).toBe("running")
      notice.deliver(userMessage("owned completion"), { wake: false })
      expect(old.takeNotices()).toEqual([userMessage("owned completion")])
      f.store.appendDisplay({ type: "display", level: "info", text: "still owned" })
    } finally {
      claims.dispose()
      handover.mockRestore()
      terminal.send("\x03\x03\x03")
      try {
        await waitForSpawnCondition("selection TUI shutdown", () => settled)
        await exited
      } finally {
        await f.session.host.backgroundJobs.stop(job.id, 0)
        await waitForSpawnCondition(
          "selection job cleanup",
          () => !["starting", "running"].includes(f.session.host.backgroundJobs.get(job.id)?.status ?? ""),
        )
        await f.host.agent.dispose()
        f.session.host.unloadAll()
        fs.rmSync(f.dir, { recursive: true, force: true })
      }
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test("pending C supersedes pending B even when B becomes available first", async () => {
  const f = await fixture()
  const old = f.host.agent
  const b = f.target("B")
  const c = f.target("C")
  const claims = blockClaims([b, c])
  const handover = spyOn(f.session.host.backgroundJobs, "handoverRoot")
  const dispose = spyOn(old, "dispose")
  const notice = old.expectNotice()
  const bResult = f.host.run(`/resume ${b.id}`, { frontend: "rpc" })
  let cResult: ReturnType<typeof f.host.run> | undefined
  try {
    await until(() => claims.attempts(b) > 0)
    cResult = f.host.run(`/resume ${c.id}`, { frontend: "rpc" })
    await until(() => claims.attempts(c) > 0)
    expect(await bResult).toMatchObject({ ok: false, error: "cancelled" })
    claims.release(b)
    await Bun.sleep(100)
    expect(f.host.agent).toBe(old)
    expect(fs.existsSync(sessionLockFile(b.file))).toBe(false)
    expect(fs.existsSync(sessionLockFile(f.store.file))).toBe(true)
    expect(handover).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
    claims.release(c)
    expect(await cResult).toMatchObject({ ok: true })
    expect(f.host.agent.sessionId).toBe(c.id)
    expect(handover).toHaveBeenCalledTimes(1)
    expect(handover).toHaveBeenCalledWith(old.sessionId, c.id)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(f.announcements).toEqual([c.id])
    expect(fs.existsSync(sessionLockFile(b.file))).toBe(false)
    expect(fs.existsSync(sessionLockFile(c.file))).toBe(true)
    notice.deliver(userMessage("latest completion"), { wake: false })
    expect(f.host.agent.takeNotices()).toEqual([userMessage("latest completion")])
    expect(old.takeNotices()).toEqual([])
  } finally {
    claims.dispose()
    await bResult
    await cResult
    dispose.mockRestore()
    handover.mockRestore()
    await f.host.agent.dispose()
    f.session.host.unloadAll()
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

for (const command of ["clear", "new", "reset", "fork", "rewind 1 --yes"] as const) {
  test(`/${command} supersedes a pending resume and forwards its command signal`, async () => {
    const f = await fixture()
    const old = f.host.agent
    const b = f.target("B")
    const claims = blockClaims([b])
    const key = command.startsWith("rewind") ? "rewind" : command === "fork" ? "fork" : "newSession"
    const control = spyOn(f.host.control, key)
    const signal = new AbortController().signal
    const pending = f.host.run(`/resume ${b.id}`, { frontend: "rpc" })
    try {
      await until(() => claims.attempts(b) > 0)
      expect(await f.host.run(`/${command}`, { frontend: "rpc", signal })).toMatchObject({ ok: true })
      expect(await pending).toMatchObject({ ok: false, error: "cancelled" })
      expect(control).toHaveBeenCalledTimes(1)
      const args = control.mock.calls[0]!
      expect(args.at(-1)).toMatchObject({ signal })
      expect(f.host.agent).not.toBe(old)
      expect(f.announcements).toEqual([f.host.agent.sessionId])
      expect(fs.existsSync(sessionLockFile(b.file))).toBe(false)
      expect(fs.existsSync(sessionLockFile(f.host.agent.session!.file))).toBe(true)
      if (command.startsWith("rewind")) {
        expect(f.host.agent.sessionId).toBe(old.sessionId)
        expect(f.host.agent.messages).toHaveLength(0)
      }
      if (command === "fork") expect(f.host.agent.messages).toEqual(old.messages)
    } finally {
      claims.dispose()
      control.mockRestore()
      await pending
      await f.host.agent.dispose()
      f.session.host.unloadAll()
      fs.rmSync(f.dir, { recursive: true, force: true })
    }
  })
}

for (const command of ["resume", "newSession", "fork", "rewind"] as const) {
  test(`pre-aborted ${command} touches no claims, scopes or stored history`, async () => {
    const f = await fixture()
    const old = f.host.agent
    const b = f.target("B")
    const abort = new AbortController()
    abort.abort(new Error("caller-specific reason"))
    const claim = spyOn(SessionStore.prototype, "claim")
    const create = spyOn(SessionStore, "create")
    const handover = spyOn(f.session.host.backgroundJobs, "handoverRoot")
    const before = fs.readFileSync(f.store.file, "utf8")
    try {
      const result =
        command === "resume"
          ? f.host.control.resume(b.id, { signal: abort.signal })
          : command === "newSession"
            ? f.host.control.newSession({ signal: abort.signal })
            : command === "fork"
              ? f.host.control.fork!(undefined, { signal: abort.signal })
              : f.host.control.rewind!(0, { restoreFiles: false, signal: abort.signal })
      await expect(result).rejects.toThrow(/^cancelled$/)
      expect(claim).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      expect(handover).not.toHaveBeenCalled()
      expect(f.host.agent).toBe(old)
      expect(fs.readFileSync(f.store.file, "utf8")).toBe(before)
      expect(fs.existsSync(sessionLockFile(f.store.file))).toBe(true)
      expect(fs.existsSync(sessionLockFile(b.file))).toBe(false)
    } finally {
      claim.mockRestore()
      create.mockRestore()
      handover.mockRestore()
      await old.dispose()
      f.session.host.unloadAll()
      fs.rmSync(f.dir, { recursive: true, force: true })
    }
  })
}

test("cancellation after a temporary claim releases it before constructing or handing over", async () => {
  const f = await fixture([{ text: "child ready" }])
  const old = f.host.agent
  const child = f.session.tree.spawn(old, { prompt: "keep alive", persistent: true })
  await until(() => child.state === "idle")
  const b = f.target("B")
  const abort = new AbortController()
  const original = SessionStore.prototype.claim
  const claim = spyOn(SessionStore.prototype, "claim").mockImplementation(function (this: SessionStore) {
    const claimed = original.call(this)
    if (this.id === b.id) abort.abort(new Error("caller-specific reason"))
    return claimed
  })
  const handover = spyOn(f.session.host.backgroundJobs, "handoverRoot")
  const dispose = spyOn(old, "dispose")
  const notice = old.expectNotice()
  try {
    await expect(f.host.control.resume(b.id, { signal: abort.signal })).rejects.toThrow(/^cancelled$/)
    expect(f.host.agent).toBe(old)
    expect(handover).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
    expect(child.state).toBe("idle")
    expect(f.session.tree.children).toHaveLength(1)
    expect(fs.existsSync(sessionLockFile(f.store.file))).toBe(true)
    expect(fs.existsSync(sessionLockFile(b.file))).toBe(false)
    notice.deliver(userMessage("original owner"), { wake: false })
    expect(old.takeNotices()).toEqual([userMessage("original owner")])
  } finally {
    claim.mockRestore()
    handover.mockRestore()
    dispose.mockRestore()
    await old.dispose()
    f.session.host.unloadAll()
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

for (const outcome of ["success", "cancel", "superseded", "timeout", "foreign"] as const) {
  test(`selection detaches the caller's abort listener on ${outcome}`, async () => {
    const f = await fixture()
    const b = f.target("B")
    const abort = new AbortController()
    const add = spyOn(abort.signal, "addEventListener")
    const remove = spyOn(abort.signal, "removeEventListener")
    const claims = ["cancel", "superseded", "timeout"].includes(outcome) ? blockClaims([b]) : undefined
    if (outcome === "foreign") {
      const gate = `${sessionLockFile(b.file)}.lease-gate`
      fs.mkdirSync(gate)
      fs.writeFileSync(path.join(gate, "owner.json"), "unverifiable foreign gate")
    }
    const timers = spyOn(globalThis, "setTimeout")
    try {
      const result = f.host.control.resume(b.id, { signal: abort.signal })
      if (outcome === "cancel") {
        abort.abort()
        await expect(result).rejects.toThrow(/^cancelled$/)
      } else if (outcome === "superseded") {
        const rejected = result.catch((error: unknown) => error)
        await f.host.control.newSession()
        expect(await rejected).toEqual(new Error("cancelled"))
      } else if (outcome === "timeout") {
        await expect(result).rejects.toThrow("temporary acquisition sharing violation")
        expect(fs.existsSync(sessionLockFile(b.file))).toBe(false)
      } else if (outcome === "foreign") {
        await expect(result).rejects.toThrow("busy or unverifiable")
        expect(timers).not.toHaveBeenCalled()
      } else await result
      expect(add).toHaveBeenCalledTimes(1)
      expect(remove).toHaveBeenCalledTimes(1)
      expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1])
    } finally {
      timers.mockRestore()
      claims?.dispose()
      add.mockRestore()
      remove.mockRestore()
      await f.host.agent.dispose()
      f.session.host.unloadAll()
      fs.rmSync(f.dir, { recursive: true, force: true })
    }
  })
}

test("a fork queued during committed B's disposal reads B, while a cancelled queued C touches nothing", async () => {
  const f = await fixture()
  const old = f.host.agent
  const b = f.target("B history")
  const c = f.target("C")
  let finish!: () => void
  const barrier = new Promise<void>((resolve) => {
    finish = resolve
  })
  const original = old.dispose
  const dispose = spyOn(old, "dispose").mockImplementation(async (reason) => {
    await barrier
    await original.call(old, reason)
  })
  const handover = spyOn(f.session.host.backgroundJobs, "handoverRoot")
  const caller = new AbortController()
  const first = f.host.control.resume(b.id, { signal: caller.signal })
  let fork: Promise<void> | undefined
  try {
    await until(() => dispose.mock.calls.length === 1)
    expect(f.host.agent).toBe(old)
    expect(fs.existsSync(sessionLockFile(b.file))).toBe(true)
    const claim = spyOn(SessionStore.prototype, "claim")
    const create = spyOn(SessionStore, "create")
    const queued = new AbortController()
    try {
      const cancelled = f.host.control.resume(c.id, { signal: queued.signal })
      queued.abort()
      await expect(cancelled).rejects.toThrow(/^cancelled$/)
      expect(claim).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      expect(handover).toHaveBeenCalledTimes(1)
      expect(fs.existsSync(sessionLockFile(c.file))).toBe(false)
      fork = f.host.control.fork!()
      caller.abort()
      await Bun.sleep(20)
      expect(claim).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      expect(handover).toHaveBeenCalledTimes(1)
    } finally {
      claim.mockRestore()
      create.mockRestore()
    }
    finish()
    await first
    await fork
    expect(f.host.agent.sessionId).not.toBe(old.sessionId)
    expect(f.host.agent.sessionId).not.toBe(b.id)
    expect(f.host.agent.messages).toEqual([userMessage("B history")])
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(handover.mock.calls).toEqual([
      [old.sessionId, b.id],
      [b.id, f.host.agent.sessionId],
    ])
    expect(f.announcements).toEqual([b.id, f.host.agent.sessionId])
    expect(fs.existsSync(sessionLockFile(b.file))).toBe(false)
    expect(fs.existsSync(sessionLockFile(f.host.agent.session!.file))).toBe(true)
  } finally {
    finish()
    await first.catch(() => {})
    await fork?.catch(() => {})
    dispose.mockRestore()
    handover.mockRestore()
    await f.host.agent.dispose()
    f.session.host.unloadAll()
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test("cancelling C selected during B's committed handover never disposes or poisons B's tree", async () => {
  const f = await fixture([{ text: "B child ready" }])
  const old = f.host.agent
  const b = f.target("B")
  const c = f.target("C")
  const claims = blockClaims([c])
  let finish!: () => void
  const barrier = new Promise<void>((resolve) => {
    finish = resolve
  })
  const original = old.dispose
  const dispose = spyOn(old, "dispose").mockImplementation(async (reason) => {
    await barrier
    await original.call(old, reason)
  })
  const handover = spyOn(f.session.host.backgroundJobs, "handoverRoot")
  const first = f.host.control.resume(b.id)
  const abort = new AbortController()
  let latest: Promise<void> | undefined
  try {
    await until(() => dispose.mock.calls.length === 1)
    latest = f.host.control.resume(c.id, { signal: abort.signal })
    expect(claims.attempts(c)).toBe(0)
    finish()
    await first
    await until(() => claims.attempts(c) > 0)
    const winner = f.host.agent
    expect(winner.sessionId).toBe(b.id)
    const child = f.session.tree.spawn(winner, { prompt: "stay alive", persistent: true })
    await until(() => child.state === "idle")
    const notice = winner.expectNotice()
    abort.abort()
    await expect(latest).rejects.toThrow(/^cancelled$/)
    claims.release(c)
    await Bun.sleep(25)
    expect(f.host.agent).toBe(winner)
    expect(child.state).toBe("idle")
    expect(f.session.tree.children).toHaveLength(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(handover).toHaveBeenCalledTimes(1)
    expect(f.announcements).toEqual([b.id])
    expect(fs.existsSync(sessionLockFile(b.file))).toBe(true)
    expect(fs.existsSync(sessionLockFile(c.file))).toBe(false)
    winner.session!.appendDisplay({ type: "display", level: "info", text: "B retains authority" })
    notice.deliver(userMessage("B completion"), { wake: false })
    expect(winner.takeNotices()).toEqual([userMessage("B completion")])
    expect(old.takeNotices()).toEqual([])
  } finally {
    finish()
    claims.dispose()
    await first.catch(() => {})
    await latest?.catch(() => {})
    dispose.mockRestore()
    handover.mockRestore()
    await f.host.agent.dispose()
    f.session.host.unloadAll()
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})
