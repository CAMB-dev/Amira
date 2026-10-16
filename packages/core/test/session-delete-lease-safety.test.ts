import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { userMessage } from "@amira/ai"
import { SPAWN_TEST_TIMEOUT_MS, stopSpawn, waitForSpawnExit } from "../../../scripts/spawn-test.ts"
import { artifactDir } from "../src/artifacts.ts"
import { pendingFileLockCleanup } from "../src/file-lock.ts"
import { fileHistoryDir } from "../src/file-rewind.ts"
import { deleteSession } from "../src/session-list.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"

const linkDirectory = (target: string, link: string) =>
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir")

function setup(child = false) {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "amira-delete-lease-safety-")))
  const dir = path.join(parent, "sessions")
  const outside = path.join(parent, "outside")
  const backup = path.join(parent, "backup")
  fs.mkdirSync(outside)
  const store = SessionStore.create({ cwd: parent, dir })
  store.appendMessage(userMessage("parent"))
  const descendant = child
    ? SessionStore.create({ cwd: parent, dir: path.join(dir, "subagents") })
    : undefined
  if (descendant) {
    descendant.appendMessage(userMessage("child"))
    store.append({ type: "subagent", childSessionId: descendant.id, role: "explorer" })
  }
  return { parent, dir, outside, backup, store, descendant }
}

function outsideData(
  outside: string,
  store: SessionStore,
  lease = "outside lease",
  root = path.dirname(store.file),
) {
  const file = path.join(outside, path.relative(root, store.file))
  const entries = new Map([
    [file, "outside recording"],
    [`${file}.trace.jsonl`, "outside trace"],
    [sessionLockFile(file), lease],
    [path.join(fileHistoryDir(file), "saved.txt"), "outside file image"],
    [path.join(artifactDir(file, store.id), "saved.txt"), "outside output"],
  ])
  for (const [name, bytes] of entries) {
    fs.mkdirSync(path.dirname(name), { recursive: true })
    fs.writeFileSync(name, bytes)
  }
  return () => {
    for (const [name, bytes] of entries) expect(fs.readFileSync(name, "utf8")).toBe(bytes)
  }
}

