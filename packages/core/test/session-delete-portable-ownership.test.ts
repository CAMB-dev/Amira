import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { userMessage } from "@amira/ai"
import { fileHistoryDir } from "../src/file-rewind.ts"
import { deleteSession } from "../src/session-list.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"

function setup() {
  const parent = fs.realpathSync.native(
    fs.mkdtempSync(path.join(tmpdir(), "amira-portable-delete-ownership-")),
  )
  const dir = path.join(parent, "sessions")
  const store = SessionStore.create({ cwd: parent, dir })
  store.appendMessage(userMessage("parent"))
  return { parent, dir, store }
}

test("a linked recording is refused before acquiring or recovering its outside deletion lease", () => {
  const { parent, dir, store } = setup()
  const outside = SessionStore.create({ cwd: parent, dir: path.join(parent, "outside") })
  outside.appendMessage(userMessage("outside recording"))
  const dead = Bun.spawnSync([process.execPath, "-e", ""], { stdout: "ignore", stderr: "pipe" })
  expect(dead.exitCode).toBe(0)
  const lease = sessionLockFile(outside.file)
  const contents = `${dead.pid}\n`
  fs.writeFileSync(lease, contents)
  fs.utimesSync(lease, new Date(0), new Date(0))
  fs.unlinkSync(store.file)
  fs.symlinkSync(outside.file, store.file, "file")
  try {
    expect(() => deleteSession(parent, store.id, undefined, dir)).toThrow("unsafe")
    expect(fs.existsSync(lease)).toBe(true)
    expect(fs.readFileSync(lease, "utf8")).toBe(contents)
    expect(fs.readFileSync(outside.file, "utf8")).toContain("outside recording")
    expect(fs.lstatSync(store.file).isSymbolicLink()).toBe(true)
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test("an unrelated parent's invalid child reference does not discard its valid shared descendants", () => {
  const { parent, dir, store } = setup()
  const other = SessionStore.create({ cwd: parent, dir })
  other.appendMessage(userMessage("other parent"))
  const child = SessionStore.create({ cwd: parent, dir: path.join(dir, "subagents") })
  child.appendMessage(userMessage("shared child"))
  for (const recording of [store, other])
    recording.append({ type: "subagent", childSessionId: child.id, role: "explorer" })
  other.append({ type: "subagent", childSessionId: "../../outside", role: "explorer" })
  fs.writeFileSync(`${child.file}.trace.jsonl`, "shared trace")
  fs.mkdirSync(fileHistoryDir(child.file), { recursive: true })
  fs.writeFileSync(path.join(fileHistoryDir(child.file), "saved.txt"), "shared image")
  try {
    expect(deleteSession(parent, store.id, undefined, dir)).toEqual([store.file])
    expect(fs.readFileSync(other.file, "utf8")).toContain("other parent")
    expect(fs.readFileSync(child.file, "utf8")).toContain("shared child")
    expect(fs.readFileSync(`${child.file}.trace.jsonl`, "utf8")).toBe("shared trace")
    expect(fs.readFileSync(path.join(fileHistoryDir(child.file), "saved.txt"), "utf8")).toBe("shared image")
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test("rollback never republishes a released deletion lease after deferred cleanup", async () => {
  const { parent, dir, store } = setup()
  const child = SessionStore.create({ cwd: parent, dir: path.join(dir, "subagents") })
  child.appendMessage(userMessage("active child"))
  store.append({ type: "subagent", childSessionId: child.id, role: "explorer" })
  child.claim()
  const remove = fs.rmSync
  let deferred = false
  const race = spyOn(fs, "rmSync").mockImplementation((file, options) => {
    if (!deferred && path.basename(String(file)) === path.basename(sessionLockFile(store.file))) {
      deferred = true
      throw Object.assign(new Error("sharing violation"), { code: "EPERM" })
    }
    return remove(file, options)
  })
  try {
    expect(() => deleteSession(parent, store.id, undefined, dir)).toThrow("open")
    expect(deferred).toBe(true)
    expect(fs.readFileSync(store.file, "utf8")).toContain("parent")
    expect(fs.readFileSync(child.file, "utf8")).toContain("active child")
    expect(fs.existsSync(sessionLockFile(store.file))).toBe(false)
    child.release()
    expect(deleteSession(parent, store.id, undefined, dir)).toEqual([store.file, child.file])
    expect(fs.existsSync(store.file)).toBe(false)
    expect(fs.existsSync(child.file)).toBe(false)
    await Bun.sleep(150)
  } finally {
    race.mockRestore()
    child.release()
    fs.rmSync(parent, { recursive: true, force: true })
  }
})
