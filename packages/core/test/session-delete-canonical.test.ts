import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { userMessage } from "@amira/ai"
import { deleteSession, findSession, listSessions } from "../src/session-list.ts"
import { SessionStore } from "../src/session-store.ts"

const linkDirectory = (target: string, link: string) =>
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir")

test("private deletion returns captured canonical paths even if the requested parent alias retargets", () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "amira-delete-canonical-")))
  const actual = path.join(root, "actual")
  const outside = path.join(root, "outside")
  const alias = path.join(root, "alias")
  const physical = path.join(actual, "sessions")
  fs.mkdirSync(physical, { recursive: true })
  fs.mkdirSync(path.join(outside, "sessions"), { recursive: true })
  linkDirectory(actual, alias)
  const requested = path.relative(process.cwd(), path.join(alias, "sessions"))
  const store = SessionStore.create({ cwd: root, dir: requested })
  store.appendMessage(userMessage("parent"))
  const child = SessionStore.create({ cwd: root, dir: path.join(requested, "subagents") })
  child.appendMessage(userMessage("child"))
  store.append({ type: "subagent", childSessionId: child.id, role: "explorer" })
  const outsideFile = path.join(outside, "sessions", path.basename(store.file))
  fs.writeFileSync(outsideFile, "outside recording")
  const rename = fs.renameSync
  let retargeted = false
  const retarget = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    const result = rename(from, to)
    if (!retargeted && String(from) === physical && path.basename(String(to)) === "root") {
      retargeted = true
      fs.unlinkSync(alias)
      linkDirectory(outside, alias)
    }
    return result
  })
  try {
    expect(listSessions(root, requested)[0]!.file).toBe(store.file)
    expect(deleteSession(root, store.id, undefined, requested)).toEqual([store.file, child.file])
    expect(retargeted).toBe(true)
    expect(fs.existsSync(store.file)).toBe(false)
    expect(fs.existsSync(child.file)).toBe(false)
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside recording")
  } finally {
    retarget.mockRestore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("canonical lookup must not hide a requested recording link from the deletion containment walk", () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "amira-delete-requested-")))
  const store = SessionStore.create({ cwd: dir, dir })
  store.appendMessage(userMessage("keep recording"))
  const alias = path.join(dir, "alias.jsonl")
  fs.symlinkSync(store.file, alias, "file")
  const bytes = fs.readFileSync(store.file, "utf8")
  try {
    expect(findSession(dir, "alias", dir)).toBe(store.file)
    expect(() => deleteSession(dir, "alias", undefined, dir)).toThrow("unsafe session recording symlink")
    expect(fs.readFileSync(store.file, "utf8")).toBe(bytes)
    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a child recording link stays visible to containment even if relocation makes its target unavailable", () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "amira-delete-child-requested-")))
  const store = SessionStore.create({ cwd: dir, dir })
  store.appendMessage(userMessage("keep parent"))
  const child = SessionStore.create({ cwd: dir, dir: path.join(dir, "subagents") })
  child.appendMessage(userMessage("keep child"))
  store.append({ type: "subagent", childSessionId: "alias", role: "explorer" })
  const alias = path.join(dir, "subagents", "alias.jsonl")
  fs.symlinkSync(child.file, alias, "file")
  const parentBytes = fs.readFileSync(store.file, "utf8")
  const childBytes = fs.readFileSync(child.file, "utf8")
  try {
    expect(() => deleteSession(dir, store.id, undefined, dir)).toThrow("unsafe session symlink")
    expect(fs.readFileSync(store.file, "utf8")).toBe(parentBytes)
    expect(fs.readFileSync(child.file, "utf8")).toBe(childBytes)
    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
