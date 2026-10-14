import { afterEach, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { ConversationSpec, OwnedConversation } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { pendingOwnedLockCleanup } from "../src/file-lock.ts"
import { takeFilesystemGate } from "../src/file-lock-gate.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import {
  claimOwned,
  ownedDirectory,
  ownedId,
  type SavedConversation,
} from "../src/owned-conversations-storage.ts"
import { SessionStore, sessionLockFile, sessionLockPid } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture() {
  const home = fs.mkdtempSync(path.join(tmpdir(), "amira-owned-lease-cleanup-"))
  const mock = createMockDialect([{ text: "first reply" }, { text: "reopened reply" }])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const tools = new ToolRegistry()
  const tree = new AgentTree({ ai, sections: () => [] })
  const main = new Agent({ ai, model: ai.model("mock/test"), cwd: home, tools, tree, sections: [] })
  const managers: OwnedConversationManager[] = []
  const manager = () => {
    const value = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
    managers.push(value)
    return value
  }
  cleanups.push(async () => {
    await Promise.all(managers.map((value) => value.drain()))
    await main.dispose()
    fs.rmSync(home, { recursive: true, force: true })
  })
  const owner = "notes"
  const spec: ConversationSpec = {
    key: "cleanup",
    name: "Cleanup",
    cwd: home,
    systemPrompt: "Research.",
    callableTools: [],
  }
  const runtime = { askUser: async () => undefined }
  const file = (id: string) => path.join(ownedDirectory(home, owner), `${id}.jsonl`)
  return { home, mock, manager, owner, spec, runtime, file }
}

async function until(check: () => boolean) {
  const deadline = performance.now() + 3000
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("lease cleanup did not reach its gate")
    await Bun.sleep(2)
  }
}

for (const obstruction of ["EPERM", "EBUSY", "EACCES", "busy gate"]) {
  test(`released owned lease reopens after ${obstruction} exhausts automatic cleanup`, async () => {
    const f = fixture()
    const first = await f.manager().forOwner(f.owner).openOrCreate(f.spec, f.runtime)
    await first.send("before release")
    const history = first.history()
    let reopened: OwnedConversation | undefined
    const file = f.file(first.id)
    const lock = sessionLockFile(file)
    const remove = fs.rmSync
    let blocked = true
    let exhausted = false
    let denied = 0
    const hook = spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (blocked && obstruction !== "busy gate" && String(target) === lock) {
        denied++
        throw Object.assign(new Error("lease sharing violation"), { code: obstruction })
      }
      return remove(target, options)
    })
    const warning = spyOn(process, "emitWarning").mockImplementation((message) => {
      if (String(message).includes(lock) && String(message).includes("owned cleanup remains pending"))
        exhausted = true
    })
    let unlock = obstruction === "busy gate" ? takeFilesystemGate(lock) : undefined
    try {
      if (obstruction === "busy gate") expect(unlock).toBeDefined()
      await first.release()
      await until(() => exhausted)
      expect(pendingOwnedLockCleanup(lock)).toBe(true)
      expect(sessionLockPid(file)).toBe(process.pid)
      if (obstruction !== "busy gate") expect(denied).toBe(11)
      blocked = false
      unlock?.()
      unlock = undefined
      // No automatic retries remain: reopening must run the ownership-authorized cleanup.
      const owner = f.manager().forOwner(f.owner)
      reopened = await owner.open(first.id, f.runtime)
      expect(reopened.id).toBe(first.id)
      expect(reopened.history()).toEqual(history)
      expect(pendingOwnedLockCleanup(lock)).toBe(false)
      await expect(f.manager().forOwner(f.owner).open(first.id, f.runtime)).rejects.toThrow("in use")
      await reopened.send("after cleanup")
      expect(f.mock.requests).toHaveLength(2)
      expect(JSON.stringify(f.mock.requests[1]!.messages)).toContain("before release")
      await reopened.release()
      expect(fs.existsSync(lock)).toBe(false)
    } finally {
      blocked = false
      unlock?.()
      hook.mockRestore()
      warning.mockRestore()
      await first.release()
      await reopened?.release()
      // Finish any retained cleanup even when the regression fails before reopening.
      const available = SessionStore.open(file)
      available.claim()
      available.release()
    }
  })
}

