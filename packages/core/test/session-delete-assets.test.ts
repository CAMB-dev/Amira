import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { userMessage } from "@amira/ai"
import { artifactDir } from "../src/artifacts.ts"
import { fileHistoryDir } from "../src/file-rewind.ts"
import { deleteSession } from "../src/session-list.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"

const tmp = () => realpathSync.native(mkdtempSync(path.join(tmpdir(), "amira-delete-assets-")))
const linkDirectory = (target: string, link: string) =>
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir")

function saveAssets(store: SessionStore) {
  for (const dir of [fileHistoryDir(store.file), artifactDir(store.file, store.id)]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "saved.txt"), "saved bytes")
  }
}

test("delete removes only the session's recording, trace, file images and outputs", () => {
  const dir = tmp()
  try {
    const store = SessionStore.create({ cwd: dir, dir })
    store.appendMessage(userMessage("delete me"))
    const other = SessionStore.create({ cwd: dir, dir })
    other.appendMessage(userMessage("keep me"))
    for (const session of [store, other]) {
      saveAssets(session)
      writeFileSync(`${session.file}.trace.jsonl`, "trace")
    }

    expect(deleteSession(dir, store.id, undefined, dir)).toEqual([store.file])
    expect(existsSync(store.file)).toBe(false)
    expect(existsSync(`${store.file}.trace.jsonl`)).toBe(false)
    expect(existsSync(path.dirname(fileHistoryDir(store.file)))).toBe(false)
    expect(existsSync(other.file)).toBe(true)
    expect(readFileSync(`${other.file}.trace.jsonl`, "utf8")).toBe("trace")
    for (const assets of [fileHistoryDir(other.file), artifactDir(other.file, other.id)]) {
      expect(readFileSync(path.join(assets, "saved.txt"), "utf8")).toBe("saved bytes")
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("delete fails closed when the session directory becomes a junction at the deletion operation", () => {
  const parent = tmp()
  const dir = path.join(parent, "sessions")
  const original = path.join(parent, "original")
  const outside = tmp()
  const store = SessionStore.create({ cwd: dir, dir })
  store.appendMessage(userMessage("original recording"))
  saveAssets(store)
  writeFileSync(`${store.file}.trace.jsonl`, "original trace")
  const outsideFile = path.join(outside, path.basename(store.file))
  writeFileSync(outsideFile, "outside recording")
  writeFileSync(`${outsideFile}.trace.jsonl`, "outside trace")
  const outsideAssets = path.dirname(fileHistoryDir(outsideFile))
  mkdirSync(path.join(outsideAssets, "files"), { recursive: true })
  writeFileSync(path.join(outsideAssets, "files", "saved.txt"), "outside bytes")
  mkdirSync(artifactDir(outsideFile, store.id), { recursive: true })
  writeFileSync(path.join(artifactDir(outsideFile, store.id), "saved.txt"), "outside output")
  writeFileSync(sessionLockFile(outsideFile), "outside lease")
  const remove = fs.rmSync
  const rename = fs.renameSync
  let swapped = false
  const swap = () => {
    if (swapped) return
    swapped = true
    rename(dir, original)
    linkDirectory(outside, dir)
  }
  const removal = spyOn(fs, "rmSync").mockImplementation((name, options) => {
    if (String(name) === path.dirname(fileHistoryDir(store.file))) swap()
    return remove(name, options)
  })
  const relocation = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(from) === dir) swap()
    return rename(from, to)
  })
  try {
    let failure: unknown
    try {
      deleteSession(dir, store.id, undefined, dir)
    } catch (error) {
      failure = error
    }
    expect(swapped).toBe(true)
    expect(readFileSync(outsideFile, "utf8")).toBe("outside recording")
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("unsafe")
    expect(readFileSync(`${outsideFile}.trace.jsonl`, "utf8")).toBe("outside trace")
    expect(readFileSync(path.join(outsideAssets, "files", "saved.txt"), "utf8")).toBe("outside bytes")
    expect(readFileSync(path.join(artifactDir(outsideFile, store.id), "saved.txt"), "utf8")).toBe(
      "outside output",
    )
    expect(readFileSync(sessionLockFile(outsideFile), "utf8")).toBe("outside lease")
    const originalFile = path.join(original, path.basename(store.file))
    expect(readFileSync(originalFile, "utf8")).toContain("original recording")
    expect(readFileSync(`${originalFile}.trace.jsonl`, "utf8")).toBe("original trace")
    expect(
      readFileSync(path.join(path.dirname(fileHistoryDir(originalFile)), "files", "saved.txt"), "utf8"),
    ).toBe("saved bytes")
  } finally {
    removal.mockRestore()
    relocation.mockRestore()
    rmSync(parent, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

for (const operation of ["unlinkSync", "rmdirSync"] as const) {
  test(`delete keeps ${operation} private when the restored public root is replaced`, () => {
    const parent = tmp()
    const dir = path.join(parent, "sessions")
    const backup = path.join(parent, "original")
    const outside = tmp()
    const store = SessionStore.create({ cwd: parent, dir })
    store.appendMessage(userMessage("delete me"))
    saveAssets(store)
    writeFileSync(`${store.file}.trace.jsonl`, "original trace")
    const other = SessionStore.create({ cwd: parent, dir })
    other.appendMessage(userMessage("unrelated recording"))
    saveAssets(other)
    other.claim()
    const otherLock = lstatSync(sessionLockFile(other.file), { bigint: true })
    const outsideFile = path.join(outside, path.basename(store.file))
    const sentinel = new Map([
      [outsideFile, "outside recording"],
      [`${outsideFile}.trace.jsonl`, "outside trace"],
      [sessionLockFile(outsideFile), "outside lease"],
      [path.join(fileHistoryDir(outsideFile), "saved.txt"), "outside file image"],
      [path.join(artifactDir(outsideFile, store.id), "saved.txt"), "outside output"],
    ])
    for (const [name, bytes] of sentinel) {
      mkdirSync(path.dirname(name), { recursive: true })
      writeFileSync(name, bytes)
    }
    const rename = fs.renameSync
    const remove = operation === "unlinkSync" ? fs.unlinkSync : fs.rmdirSync
    let root = ""
    let swapped = false
    let restored = false
    const relocation = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === dir) root = String(to)
      rename(from, to)
      if (String(from) === root && String(to) === dir) restored = true
    })
    const removal = spyOn(fs, operation).mockImplementation((file) => {
      const name = String(file)
      if (path.basename(name).startsWith("entry-")) {
        expect(root).not.toBe("")
        expect(path.dirname(name)).toBe(path.dirname(root))
        expect(restored).toBe(true)
        if (!swapped) {
          swapped = true
          rename(dir, backup)
          linkDirectory(outside, dir)
        }
      }
      return remove(file)
    })
    try {
      expect(deleteSession(parent, store.id, undefined, dir)).toEqual([store.file])
      expect(swapped).toBe(true)
      for (const [name, bytes] of sentinel) expect(readFileSync(name, "utf8")).toBe(bytes)
      const retained = path.join(backup, path.basename(other.file))
      expect(readFileSync(retained, "utf8")).toContain("unrelated recording")
      expect(readFileSync(path.join(fileHistoryDir(retained), "saved.txt"), "utf8")).toBe("saved bytes")
      expect(lstatSync(sessionLockFile(retained), { bigint: true }).ino).toBe(otherLock.ino)
      fs.unlinkSync(dir)
      rename(backup, dir)
      other.appendMessage(userMessage("writer still works"))
      expect(readFileSync(other.file, "utf8")).toContain("writer still works")
    } finally {
      removal.mockRestore()
      relocation.mockRestore()
      if (swapped && existsSync(backup)) {
        fs.unlinkSync(dir)
        rename(backup, dir)
      }
      other.release()
      rmSync(parent, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
}

for (const component of ["assets", "files", "outputs"]) {
  test(`delete refuses a linked ${component} directory without touching its outside target`, () => {
    const dir = tmp()
    const outside = tmp()
    try {
      const store = SessionStore.create({ cwd: dir, dir })
      store.appendMessage(userMessage("delete me"))
      const assets = path.dirname(fileHistoryDir(store.file))
      const link = component === "assets" ? assets : path.join(assets, component)
      mkdirSync(path.dirname(link), { recursive: true })
      writeFileSync(path.join(outside, "keep.txt"), "outside bytes")
      writeFileSync(`${store.file}.trace.jsonl`, "trace")
      linkDirectory(outside, link)

      expect(() => deleteSession(dir, store.id, undefined, dir)).toThrow("symlink")
      expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("outside bytes")
      expect(existsSync(store.file)).toBe(true)
      expect(readFileSync(`${store.file}.trace.jsonl`, "utf8")).toBe("trace")
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
}

for (const component of ["files", "outputs"]) {
  test(`delete never follows nested ${component} links outside the session's assets`, () => {
    const dir = tmp()
    const outside = tmp()
    try {
      const store = SessionStore.create({ cwd: dir, dir })
      store.appendMessage(userMessage("delete me"))
      saveAssets(store)
      writeFileSync(path.join(outside, "keep.txt"), "outside bytes")
      const assets = path.dirname(fileHistoryDir(store.file))
      linkDirectory(outside, path.join(assets, component, "linked"))

      expect(deleteSession(dir, store.id, undefined, dir)).toEqual([store.file])
      expect(existsSync(assets)).toBe(false)
      expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("outside bytes")
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
}

test("delete preserves shared children and an unrelated active writer's lock identity", () => {
  const dir = tmp()
  const other = SessionStore.create({ cwd: dir, dir })
  try {
    const store = SessionStore.create({ cwd: dir, dir })
    const child = SessionStore.create({ cwd: dir, dir: path.join(dir, "subagents") })
    child.appendMessage(userMessage("shared child"))
    for (const parent of [store, other]) {
      parent.appendMessage(userMessage("parent"))
      parent.append({ type: "subagent", childSessionId: child.id, role: "explorer" })
    }
    for (const session of [store, other, child]) {
      saveAssets(session)
      writeFileSync(`${session.file}.trace.jsonl`, "trace")
    }
    other.claim()
    const lock = lstatSync(sessionLockFile(other.file), { bigint: true })
    expect(deleteSession(dir, store.id, undefined, dir)).toEqual([store.file])
    expect(lstatSync(sessionLockFile(other.file), { bigint: true }).ino).toBe(lock.ino)
    other.appendMessage(userMessage("writer still works"))
    expect(readFileSync(other.file, "utf8")).toContain("writer still works")
    expect(readFileSync(`${child.file}.trace.jsonl`, "utf8")).toBe("trace")
    expect(readFileSync(path.join(fileHistoryDir(child.file), "saved.txt"), "utf8")).toBe("saved bytes")
    other.release()
    expect(deleteSession(dir, other.id, undefined, dir)).toEqual([other.file, child.file])
    expect(existsSync(child.file)).toBe(false)
    expect(existsSync(path.dirname(fileHistoryDir(child.file)))).toBe(false)
  } finally {
    other.release()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("delete refuses an owned child with an active lease without changing either session", () => {
  const dir = tmp()
  const child = SessionStore.create({ cwd: dir, dir: path.join(dir, "subagents") })
  try {
    const store = SessionStore.create({ cwd: dir, dir })
    store.appendMessage(userMessage("parent"))
    child.appendMessage(userMessage("owned child"))
    store.append({ type: "subagent", childSessionId: child.id, role: "explorer" })
    saveAssets(store)
    saveAssets(child)
    child.claim()
    const lock = lstatSync(sessionLockFile(child.file), { bigint: true })
    expect(() => deleteSession(dir, store.id, undefined, dir)).toThrow("open")
    expect(existsSync(store.file)).toBe(true)
    expect(existsSync(child.file)).toBe(true)
    expect(lstatSync(sessionLockFile(child.file), { bigint: true }).ino).toBe(lock.ino)
    child.appendMessage(userMessage("child still works"))
    expect(readFileSync(child.file, "utf8")).toContain("child still works")
    expect(readFileSync(path.join(fileHistoryDir(store.file), "saved.txt"), "utf8")).toBe("saved bytes")
  } finally {
    child.release()
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const component of ["root", "assets", "files", "nested", "subagents"]) {
  for (const timing of ["before", "during", "during-directory"]) {
    const replacementKind = timing === "during-directory" ? "directory replacement" : "junction"
    test(`delete rejects a ${component} ${replacementKind} swapped ${timing.replace("-directory", "")} its staging rename`, () => {
      const parent = tmp()
      const dir = path.join(parent, "sessions")
      const original = path.join(parent, "original")
      const outside = tmp()
      const store = SessionStore.create({ cwd: dir, dir })
      store.appendMessage(userMessage("original recording"))
      saveAssets(store)
      writeFileSync(`${store.file}.trace.jsonl`, "original trace")
      const child = SessionStore.create({ cwd: dir, dir: path.join(dir, "subagents") })
      child.appendMessage(userMessage("owned child"))
      store.append({ type: "subagent", childSessionId: child.id, role: "explorer" })
      const other = SessionStore.create({ cwd: dir, dir })
      other.appendMessage(userMessage("unrelated recording"))
      const nested = path.join(fileHistoryDir(store.file), "nested")
      mkdirSync(nested)
      writeFileSync(path.join(nested, "saved.txt"), "nested bytes")
      for (const name of [path.basename(store.file), path.basename(child.file), "saved.txt"]) {
        writeFileSync(path.join(outside, name), "outside bytes")
      }
      const outsideFile = path.join(outside, path.basename(store.file))
      const sentinels = new Map([
        [`${outsideFile}.trace.jsonl`, "outside trace"],
        [sessionLockFile(outsideFile), "outside lease"],
        [path.join(fileHistoryDir(outsideFile), "saved.txt"), "outside file image"],
        [path.join(artifactDir(outsideFile, store.id), "saved.txt"), "outside output"],
      ])
      for (const [name, bytes] of sentinels) {
        mkdirSync(path.dirname(name), { recursive: true })
        writeFileSync(name, bytes)
      }
      const rename = fs.renameSync
      const read = fs.readFileSync
      const mkdir = fs.mkdirSync
      const readdir = fs.readdirSync
      let swapped = false
      let replacement = ""
      let recordingReads = 0
      let acquisitions = 0
      let traversedReplacement = false
      const reads = spyOn(fs, "readFileSync").mockImplementation(
        (file: fs.PathOrFileDescriptor, options?: unknown) => {
          if (
            [store.file, child.file, other.file].some(
              (recording) => path.basename(String(file)) === path.basename(recording),
            )
          )
            recordingReads++
          return Reflect.apply(read, fs, options === undefined ? [file] : [file, options])
        },
      )
      const leases = spyOn(fs, "mkdirSync").mockImplementation((file, options) => {
        if (["root", "subagents"].includes(path.basename(String(file))) || String(file) === dir)
          acquisitions++
        return mkdir(file, options)
      })
      const traversal = spyOn(fs, "readdirSync").mockImplementation((file, options?: unknown) => {
        if (replacement && String(file) === replacement) traversedReplacement = true
        return Reflect.apply(readdir, fs, options === undefined ? [file] : [file, options])
      })
      const relocation = spyOn(fs, "renameSync").mockImplementation((from, to) => {
        const source = String(from)
        const matches =
          component === "root"
            ? source === dir
            : component === "assets"
              ? path.basename(source) === path.basename(path.dirname(fileHistoryDir(store.file)))
              : path.basename(source) === component
        if (!swapped && matches) {
          swapped = true
          if (timing !== "before") {
            rename(from, to)
            rename(to, original)
            replacement = String(to)
            if (timing === "during-directory") fs.cpSync(outside, String(to), { recursive: true })
            else linkDirectory(outside, String(to))
            return
          }
          rename(from, original)
          replacement = String(to)
          linkDirectory(outside, source)
        }
        return rename(from, to)
      })
      try {
        expect(() => deleteSession(dir, store.id, undefined, dir)).toThrow("unsafe")
        expect(swapped).toBe(true)
        expect(traversedReplacement).toBe(false)
        if (component === "root") {
          expect(recordingReads).toBe(0)
          expect(acquisitions).toBe(0)
        }
        for (const [name, bytes] of sentinels) expect(readFileSync(name, "utf8")).toBe(bytes)
        for (const name of [path.basename(store.file), path.basename(child.file), "saved.txt"]) {
          expect(readFileSync(path.join(outside, name), "utf8")).toBe("outside bytes")
        }
        const sessionRoot = component === "root" ? original : dir
        expect(readFileSync(path.join(sessionRoot, path.basename(store.file)), "utf8")).toContain(
          "original recording",
        )
        expect(readFileSync(path.join(sessionRoot, path.basename(other.file)), "utf8")).toContain(
          "unrelated recording",
        )
        expect(readFileSync(path.join(sessionRoot, `${path.basename(store.file)}.trace.jsonl`), "utf8")).toBe(
          "original trace",
        )
        const saved =
          component === "assets"
            ? path.join(original, "files", "saved.txt")
            : path.join(original, "saved.txt")
        if (["assets", "files", "nested"].includes(component)) {
          expect(readFileSync(saved, "utf8")).toBe(component === "nested" ? "nested bytes" : "saved bytes")
        }
        if (component === "subagents")
          expect(existsSync(path.join(original, path.basename(child.file)))).toBe(true)
      } finally {
        reads.mockRestore()
        leases.mockRestore()
        traversal.mockRestore()
        relocation.mockRestore()
        rmSync(parent, { recursive: true, force: true })
        rmSync(outside, { recursive: true, force: true })
      }
    })
  }
}

test("delete refuses a linked ancestor that redirects the session directory outside its path", () => {
  const dir = tmp()
  const outside = tmp()
  try {
    const sessions = path.join(outside, "sessions")
    const store = SessionStore.create({ cwd: dir, dir: sessions })
    store.appendMessage(userMessage("outside session"))
    saveAssets(store)
    writeFileSync(`${store.file}.trace.jsonl`, "outside trace")
    const link = path.join(dir, "linked")
    linkDirectory(outside, link)

    expect(() => deleteSession(dir, store.id, undefined, path.join(link, "sessions"))).toThrow("unsafe")
    expect(existsSync(store.file)).toBe(true)
    expect(readFileSync(`${store.file}.trace.jsonl`, "utf8")).toBe("outside trace")
    for (const assets of [fileHistoryDir(store.file), artifactDir(store.file, store.id)]) {
      expect(readFileSync(path.join(assets, "saved.txt"), "utf8")).toBe("saved bytes")
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