test(
  "descendant stale deletion-lease recovery stays private when the public root is replaced",
  async () => {
    const { parent, dir, outside, store, descendant } = setup(true)
    if (!descendant) throw new Error("missing child")
    const dead = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" })
    try {
      expect(await waitForSpawnExit(dead, "dead deletion-lease owner")).toBe(0)
    } finally {
      await stopSpawn(dead, "dead deletion-lease owner cleanup")
    }
    const contents = `${dead.pid}\n`
    const assertOutside = outsideData(outside, descendant, contents, dir)
    const outsideLock = sessionLockFile(path.join(outside, path.relative(dir, descendant.file)))
    fs.utimesSync(outsideLock, new Date(0), new Date(0))
    fs.writeFileSync(sessionLockFile(descendant.file), contents)
    fs.utimesSync(sessionLockFile(descendant.file), new Date(0), new Date(0))
    const mkdir = fs.mkdirSync
    const rename = fs.renameSync
    let root = ""
    let attempted = false
    const relocation = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === dir) root = String(to)
      // Keep the replacement throughout acquisition/recovery, then remove it before restoration.
      if (
        attempted &&
        String(from).startsWith(`${root}${path.sep}`) &&
        fs.existsSync(dir) &&
        fs.lstatSync(dir).isSymbolicLink()
      )
        fs.unlinkSync(dir)
      return rename(from, to)
    })
    const race = spyOn(fs, "mkdirSync").mockImplementation((file, options) => {
      if (!attempted && path.basename(String(file)) === "subagents") {
        attempted = true
        expect(root).not.toBe("")
        expect(String(file)).toBe(path.join(root, "subagents"))
        expect(fs.existsSync(dir)).toBe(false)
        linkDirectory(outside, dir)
      }
      return mkdir(file, options)
    })
    try {
      expect(deleteSession(parent, store.id, undefined, dir)).toEqual([store.file, descendant.file])
      expect(attempted).toBe(true)
      assertOutside()
      expect(fs.existsSync(store.file)).toBe(false)
      expect(fs.existsSync(descendant.file)).toBe(false)
      expect(fs.existsSync(sessionLockFile(descendant.file))).toBe(false)
    } finally {
      race.mockRestore()
      relocation.mockRestore()
      fs.rmSync(parent, { recursive: true, force: true })
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test("descendant rollback destinations stay private when the public root is replaced through failure", () => {
  const { parent, dir, outside, store, descendant } = setup(true)
  if (!descendant) throw new Error("missing child")
  const assertOutside = outsideData(outside, descendant, "outside lease", dir)
  const rename = fs.renameSync
  const lstat = fs.lstatSync
  let root = ""
  let restored = false
  let failed = false
  let attempted = false
  const race = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    const source = String(from)
    const destination = String(to)
    if (source === dir) root = destination
    if (source.includes("container-") && path.basename(destination) === "subagents") restored = true
    if (
      failed &&
      !attempted &&
      source.includes("entry-") &&
      path.basename(destination) === path.basename(descendant.file)
    ) {
      attempted = true
      expect(destination.startsWith(`${root}${path.sep}`)).toBe(true)
      expect(fs.existsSync(dir)).toBe(false)
      linkDirectory(outside, dir)
      try {
        return rename(from, to)
      } finally {
        assertOutside()
        fs.unlinkSync(dir)
      }
    }
    return rename(from, to)
  })
  const failure = spyOn(fs, "lstatSync").mockImplementation((file, options?: unknown) => {
    if (restored && !failed && String(file) === root) {
      failed = true
      throw new Error("injected rollback")
    }
    return Reflect.apply(lstat, fs, options === undefined ? [file] : [file, options])
  })
  try {
    expect(() => deleteSession(parent, store.id, undefined, dir)).toThrow()
    expect(failed).toBe(true)
    expect(attempted).toBe(true)
    assertOutside()
    expect(fs.readFileSync(store.file, "utf8")).toContain("parent")
    expect(fs.readFileSync(descendant.file, "utf8")).toContain("child")
  } finally {
    race.mockRestore()
    failure.mockRestore()
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test("deferred lease cleanup uses vanished private-root names after the public root is replaced", async () => {
  const { parent, dir, outside, backup, store } = setup()
  const assertOutside = outsideData(outside, store)
  const remove = fs.rmSync
  const rename = fs.renameSync
  const stat = fs.statSync
  const lockName = path.basename(sessionLockFile(store.file))
  let root = ""
  let deferred = false
  let attempted = false
  let returned = false
  let finish!: () => void
  const retried = new Promise<void>((resolve) => {
    finish = resolve
  })
  const relocation = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(from) === dir) root = String(to)
    return rename(from, to)
  })
  const race = spyOn(fs, "rmSync").mockImplementation((file, options) => {
    if (path.basename(String(file)) === lockName) {
      expect(root).not.toBe("")
      expect(String(file)).toBe(path.join(root, lockName))
      if (!deferred) {
        deferred = true
        throw Object.assign(new Error("sharing violation"), { code: "EPERM" })
      }
    }
    return remove(file, options)
  })
  const retry = spyOn(fs, "statSync").mockImplementation((file, options?: unknown) => {
    if (returned && String(file) === root) {
      attempted = true
      expect(fs.existsSync(root)).toBe(false)
      expect(fs.lstatSync(dir).isSymbolicLink()).toBe(true)
      try {
        return Reflect.apply(stat, fs, options === undefined ? [file] : [file, options])
      } finally {
        finish()
      }
    }
    return Reflect.apply(stat, fs, options === undefined ? [file] : [file, options])
  })
  try {
    expect(deleteSession(parent, store.id, undefined, dir)).toEqual([store.file])
    returned = true
    expect(deferred).toBe(true)
    expect(pendingFileLockCleanup(path.join(root, lockName))).toBe(true)
    rename(dir, backup)
    linkDirectory(outside, dir)
    await Promise.race([
      retried,
      Bun.sleep(3000).then(() => {
        throw new Error("cleanup did not retry")
      }),
    ])
    expect(attempted).toBe(true)
    expect(pendingFileLockCleanup(path.join(root, lockName))).toBe(false)
    assertOutside()
    expect(fs.existsSync(path.join(backup, path.basename(store.file)))).toBe(false)
    expect(fs.existsSync(path.join(backup, lockName))).toBe(false)
    // No native pin is needed: the public directory can still be renamed after cleanup.
    fs.unlinkSync(dir)
    rename(backup, dir)
    rename(dir, backup)
    rename(backup, dir)
  } finally {
    retry.mockRestore()
    race.mockRestore()
    relocation.mockRestore()
    fs.rmSync(parent, { recursive: true, force: true })
  }
})