test("pending owned acquisition reserves its writer across managers until cleanup becomes available", async () => {
  const f = fixture()
  const first = await f.manager().forOwner(f.owner).openOrCreate(f.spec, f.runtime)
  const file = f.file(first.id)
  const lock = sessionLockFile(file)
  const remove = fs.rmSync
  let blocked = true
  let exhausted = false
  let denied = 0
  const hook = spyOn(fs, "rmSync").mockImplementation((target, options) => {
    if (blocked && String(target) === lock) {
      denied++
      throw Object.assign(new Error("lease reader"), { code: "EBUSY" })
    }
    return remove(target, options)
  })
  const warning = spyOn(process, "emitWarning").mockImplementation((message) => {
    if (String(message).includes(lock) && String(message).includes("owned cleanup remains pending"))
      exhausted = true
  })
  let pending: Promise<OwnedConversation> | undefined
  let reopened: OwnedConversation | undefined
  try {
    await first.release()
    await until(() => exhausted)
    const automaticAttempts = denied
    const owner = f.manager().forOwner(f.owner)
    pending = owner.open(first.id, f.runtime)
    // Attach a handler immediately, including on the pre-fix rejection path.
    const outcome = pending.then(
      (handle) => ({ handle }),
      (error: unknown) => ({ error }),
    )
    await until(() => denied > automaticAttempts)
    await expect(owner.open(first.id, f.runtime)).rejects.toThrow("in use")
    await expect(f.manager().forOwner(f.owner).open(first.id, f.runtime)).rejects.toThrow("in use")
    expect(f.mock.requests).toHaveLength(0)
    blocked = false
    const result = await outcome
    if ("error" in result) throw result.error
    await expect(f.manager().forOwner(f.owner).open(first.id, f.runtime)).rejects.toThrow("in use")
    await result.handle.release()
    expect(fs.existsSync(lock)).toBe(false)
    reopened = await f.manager().forOwner(f.owner).open(first.id, f.runtime)
    // A repeated release of the old handle must not remove the new writer reservation.
    await result.handle.release()
    await expect(f.manager().forOwner(f.owner).open(first.id, f.runtime)).rejects.toThrow("in use")
    await reopened.release()
    expect(fs.existsSync(lock)).toBe(false)
  } finally {
    blocked = false
    hook.mockRestore()
    warning.mockRestore()
    const acquired = await pending?.catch(() => undefined)
    await acquired?.release()
    await reopened?.release()
    const available = SessionStore.open(file)
    available.claim()
    available.release()
  }
})

test("owned lease release drops its retained ref exactly once across a later writer", async () => {
  const f = fixture()
  const saved: SavedConversation = {
    v: 1,
    owner: f.owner,
    id: ownedId(f.owner, f.spec.key),
    spec: { ...f.spec, model: "mock/test" },
    runtimeTools: [],
  }
  const first = await claimOwned(f.home, saved, true)
  first.store.appendDisplay({ type: "display", text: "materialized", level: "info" })
  const release = spyOn(first.store, "release")
  let second: Awaited<ReturnType<typeof claimOwned>> | undefined
  try {
    first.release()
    expect(release).toHaveBeenCalledTimes(1)
    second = await claimOwned(f.home, saved, false)
    first.release()
    expect(release).toHaveBeenCalledTimes(1)
    await expect(claimOwned(f.home, saved, false)).rejects.toThrow("in use")
    expect(fs.existsSync(sessionLockFile(second.store.file))).toBe(true)
    second.release()
    expect(fs.existsSync(sessionLockFile(second.store.file))).toBe(false)
  } finally {
    first.release()
    second?.release()
    release.mockRestore()
  }
})

test("fresh manager open cannot take over an already claimed owned SessionStore", async () => {
  const f = fixture()
  const first = await f.manager().forOwner(f.owner).openOrCreate(f.spec, f.runtime)
  await first.release()
  const file = f.file(first.id)
  const store = SessionStore.open(file)
  store.claim()
  try {
    await expect(f.manager().forOwner(f.owner).open(first.id, f.runtime)).rejects.toThrow("in use")
    expect(sessionLockPid(file)).toBe(process.pid)
    store.appendDisplay({ type: "display", text: "existing writer remains usable", level: "info" })
    expect(SessionStore.open(file).entries).toEqual(store.entries)
    expect(f.mock.requests).toHaveLength(0)
  } finally {
    store.release()
  }
  const reopened = await f.manager().forOwner(f.owner).open(first.id, f.runtime)
  await reopened.release()
  expect(fs.existsSync(sessionLockFile(file))).toBe(false)
})
